import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { renderTool, toolExamples } from "../src/rendering.ts";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, ServerEvent } from "../src/types.ts";

function fixture(run: (store: Store, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tool-context-")), file = join(dir, "test.sqlite"), store = new Store(file);
  try { run(store, file); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
function emit(store: Store, type: string, data: unknown, agentId = "agent", generation = "g1", maxEvents = 10000) {
  return store.event({ kind: "event", type, data, agentId, generation, time: "now" }, maxEvents);
}
const command = "PYTHONPATH=src python -m unittest discover -s tests && PYTHONPATH=src python -m adder 2 3.5";

for (const tool of ["bash", "read", "write", "edit", "mcp__agentorg__create_subagent"]) {
  test(`${tool}: sparse ACP phases keep the same tree identity, with errors/output confined to details`, () => fixture(store => {
    const input = tool === "bash" ? { command } : tool === "edit" ? { path: "a.py", edits: [{ oldText: "old", newText: "new" }] } : { path: "a.py", content: "hello" };
    const call = emit(store, "tool.call", { toolCallId: "one", title: tool, rawInput: input, status: "in_progress" });
    const update = emit(store, "tool.update", { toolCallId: "one", status: "in_progress", rawOutput: { content: [{ type: "text", text: "progress" }] } });
    const failure = "/bin/bash: line 1: python: command not found\nCommand exited with code 127";
    const failed = emit(store, "tool.result", { toolCallId: "one", status: "failed", rawOutput: { content: [{ type: "text", text: failure }] } });
    const completed = emit(store, "tool.result", { toolCallId: "one", status: "completed" });
    const original = JSON.stringify([call, update, failed, completed]);
    const summaries = [call, update, failed, completed].map(e => renderTool(store.presentationEvent(e)).summary);
    expect(new Set(summaries).size).toBe(1);
    if (tool === "bash") expect(summaries[0]).toBe("• bash");
    for (const e of [update, failed, completed]) {
      const view = store.presentationEvent(e);
      expect((view.data as any).title).toBe(tool);
      expect((view.data as any).rawInput).toEqual(input);
      expect((view.data as any).status).toBe((e.data as any).status);
      expect((view.data as any).rawOutput).toEqual((e.data as any).rawOutput);
      expect(renderTool(view).full.split("\n")[0]).toBe(summaries[0]);
      if (e === failed) expect(renderTool(view).extended).toContain("python: command not found");
    }
    expect(JSON.stringify([call, update, failed, completed])).toBe(original);
    expect(store.history(failed.seq - 1, 1).events[0]).toEqual(failed);
    expect(failed.data).not.toHaveProperty("title");
  }));
}

test("context lookup is fenced by agent, generation, event sequence and prompt/session boundaries", () => fixture(store => {
  const call = emit(store, "tool.call", { toolCallId: "same", title: "bash", rawInput: { command: "first" } });
  emit(store, "tool.call", { toolCallId: "same", title: "write", rawInput: { path: "other" } }, "other");
  emit(store, "tool.call", { toolCallId: "same", title: "read", rawInput: { path: "different-generation" } }, "agent", "g2");
  emit(store, "tool.call", { toolCallId: "parallel-id", title: "bash", rawInput: { command: "parallel" } });
  const result = emit(store, "tool.result", { toolCallId: "same", status: "completed" });
  const parallel = emit(store, "tool.result", { toolCallId: "parallel-id", status: "completed" });
  expect(store.presentationEvent(parallel).data).toHaveProperty("rawInput.command", "parallel");
  emit(store, "tool.call", { toolCallId: "same", title: "bash", rawInput: { command: "future" } });
  expect(store.presentationEvent(result).data).toHaveProperty("rawInput.command", "first");
  const reused = emit(store, "tool.result", { toolCallId: "same", status: "completed" });
  expect(store.presentationEvent(reused).data).toHaveProperty("rawInput.command", "future");
  emit(store, "prompt.started", {});
  const orphan = emit(store, "tool.result", { toolCallId: "same", status: "completed" });
  expect(store.presentationEvent(orphan)).toEqual(orphan);
  emit(store, "tool.call", { toolCallId: "same", title: "bash", rawInput: { command: "new session" } });
  emit(store, "agent.session_replaced", {});
  const replaced = emit(store, "tool.result", { toolCallId: "same", status: "completed" });
  expect(store.presentationEvent(replaced)).toEqual(replaced);
  expect(store.presentationEvent(call)).toBe(call);
  expect(store.presentationEvent({ ...result, data: {} }).data).toEqual({});
}));

test("reopened history and single-record pages recover context; available metadata updates survive call pruning", () => fixture((store, file) => {
  emit(store, "tool.call", { toolCallId: "x", title: "bash", rawInput: { command: "python3 --version" } });
  const result = emit(store, "tool.result", { toolCallId: "x", status: "completed" });
  const reopened = new Store(file);
  try {
    const page = reopened.history(result.seq - 1, 1);
    expect(page.events).toHaveLength(1);
    expect(reopened.presentationEvent(page.events[0]!).data).toHaveProperty("rawInput.command", "python3 --version");
  } finally { reopened.close(); }
  emit(store, "tool.call", { toolCallId: "y", title: "read", rawInput: {} }, "agent", "g1", 2);
  emit(store, "tool.update", { toolCallId: "y", title: "read", rawInput: { path: "retained.txt" } }, "agent", "g1", 2);
  const sparse = emit(store, "tool.result", { toolCallId: "y", status: "completed" }, "agent", "g1", 2);
  expect(store.presentationEvent(sparse).data).toHaveProperty("rawInput.path", "retained.txt");
  const expired = emit(store, "tool.result", { toolCallId: "y", status: "completed" }, "agent", "g1", 1);
  expect(store.presentationEvent(expired)).toEqual(expired);
}));

test("context never overwrites authoritative adapter arguments or inherits previous output/status", () => fixture(store => {
  emit(store, "tool.call", { toolCallId: "x", title: "bash", rawInput: { command: "old" }, status: "pending", rawOutput: "DO NOT INHERIT" });
  const explicit = emit(store, "tool.update", { toolCallId: "x", title: "bash", rawInput: { command: "authoritative" } });
  expect(store.presentationEvent(explicit)).toBe(explicit);
  const sparse = emit(store, "tool.result", { toolCallId: "x" });
  const view = store.presentationEvent(sparse);
  expect(view.data).toHaveProperty("rawInput.command", "authoritative");
  expect(view.data).not.toHaveProperty("status"); expect(view.data).not.toHaveProperty("rawOutput");
}));

test("live and paginated JSONL rendering resolve the harness renderer using recovered identity without changing raw envelopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-context-socket-"));
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "pi-fixture", setup(host) {
    host.registerHarness({ name: "pi", launch: () => ({ command: "unused", args: [] }), renderers: [{ id: "bash", name: "Pi bash", tool: "bash", eventTypes: ["tool.call", "tool.update", "tool.result"], examples: toolExamples("bash"), render: renderTool }] });
  } }] });
  const client = await OrganizationClient.connect(join(dir, "server.sock"));
  try {
    server.organization.agents.set("agent", { id: "agent", settings: { harness: "pi", options: {} } } as AgentRecord);
    const presentations = new Map<number, any>(), events: ServerEvent[] = [];
    client.onPresentation((seq, view) => presentations.set(seq, view)); client.onEvent(e => events.push(e));
    await client.request("subscribe", { renderings: true });
    server.organization.emit("tool.call", { toolCallId: "x", title: "bash", rawInput: { command }, status: "in_progress" }, "agent", "g1");
    server.organization.emit("tool.update", { toolCallId: "x", status: "in_progress" }, "agent", "g1");
    server.organization.emit("tool.result", { toolCallId: "x", status: "failed", rawOutput: "/bin/bash: line 1: python: command not found\nCommand exited with code 127" }, "agent", "g1");
    await client.request("organization.snapshot"); // Live delivery barrier.
    const phases = events.filter(e => e.type.startsWith("tool."));
    expect(phases).toHaveLength(3);
    for (const e of phases) {
      expect(presentations.get(e.seq).summary).toBe("• bash");
      expect(presentations.get(e.seq).rendererId).toBe("pi/bash");
      const page: any = await client.request("events.history", { after: e.seq - 1, limit: 1, renderings: true });
      expect(page.events).toEqual([e]); expect(page.renderings[e.seq]).toEqual(presentations.get(e.seq));
    }
    expect(phases[2]!.data).not.toHaveProperty("title"); expect(phases[2]!.data).not.toHaveProperty("rawInput");
    expect(presentations.get(phases[2]!.seq).extended).toContain("python: command not found");
    server.organization.store.presentationEvent = () => { throw new Error("Context unavailable"); };
    server.organization.emit("tool.result", { toolCallId: "no-context", status: "failed", rawOutput: "error" }, "agent", "g1");
    const fallback: any = await client.request("events.history", { after: phases[2]!.seq, limit: 1, renderings: true });
    expect(fallback.events).toHaveLength(1);
    expect(events.at(-1)).toEqual(fallback.events[0]);
    expect(fallback.renderings[fallback.events[0].seq].full).toContain("error");
  } finally { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
