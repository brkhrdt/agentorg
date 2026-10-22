import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RendererRegistry, renderTool, toolExamples, type EventRenderer } from "../src/rendering.ts";
import { OrganizationServer } from "../src/server.ts";
import type { AgentRecord, ServerEvent } from "../src/types.ts";
import { OrganizationClient } from "../src/client.ts";

const event = (type = "tool.result", data: unknown = { title: "read", status: "completed" }): ServerEvent => ({ kind: "event", seq: 1, time: "now", type, data, agentId: "agent" });
const renderer = (id: string, extra: Partial<EventRenderer> = {}): EventRenderer => ({
  id, name: id, eventTypes: ["tool.call", "tool.update", "tool.result"], examples: toolExamples("read"),
  render: () => ({ summary: `${id}\nshould be capped`, extended: "first\nsecond\nthird", full: `**${id}**\nall content` }), ...extra,
});

test("renderer precedence, exact tool identity, any harness event and generic non-tool preservation", () => {
  const registry = new RendererRegistry();
  registry.register(renderer("server.default"));
  registry.registerHarness("pi", [renderer("all"), renderer("read", { tool: "read" }), renderer("plan", { eventTypes: ["agent.plan"], examples: [{ type: "agent.plan", data: {} }] })]);
  expect(registry.render(event(), "pi", "server.default")?.rendererId).toBe("pi/read");
  expect(registry.render(event("tool.call", { title: "grep", kind: "read" }), "pi", "server.default")?.rendererId).toBe("server.default");
  expect(registry.render(event(), "other", "server.default")?.rendererId).toBe("server.default");
  expect(registry.render(event(), "other", "absent")?.rendererId).toBe("generic");
  expect(registry.render(event("agent.plan"), "pi", "server.default")?.rendererId).toBe("pi/plan");
  expect(registry.render(event("agent.message"), "other", "server.default")).toBeUndefined();
  const levels = registry.render(event(), "pi", "server.default")!;
  expect(levels.summary.split("\n")).toHaveLength(1);
  expect(levels.summary).toEndWith("…");
  expect(levels.extended.split("\n")).toHaveLength(2);
  expect(levels.full).toContain("all content");
});

test("tool selection uses emitted harness identity, explicit aliases, canonical renderers, then selected default and generic", () => {
  const registry = new RendererRegistry();
  registry.registerHarness("pi", [renderer("exact", { tool: "mcp__agentorg__get_operation", render: () => ({ summary: "exact", extended: "exact", full: "exact" }) })], { "mcp__agentorg__get_operation": "get_operation" });
  const emitted = event("tool.result", { title: "mcp__agentorg__get_operation", rawInput: { operationId: "original" } });
  const exact = registry.render(emitted, "pi", "core.tools")!;
  expect(exact.rendererId).toBe("pi/exact"); expect(exact.subtype).toBe("mcp__agentorg__get_operation");
  registry.registerToolRenderer(renderer("plugin.operation", { tool: "plugin_custom", render: () => ({ summary: "plugin operation", extended: "plugin operation", full: "plugin operation" }) }));
  const pluginTool = registry.render(event("tool.result", { title: "plugin_custom", rawInput: { key: "x" } }), "other", "core.tools")!;
  expect(pluginTool.rendererId).toBe("plugin.operation");
  const canonical = registry.render(event("tool.result", { title: "get_operation", rawInput: { operationId: "x" } }), "other", "core.tools")!;
  const builtin = registry.render(event("tool.result", { title: "wait_operation", rawInput: { operationId: "x" } }), "other", "core.tools")!;
  expect(builtin.rendererId).toBe("core.mcp-wait-operation");
  const replaceSession = registry.render(event("tool.result", { title: "replace_subagent_session", rawInput: { agentId: "worker" } }), "other", "core.tools")!;
  expect(replaceSession.rendererId).toBe("core.mcp-replace-subagent-session");
  expect(replaceSession.summary).toBe("Replace session · agent worker");
  expect(canonical.canonicalTool).toBe("get_operation");
  const alias = registry.render(event("tool.result", { title: "mcp__agentorg__get_operation", rawInput: { operationId: "x" } }), "other", "core.tools")!;
  expect(alias.rendererId).toBe("core.tools"); // Aliases are harness-scoped; no suffix guessing.
  const fallback = registry.render(event("tool.result", { title: "not_registered" }), "other", "missing")!;
  expect(fallback.rendererId).toBe("generic");
});

