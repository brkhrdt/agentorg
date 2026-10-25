import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_TOOL_NAMES, decodeMcpOutput, renderMcpTool } from "../src/mcp-tool-rendering.ts";
import { RendererRegistry, type EventRenderer } from "../src/rendering.ts";
import { OrganizationServer } from "../src/server.ts";
import type { AgentRecord, ServerEvent } from "../src/types.ts";

const envelope = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const event = (tool: string, output: unknown, input: unknown = { operationId: "op-1" }): ServerEvent => ({
  kind: "event", seq: 1, time: "now", agentId: "parent", type: "tool.result",
  data: { title: tool, status: "completed", rawInput: input, rawOutput: output },
});
const descriptor = (id: string, tool: string, extra: Partial<EventRenderer> = {}): EventRenderer => ({
  id, name: id, tool, eventTypes: ["tool.result"], examples: [{ type: "tool.result", data: { title: tool } }],
  render: () => ({ summary: id, extended: `${id}\nready`, full: id }), ...extra,
});

test("canonical tools and replace_subagent_session dispatch match the public MCP contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-dispatch-"));
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), plugins: [] });
  try {
    const org = server.organization, caller = { kind: "agent", id: "parent" } as const;
    const listed = await org.request("mcp.list", {}, caller) as any;
    expect(listed.tools.map((tool: any) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const original = org.request.bind(org), dispatched: string[] = [];
    org.request = async (method, ...args) => {
      if (method === "agent.replace_session") { dispatched.push(method); return { id: "lifecycle-op", status: "queued" }; }
      return original(method, ...args);
    };
    const response = await original("mcp.call", { name: "replace_subagent_session", arguments: { agentId: "child" } }, caller) as any;
    expect(dispatched).toEqual(["agent.replace_session"]);
    expect(JSON.parse(response.content[0].text)).toEqual({ id: "lifecycle-op", status: "queued" });
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Pi-prefixed projections decode by canonical registration without changing received identity", () => {
  const registry = new RendererRegistry();
  registry.registerHarness("pi", [], names => Object.fromEntries(names.map(name => [`mcp__agentorg__${name}`, name])));
  for (const status of ["queued", "running", "completed", "failed", "stopped", "interrupted"]) {
    const e = event("mcp__agentorg__get_operation", envelope({ a: true, s: status, t: true, r: null }));
    const original = structuredClone(e), rendered = registry.render(e, "pi", "core.tools")!;
    expect(rendered.extended.split("\n")[1]).toStartWith(`${status} · \\[TRUNCATED\\]`);
    expect(rendered.invocationError).toBe(false);
    expect(rendered.subtype).toBe("mcp__agentorg__get_operation");
    expect(rendered.canonicalTool).toBe("get_operation"); expect(rendered.toolSymbol).toBe("∴");
    expect(e).toEqual(original);
  }
});

test("expanded and compact completion states, suppression and retention have identical semantics", () => {
  for (const value of [
    { batchId: "batch", state: "suppressed", total: 2, after: 0, next: 1, suppressionReason: "explicit-stop", items: [{ status: "missing-or-pruned", resultAvailable: false }] },
    { b: "batch", s: "suppressed", t: 2, a: 0, n: 1, q: "explicit-stop", i: [{ s: "missing-or-pruned", r: false }] },
  ]) {
    const result = renderMcpTool("get_completion", event("get_completion", envelope(value), { batchId: "batch" }));
    expect(result.extended.split("\n")[1]).toStartWith("suppressed · Suppression: explicit-stop");
    expect(result.full).toContain("Member statuses: missing-or-pruned");
    expect(result.full).toContain("operation retention, not result bodies");
    expect(result.full).toContain("Next cursor: 1"); expect(result.full).not.toContain("TRUNCATED");
  }
});

test("only recognized envelopes establish invocation failure; direct domain isError is not an error flag", () => {
  const direct = renderMcpTool("get_operation", event("get_operation", { s: "failed", isError: true, r: false }));
  expect(direct.invocationError).toBe(false); expect(direct.full).not.toContain("Invocation failed");
  const failed = renderMcpTool("get_operation", event("get_operation", envelope({ code: "FORBIDDEN", message: "denied" }, true)));
  expect(failed.invocationError).toBe(true); expect(failed.extended.split("\n")[1]).toStartWith("failed invocation");
  expect(failed.full).toContain("FORBIDDEN: denied");
});

test("bounded decoder supports valid values and adapter blocks without guessing mixed/multiple output", () => {
  for (const value of [null, false, 0, [], [0, false, null], { result: null }]) {
    expect(decodeMcpOutput(event("get_operation", envelope(value))).domain).toEqual(value);
    expect(decodeMcpOutput(event("get_operation", value)).domain).toEqual(value);
  }
  expect(decodeMcpOutput(event("wait_operation", [{ type: "content", content: { type: "text", text: '{"status":"running"}' } }])).domain).toEqual({ status: "running" });
  for (const output of [
    { content: [{ type: "text", text: '{"status":"completed"}' }, { type: "image", data: "abc" }] },
    { content: [{ type: "text", text: '{"status":"completed"}' }, { type: "text", text: '{"status":"failed"}' }] },
    { content: [{ type: "text", text: "partial {" }] },
    envelope({ status: "failed", result: "x".repeat(70_000) }),
    { content: [{ type: "text", text: '['.repeat(100) + '0' + ']'.repeat(100) }] },
  ]) {
    const decoded = decodeMcpOutput(event("wait_operation", output));
    expect(decoded.complete).toBe(false); expect(decoded.warning).toBeDefined(); expect(decoded.domain).toEqual(output);
  }
  for (const output of [envelope({ truncated: true, preview: '{"status":"completed"}' }), envelope({ status: "running", result: { truncated: true, text: "partial" } })])
    expect(decodeMcpOutput(event("wait_operation", output)).truncated).toBe(true);
});

test("get_operation uses generic operation rendering and identifies its agent by name", () => {
  const prompt = renderMcpTool("get_operation", event("get_operation", envelope({
    id: "op-prompt", type: "agent.prompt", agentId: "child-id", status: "completed",
    result: { text: "# Review\nTwo **useful** findings.", truncated: false },
  }), { operationId: "op-prompt" }), { targetName: "Reviewer" });
  expect(prompt.summary).toBe("Inspect operation · op-prompt · Reviewer");
  expect(prompt.extended).toContain("Agent: Reviewer");
  expect(prompt.extended).toContain("Operation type: agent.prompt");
  expect(prompt.full).toContain("Reviewer");
  expect(prompt.full).toContain('"agentId": "child-id"');
  expect(prompt.full).not.toContain("Reviewer: @Coordinator");

  const created = renderMcpTool("get_operation", event("get_operation", envelope({
    id: "op-create", type: "agent.create", agentId: "parent-id", status: "completed",
    result: { id: "child-id", name: "Coder", settings: { harness: "pi", model: "gpt-6-luna", cwd: "/workspace" } },
  }), { operationId: "op-create" }), { targetName: "Coordinator" });
  expect(created.summary).toBe("Inspect operation · op-create · Coordinator");
  expect(created.extended).toContain("Agent: Coordinator");
  expect(created.full).toContain('"name": "Coder"');
  expect(created.full).not.toContain("Creating subagent");

  const fallback = renderMcpTool("get_operation", event("get_operation", envelope({
    id: "op-modify", type: "agent.modify", status: "completed", result: { revision: 4 },
  })));
  expect(fallback.full).toContain("Decoded MCP value:");
  expect(fallback.full).toContain('"revision": 4');
});

test("lifecycle and agent details reflect actual nested result contracts without promoting child answers", () => {
  const replaced = renderMcpTool("replace_subagent_session", event("replace_subagent_session", envelope({ id: "op", status: "completed", result: { state: "running", sessionId: "session-2", sessionNumber: 2 } }), { agentId: "child" }));
  expect(replaced.full).toContain("sessionNumber: 2"); expect(replaced.full).toContain("sessionId: session-2");
  const inspected = renderMcpTool("get_subagent", event("get_subagent", envelope({ name: "worker", state: "stopped", settings: { model: "provider/model" }, revision: 3, removedAt: "yesterday" })));
  expect(inspected.extended.split("\n")[1]).toStartWith("stopped"); expect(inspected.full).toContain("model: provider/model");
  const cancelled = renderMcpTool("cancel_operation", event("cancel_operation", envelope({ id: "op", status: "running", cancelRequested: true, result: "CHILD SECRET ANSWER" })));
  expect(cancelled.extended).toContain("Cancellation requested: yes"); expect(cancelled.extended).not.toContain("CHILD SECRET ANSWER");
});

test("aliases reject asynchronous factories, unknown targets and canonical redirection; property names remain valid identities", async () => {
  const asyncRegistry = new RendererRegistry();
  asyncRegistry.registerHarness("async", [], (async () => { throw new Error("rejected alias"); }) as any);
  expect(() => asyncRegistry.validateRegistrations(MCP_TOOL_NAMES)).toThrow("synchronous");
  await Bun.sleep(0); // No unhandled rejection after rejecting invalid asynchronous factories.
  for (const aliases of [{ unknown: "missing" }, { get_operation: "wait_operation" }] as Array<Record<string, string>>) {
    const registry = new RendererRegistry(); registry.registerHarness("h", [], aliases);
    expect(() => registry.validateRegistrations(MCP_TOOL_NAMES)).toThrow();
  }
  const registry = new RendererRegistry();
  registry.registerToolRenderer(descriptor("plugin.constructor", "constructor"));
  registry.registerHarness("h", [], JSON.parse('{"__proto__":"constructor"}'));
  for (const identity of ["constructor", "__proto__"]) expect(registry.render(event(identity, null), "h", "core.tools")?.rendererId).toBe("plugin.constructor");
});

test("automatic registration conflicts, detached descriptor hints and scoped catalog aliases", () => {
  const registry = new RendererRegistry(), desc = descriptor("custom", "custom", { updateMode: "semantic", extendedLayout: "header-detail", render: () => ({ summary: "custom", extended: "custom\nready", full: "custom", updateMode: undefined, extendedLayout: undefined }) });
  registry.registerHarness("a", [], { shared: "get_operation" }); registry.registerHarness("b", [], { shared: "wait_operation" });
  registry.registerToolRenderer(desc); desc.eventTypes.push("tool.update");
  expect(() => registry.registerToolRenderer(descriptor("overlap", "custom"))).toThrow("Overlapping");
  expect(() => registry.registerToolRenderer(descriptor("custom", "another"))).toThrow("Duplicate");
  registry.registerToolRenderer(descriptor("other-phase", "custom", { eventTypes: ["tool.call"], examples: [{ type: "tool.call", data: {} }] }));
  const custom = registry.catalog().find(row => row.id === "custom")!;
  expect(custom.examples[0]?.updateMode).toBe("semantic"); expect(custom.examples[0]?.extendedLayout).toBe("header-detail");
  expect(registry.render(event("custom", null), undefined, "generic")?.updateMode).toBe("semantic");
  expect(custom.eventTypes).toEqual(["tool.result"]);
  expect(registry.catalog().find(row => row.tool === "get_operation")?.aliasHarnesses).toEqual({ shared: ["a"] });
  expect(registry.catalog().find(row => row.tool === "wait_operation")?.aliasHarnesses).toEqual({ shared: ["b"] });
  expect(registry.choices().some(choice => choice.value === "custom")).toBe(false);
  expect(() => registry.validateRegistrations(MCP_TOOL_NAMES)).toThrow("unregistered MCP tool custom");
  const scoped = new RendererRegistry();
  scoped.registerHarness("a", [descriptor("native", "read")]); scoped.registerHarness("b", [descriptor("native", "read")]);
  expect(scoped.render(event("read", null), "a", "core.tools")?.rendererId).toBe("a/native");
  expect(scoped.render(event("read", null), "b", "core.tools")?.rendererId).toBe("b/native");
});

test("exact and automatic renderer failures fall through; missing identity never selects a wildcard tool tier", async () => {
  const registry = new RendererRegistry();
  registry.registerHarness("h", [descriptor("broken", "get_operation", { render: (async () => { throw new Error("bad renderer"); }) as any }), { ...descriptor("wildcard", "ignored"), tool: undefined }]);
  expect(registry.render(event("get_operation", envelope({ status: "running" })), "h", "core.tools")?.rendererId).toBe("core.mcp-get-operation");
  expect(registry.render({ ...event("", null), data: {} }, "h", "core.tools")?.rendererId).toBe("core.tools");
  registry.registerToolRenderer(descriptor("bad.automatic", "custom", { render: () => { throw new Error("bad automatic"); } }));
  expect(registry.render(event("custom", null), "h", "missing")?.rendererId).toBe("generic");
  expect(() => registry.registerToolRenderer(descriptor("wrong.phase", "custom2", { eventTypes: ["agent.message"], examples: [{ type: "agent.message", data: {} }] }))).toThrow("tool event phases");
  await Bun.sleep(0);
});

test("presentation byte limits include their warnings without hiding the header-detail status", () => {
  const registry = new RendererRegistry();
  registry.registerToolRenderer(descriptor("large.presentation", "large", { extendedLayout: "header-detail", render: () => ({ summary: "界".repeat(9000), extended: `${"界".repeat(9000)}\nstopped`, full: "界".repeat(800_000) }) }));
  const result = registry.render(event("large", null), undefined, "core.tools")!;
  expect(Buffer.byteLength(result.summary)).toBeLessThanOrEqual(8192);
  expect(Buffer.byteLength(result.extended)).toBeLessThanOrEqual(16384);
  expect(Buffer.byteLength(result.full)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.full).toContain("RENDERING TRUNCATED"); expect(result.extended.split("\n")[1]).toBe("stopped");
});

test("prompt display names never rewrite received payloads, and late tools invalidate aliases/catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-target-"));
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "test", setup(host) {
    host.registerHarness({ name: "h", toolAliases: names => Object.fromEntries(names.map(name => [`prefix_${name}`, name])), launch: () => ({ command: "unused", args: [] }) });
  } }] });
  try {
    const org = server.organization;
    org.agents.set("parent", { id: "parent", name: "Coordinator", settings: { harness: "h" } } as AgentRecord);
    org.agents.set("child-id", { id: "child-id", name: "[Reviewer] *one*", sessionId: "session-id" } as AgentRecord);
    const e = event("prefix_prompt_subagent", envelope({ answer: "Keep @child-id literally" }), { agentId: "child-id", text: "Keep @child-id literally", queue: true });
    const original = structuredClone(e), rendering = org.renderEvent(e)!;
    expect(rendering.summary).toStartWith("@\\[Reviewer\\] \\*one\\*"); expect(rendering.toolTarget).toBe("@[Reviewer] *one*");
    expect(rendering.full).toContain('"text": "Keep @child-id literally"'); expect(rendering.full).toContain('"answer\\":\\"Keep @child-id literally');
    expect(e).toEqual(original);
    org.operations.set("operation-prompt", { id: "operation-prompt", type: "agent.prompt", agentId: "child-id", caller: { kind: "agent", id: "parent" }, status: "completed", input: {}, result: { text: "A child response", truncated: false }, createdAt: "now" });
    const inspected = org.renderEvent(event("prefix_get_operation", envelope({ a: true, s: "completed", t: false, r: { text: "A child response", truncated: false } }), { operationId: "operation-prompt" }))!;
    expect(inspected.summary).toBe("Inspect operation · operation-prompt · \\[Reviewer\\] \\*one\\*");
    expect(inspected.extended).toContain("Agent: \\[Reviewer\\] \\*one\\*");
    expect(inspected.full).toContain("A child response");
    await org.request("events.renderers");
    org.registerTool({ name: "late_tool", description: "late", inputSchema: { type: "object" }, execute: () => null });
    org.registerToolRenderer(descriptor("late.renderer", "late_tool"));
    expect(org.renderEvent(event("prefix_late_tool", envelope(null)))?.rendererId).toBe("late.renderer");
    const catalog = await org.request("events.renderers") as any;
    expect(catalog.renderers.find((row: any) => row.tool === "late_tool")?.aliases).toContain("prefix_late_tool");
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