test("throwing, invalid and mutating callbacks are isolated and fall through all tiers", () => {
  const registry = new RendererRegistry();
  registry.register(renderer("broken", { render: () => { throw new Error("broken"); } }));
  registry.registerHarness("pi", [renderer("bad", { render(e) { (e.data as any).title = "MUTATED"; return null as any; } })]);
  const original = event();
  expect(registry.render(original, "pi", "broken")?.rendererId).toBe("generic");
  expect((original.data as any).title).toBe("read");
  expect(registry.render(event("tool.result", { toolName: "read", title: "Display only" }), undefined, "core.tools")?.subtype).toBe("read");
  expect(() => registry.register(renderer("broken"))).toThrow("Duplicate");
  expect(() => registry.register(renderer("invalid id"))).toThrow();
  expect(() => registry.registerHarness("bad", [renderer("same"), renderer("same")])).toThrow("Duplicate");
});

test("accidental async renderers are rejected safely and source text stays literal Markdown", async () => {
  const registry = new RendererRegistry();
  registry.registerHarness("async", [renderer("bad", { render: (async () => { throw new Error("async failure"); }) as any })]);
  expect(registry.render(event(), "async", "core.tools")?.rendererId).toBe("core.tools");
  expect(registry.catalog().find(r => r.id === "async/bad")!.examples).toEqual([]);
  await Bun.sleep(0); // A rejected async callback must not become an unhandled rejection.
  const output = renderTool(event("tool.call", { title: "read", rawInput: { path: "a*[file]`name`.ts" } }));
  expect(output.summary).toContain("a\\*\\[file\\]");
  expect(output.full).toContain('a\\*\\[file\\]\\`name\\`.ts');
});

test("generated catalog is public JSON only, detached, with four levels and untouched synthetic raw", () => {
  const registry = new RendererRegistry();
  registry.registerHarness("pi", [renderer("read", { tool: "read" })]);
  const catalog = registry.catalog();
  const metadata = catalog.find(r => r.id === "pi/read")!;
  expect(metadata.harness).toBe("pi");
  expect(JSON.stringify(metadata)).not.toContain("render:");
  for (const example of metadata.examples) {
    expect(example.summary.split("\n")).toHaveLength(1);
    expect(example.extended.split("\n").length).toBeLessThanOrEqual(2);
    expect(JSON.parse(example.raw).data.title).toBe("read");
    expect(JSON.parse(example.raw)).not.toHaveProperty("rendering");
  }
  metadata.examples[0]!.full = "modified by client";
  expect(registry.catalog().find(r => r.id === "pi/read")!.examples[0]!.full).not.toBe("modified by client");
});

for (const tool of ["read", "bash", "edit", "write"]) {
  test(`Pi-style ${tool} calls, partial updates and results obey the contract`, () => {
    const registry = new RendererRegistry();
    for (const example of toolExamples(tool)) {
      const e = event(example.type, example.data);
      const rendered = renderTool(e);
      expect(rendered.summary.split("\n")).toHaveLength(1);
      expect(rendered.extended.split("\n").length).toBeLessThanOrEqual(2);
      expect(rendered.full).not.toContain("rawInput");
      const symbols: Record<string, string> = { read: "\\<", bash: "$", edit: "Δ", write: "\\>" };
      expect(rendered.summary).toStartWith(symbols[tool]! + " ");
      expect(rendered.summary).not.toMatch(/ · (pending|in_progress|completed|call|partial|result)\b/);
      if (tool !== "bash") expect(rendered.summary).toContain(tool === "write" ? "hello.txt" : "src/main.ts");
      if (tool === "bash") expect(rendered.summary).toContain("$ printf");
      if (tool === "edit") {
        expect(rendered.extendedDiff).toMatchObject({ prefix: "Δ src/main.ts", before: "const n = 1;", after: "const n = 2;" });
        expect(rendered.extended.split("\n")).toHaveLength(2);
        expect(rendered.full).toContain("```diff");
        expect(rendered.full).not.toContain('"oldText"');
      }
      if (example.type === "tool.result") {
        if (tool === "edit") { expect(rendered.summary).toContain("+1 / -1"); expect(rendered.full).toContain("```diff"); }
        if (tool === "read") { expect(rendered.extended).toContain("2 lines"); expect(rendered.summary).toContain("offset=10, limit=2"); }
        if (tool === "write") expect(rendered.extended).toContain("11 bytes");
      }
    }
  });
}

test("core MCP renderers cover exactly the fourteen public tools and preserve stable identity/details", () => {
  const registry = new RendererRegistry();
  const names = ["create_subagent", "prompt_subagent", "get_subagent", "snapshot_organization", "stop_subagent", "restart_subagent", "restart_subagent_subtree", "replace_subagent_session", "remove_subagent", "modify_subagent", "get_completion", "get_operation", "wait_operation", "cancel_operation"];
  expect(registry.catalog().filter(r => r.id.startsWith("core.mcp-")).map(r => r.tool)).toEqual(names);
  for (const tool of names) {
    const input = tool === "get_completion" ? { batchId: "batch-1", after: 0, limit: 5 } : ["get_operation", "wait_operation", "cancel_operation"].includes(tool) ? { operationId: "op-1" } : tool === "create_subagent" ? { name: "worker", settings: { harness: "pi" } } : { agentId: "worker" };
    const rendered = registry.render(event("tool.result", { title: tool, status: "completed", rawInput: input, rawOutput: { content: [{ type: "text", text: JSON.stringify({ status: "running", id: "outer-operation" }) }], isError: false } }), undefined, "core.tools")!;
    expect(rendered.rendererId).toContain("core.mcp-"); expect(rendered.subtype).toBe(tool); expect(rendered.summary).not.toContain("✓");
    expect(rendered.full).toContain(`Tool: ${tool}`); expect(rendered.full).toContain("Received result:");
    expect(rendered.updateMode).toBe("semantic"); expect(rendered.extendedLayout).toBe("header-detail");
  }
  const create = registry.render(event("tool.result", { title: "create_subagent", status: "completed", rawInput: { name: "worker" }, rawOutput: { content: [{ type: "text", text: JSON.stringify({ operationId: "op", agentId: "parent" }) }] } }), undefined, "core.tools")!;
  expect(create.summary).toContain("worker"); expect(create.full).not.toContain("Child ID:");
});

test("MCP JSON text envelopes keep invocation errors distinct from returned operation state and expose truncation", () => {
  const envelope = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
  const running = new RendererRegistry().render(event("tool.result", { title: "wait_operation", status: "completed", rawInput: { operationId: "op-1" }, rawOutput: envelope({ id: "op-1", status: "running" }) }), undefined, "core.tools")!;
  expect(running.summary).toContain("Wait for operation"); expect(running.full).toContain("Returned status: running"); expect(running.full).toContain("Tool invocation: completed");
  const failure = new RendererRegistry().render(event("tool.result", { title: "get_operation", status: "completed", rawInput: { operationId: "op-1" }, rawOutput: envelope({ error: "denied" }, true) }), undefined, "core.tools")!;
  expect(failure.full).toContain("Invocation failed"); expect(failure.full).toContain("denied"); expect(failure.full).toContain("Tool invocation: completed");
  const domainFailure = new RendererRegistry().render(event("tool.result", { title: "get_operation", status: "completed", rawInput: { operationId: "op-1" }, rawOutput: envelope({ a: true, s: "failed", t: true, r: null, isError: true }, false) }), undefined, "core.tools")!;
  expect(domainFailure.full).not.toContain("Invocation failed"); expect(domainFailure.full).toContain("Result truncated: yes"); expect(domainFailure.full).toContain("null");
  const completion = new RendererRegistry().render(event("tool.result", { title: "get_completion", rawInput: { batchId: "b" }, rawOutput: envelope({ b: "b", s: "ready", t: 10, a: 5, n: 10, i: [{ x: 5, o: "op", g: "child", s: "completed", r: false }] }) }), undefined, "core.tools")!;
  expect(completion.full).toContain("Members on page: 1 of 10"); expect(completion.full).toContain("Next cursor: 10"); expect(completion.full).not.toContain("TRUNCATED");
  const truncated = new RendererRegistry().render(event("tool.result", { title: "get_completion", rawInput: { batchId: "b" }, rawOutput: { truncated: true, originalBytes: 99999, preview: "partial" } }), undefined, "core.tools")!;
  expect(truncated.full).toContain("TRUNCATED"); expect(truncated.full).toContain("partial");
});

test("missing, unknown, image, partial, truncated and error results never pretend to have succeeded", () => {
  for (const data of [null, {}, { title: "unknown", rawInput: "partial {" }, { title: "read", rawInput: { path: 42 } }, { truncated: true, originalBytes: 1000, preview: "partial {" }]) {
    expect(renderTool(event("tool.result", data)).full).toContain("Output unavailable");
  }
  const failure = renderTool(event("tool.result", { title: "bash", status: "failed", rawOutput: { content: [{ type: "text", text: "Error: command failed\nexit code: 2" }], details: { truncation: { truncated: true } } } }));
  expect(failure.summary).toBe("$ \\[command unavailable\\]");
  expect(failure.extended).toContain("Error: command failed");
  expect(failure.extended).toContain("exit 2"); expect(failure.extended).toContain("TRUNCATED");
  expect(renderTool(event("tool.result", { title: "read", rawOutput: { content: [{ type: "image", data: "binary" }] } })).full).toContain("Image content");
  expect(renderTool(event("tool.call", { title: "bash", rawInput: { command: "echo hi\necho bye" } })).summary.split("\n")).toHaveLength(1);
  expect(renderTool(event("tool.result", { title: "bash", rawOutput: { structuredContent: { exit_code: 7, output: "out", truncated: true } } })).extended).toContain("exit 7");
});

test("real JSONL opt-in presentation and history sidecars preserve envelopes and use current harness/config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rendering-"));
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "styles", setup(host) {
    host.registerRenderer(renderer("server.custom"));
    host.registerTool({ name: "plugin_custom", description: "fixture", inputSchema: { type: "object" }, execute: () => ({ ok: true }) });
    host.registerToolRenderer({ ...renderer("plugin.automatic", { tool: "plugin_custom" }), render: () => ({ summary: "plugin-owned tool", extended: "plugin-owned tool\\nready", full: "plugin-owned tool", updateMode: "semantic", extendedLayout: "header-detail" }) });
    host.registerHarness({ name: "pi", renderers: [renderer("read", { tool: "read" })], toolAliases: names => Object.fromEntries(names.map(name => [`mcp__pi__${name}`, name])), launch: () => ({ command: "unused", args: [] }) });
  } }] });
  const client = await OrganizationClient.connect(join(dir, "server.sock"));
  try {
    server.organization.agents.set("agent", { id: "agent", settings: { harness: "pi", options: {} } } as AgentRecord);
    const frames: ServerEvent[] = [], presentations = new Map<number, any>();
    client.onEvent(e => frames.push(e)); client.onPresentation((seq, value) => presentations.set(seq, value));
    await client.request("subscribe", { renderings: true });
    server.organization.emit("tool.result", { title: "read", status: "completed", rawInput: { path: "a.ts" } }, "agent");
    const history = await client.request<any>("events.history", { after: 0, renderings: true });
    const received = frames.find(e => e.type === "tool.result")!;
    expect(received).toBeDefined();
    expect(received).not.toHaveProperty("rendering");
    expect(presentations.get(received.seq).rendererId).toBe("pi/read");
    expect(history.events.find((e: ServerEvent) => e.seq === received.seq)).toEqual(received);
    expect(history.renderings[received.seq].rendererId).toBe("pi/read");
    const choices = await client.request<any>("events.renderer-choices");
    expect(choices.choices.map((choice: any) => choice.value)).toEqual(["core.tools", "generic", "server.custom"]);
    const catalog = await client.request<any>("events.renderers");
    expect(catalog.renderers.find((r: any) => r.id === "pi/read").tool).toBe("read");
    const custom = server.organization.renderEvent(event("tool.result", { title: "plugin_custom", rawInput: { value: 1 } }))!;
    expect(custom.rendererId).toBe("plugin.automatic"); expect(custom.summary).toBe("plugin-owned tool");
    const aliased = server.organization.renderEvent(event("tool.result", { title: "mcp__pi__plugin_custom", rawInput: { value: 1 } }))!;
    expect(aliased.rendererId).toBe("plugin.automatic"); expect(aliased.subtype).toBe("mcp__pi__plugin_custom"); expect(aliased.canonicalTool).toBe("plugin_custom");
    server.organization.agents.get("agent")!.settings.harness = "other";
    await client.request("organization.settings.update", { namespace: "rendering", expectedRevision: 0, patch: { defaultToolRenderer: "server.custom" } });
    const rerendered = await client.request<any>("events.history", { after: received.seq - 1, limit: 1, renderings: true });
    expect(rerendered.renderings[received.seq].rendererId).toBe("server.custom");
    expect(rerendered.events[0]).toEqual(received);
    await client.request("organization.settings.update", { namespace: "rendering", expectedRevision: 1, patch: { defaultToolRenderer: "missing" } });
    expect((await client.request<any>("events.history", { after: received.seq - 1, limit: 1, renderings: true })).renderings[received.seq].rendererId).toBe("generic");
    expect(await client.request<any>("events.history", { after: 0 })).not.toHaveProperty("renderings");
    await client.request("subscribe", {});
    const count = presentations.size;
    server.organization.emit("tool.call", { title: "read" }, "agent");
    await client.request("events.history", {}); // Barrier after the live delivery.
    expect(presentations.size).toBe(count);
    await expect(server.organization.request("events.renderers", {}, { kind: "agent", id: "agent" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
