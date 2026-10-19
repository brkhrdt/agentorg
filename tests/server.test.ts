import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import { JsonLines } from "../src/jsonl.ts";
import { Store } from "../src/store.ts";
import {
  now,
  type AgentRecord,
  type Operation,
  type ServerEvent,
  type Limits,
} from "../src/types.ts";
import type { ServerPlugin } from "../src/plugin.ts";

const fixture: ServerPlugin = {
  apiVersion: 1,
  name: "fixture",
  setup(host) {
    host.registerHarness({
      name: "fixture",
      launch(c) {
        return {
          command: process.execPath,
          args: [join(import.meta.dir, "fixtures", "agent.ts")],
          cwd: c.agent.settings.cwd ?? process.cwd(),
          env: {
            ...process.env,
            ...c.agent.settings.env,
            ORG_SOCKET: c.socketPath,
            ORG_TOKEN: c.token,
          },
        };
      },
    });
  },
};
const servers: OrganizationServer[] = [],
  clients: OrganizationClient[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function setup(limits: Partial<Limits> = {}, extra: ServerPlugin[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "org-test-"));
  dirs.push(dir);
  const server = await OrganizationServer.start({
    dataDir: dir,
    socketPath: join(dir, "server.sock"),
    plugins: [fixture, ...extra],
    limits: {
      stopTimeoutMs: 100,
      killTimeoutMs: 50,
      cancelTimeoutMs: 100,
      ...limits,
    },
  });
  servers.push(server);
  const client = await OrganizationClient.connect(join(dir, "server.sock"));
  clients.push(client);
  return { dir, server, client };
}
async function create(
  client: OrganizationClient,
  parentId: string | null = null,
  env: Record<string, string> = {},
) {
  const op = await client.wait(
    await client.request<Operation>("agent.create", {
      parentId,
      settings: { harness: "fixture", model: "gpt-6-luna", env },
    }),
  );
  expect(op.status).toBe("completed");
  return client.request<AgentRecord>("agent.get", { agentId: op.agentId });
}
async function mutate(
  client: OrganizationClient,
  method: string,
  agentId: string,
) {
  return client.wait(await client.request<Operation>(method, { agentId }));
}
async function prompt(
  client: OrganizationClient,
  agentId: string,
  text: string,
  queue = false,
) {
  return client.request<Operation>("agent.prompt", { agentId, text, queue });
}
async function until(predicate: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}

test("LF framing preserves split UTF-8, CRLF and Unicode separators; bounds records", () => {
  const values: string[] = [];
  const lines = new JsonLines(100, (line) =>
    values.push(JSON.parse(line).text),
  );
  const bytes = Buffer.from('{"text":"é\u2028\u2029"}\r\n');
  for (const byte of bytes) lines.push(Buffer.from([byte]));
  expect(values).toEqual(["é\u2028\u2029"]);
  expect(() => new JsonLines(2, () => {}).push(Buffer.from("xxx"))).toThrow(
    "too large",
  );
});

test("tree lifecycle, revisions, session continuity and preserved workspaces/history", async () => {
  const { client, dir } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const leaf = await create(client, child.id);
  const childGeneration = child.generation;
  const metadata = await client.wait(
    await client.request<Operation>("agent.modify", {
      agentId: root.id,
      expectedRevision: 1,
      name: "renamed",
    }),
  );
  expect((metadata.result as AgentRecord).generation).toBe(root.generation);
  const stale = await client.wait(
    await client.request<Operation>("agent.modify", {
      agentId: root.id,
      expectedRevision: 1,
      name: "stale",
    }),
  );
  expect(stale.error?.code).toBe("CONFLICT");
  const modified = await client.wait(
    await client.request<Operation>("agent.modify", {
      agentId: root.id,
      settings: { env: { NEW_SETTING: "yes" } },
    }),
  );
  expect((modified.result as AgentRecord).generation).not.toBe(root.generation);
  expect((modified.result as AgentRecord).sessionId).toBe(root.sessionId);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: child.id }))
      .generation,
  ).toBe(childGeneration);
  const replaced = await mutate(client, "agent.replace_session", root.id);
  expect((replaced.result as AgentRecord).sessionId).not.toBe(root.sessionId);
  await mutate(client, "agent.restart_subtree", root.id);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: child.id }))
      .generation,
  ).not.toBe(childGeneration);
  await mutate(client, "agent.remove", child.id);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: leaf.id }))
      .removedAt,
  ).toBeTruthy();
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: root.id }))
      .removedAt,
  ).toBeNull();
  expect(
    (await client.request<any>("events.history", { agentId: child.id })).events
      .length,
  ).toBeGreaterThan(0);
  expect(await Bun.file(join(dir, "organization.sqlite")).exists()).toBe(true);
  expect(
    await client
      .request("agent.prompt", { agentId: child.id, text: "no" })
      .catch((e: any) => e.code),
  ).toBe("NOT_FOUND");
});

test("prompt FIFO/global limit, supersession, cancel acknowledgement and brief waits", async () => {
  const { client, server } = await setup({ maxPrompts: 1 });
  const root = await create(client);
  const child = await create(client, root.id);
  const first = await prompt(client, root.id, "sleep:200");
  const queued = await prompt(client, root.id, "second", true);
  const childOp = await prompt(client, child.id, "child");
  const waiting = await client.request<Operation>("operation.wait", {
    operationId: first.id,
    waitMs: 1,
  });
  expect(waiting.status).toBe("running");
  expect(
    (
      await client.request<Operation>("operation.get", {
        operationId: childOp.id,
      })
    ).status,
  ).toBe("queued");
  const newer = await prompt(client, root.id, "new");
  expect((await client.wait(queued)).status).toBe("stopped");
  expect((await client.wait(first)).status).toBe("stopped");
  expect((await client.wait(newer)).status).toBe("completed");
  expect((await client.wait(childOp)).status).toBe("completed");
  const a = await prompt(client, root.id, "sleep:100");
  const b = await prompt(client, root.id, "b", true);
  const c = await prompt(client, root.id, "c", true);
  expect(
    (await client.request<Operation>("operation.cancel", { operationId: b.id }))
      .status,
  ).toBe("stopped");
  await client.wait(a);
  await client.wait(c);
  const events = server.organization.store
    .history(0, 1000)
    .events.filter((e) => e.type === "prompt.started")
    .map((e) => (e.data as any).operationId);
  expect(events.indexOf(a.id)).toBeLessThan(events.indexOf(c.id));
  expect(events).not.toContain(b.id);
});

test("non-cooperative cancellation escalates and crashes are contained", async () => {
  const { client } = await setup();
  const root = await create(client, null, { IGNORE_CANCEL: "1" });
  const child = await create(client, root.id);
  const op = await prompt(client, root.id, "sleep:10000");
  const cancelled = await client.request<Operation>("operation.cancel", {
    operationId: op.id,
  });
  expect(cancelled.cancelRequested).toBe(true);
  expect(cancelled.status).toBe("running");
  expect((await client.wait(op)).status).toBe("stopped");
  // Prompt completion precedes the final failed-state event by a few synchronous statements.
  await Bun.sleep(10);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: root.id }))
      .state,
  ).toBe("failed");
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: child.id }))
      .state,
  ).toBe("idle");
  await mutate(client, "agent.restart", root.id);
  const crash = await prompt(client, child.id, "crash");
  await client.wait(crash);
  await Bun.sleep(10);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: child.id }))
      .state,
  ).toBe("failed");
}, 10000);

test("MCP SDK bridge enforces direct-child creation and subtree permissions", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const sibling = await create(client, root.id);
  const rt = (server.organization as any).runtimes.get(child.id);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "src", "mcp-bridge.ts")],
    env: {
      ...(process.env as Record<string, string>),
      ORG_SOCKET: server.organization.socketPath,
      ORG_TOKEN: rt.token,
    },
  });
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(transport);
  try {
    expect(
      (await mcp.listTools()).tools.some((t) => t.name === "child_create"),
    ).toBe(true);
    const forbidden = await mcp.callTool({
      name: "descendant_prompt",
      arguments: { agentId: sibling.id, text: "forbidden" },
    });
    expect(forbidden.isError).toBe(true);
    const self = await mcp.callTool({
      name: "descendant_remove",
      arguments: { agentId: child.id },
    });
    expect(self.isError).toBe(true);
    const own = await mcp.callTool({
      name: "child_create",
      arguments: { settings: { harness: "fixture", model: "gpt-6-luna" } },
    });
    const op = JSON.parse((own.content as any)[0].text);
    expect((await client.wait(op)).status).toBe("completed");
    const historicalToken = rt.token;
    await mutate(client, "agent.restart", child.id);
    expect(() => server.organization.callerForToken(historicalToken)).toThrow(
      "Expired",
    );
  } finally {
    await mcp.close();
  }
});

test("root coordinates two children through organization tools without holding lifecycle queue", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const done = await client.wait(await prompt(client, root.id, "delegate"));
  expect(done.status).toBe("completed");
  const snapshot = await client.request<any>("organization.snapshot");
  expect(
    snapshot.agents.filter((a: AgentRecord) => a.parentId === root.id),
  ).toHaveLength(2);
  const batch = server.organization.store.completionBatches().find(b => b.identity.rootOperationId === done.id);
  expect(batch?.identity.parentAgentId).toBe(root.id);
  expect(batch?.memberOperationIds).toHaveLength(2);
  expect(Object.values(batch?.memberStatuses ?? {})).toEqual(["completed", "completed"]);
});

test("fire-and-return continuation preserves authenticated child results under pruning pressure until terminal", async () => {
  const { client, server, dir } = await setup({ maxPrompts: 1, maxOperations: 1, maxPendingCompletionOperations: 2 });
  const root = await create(client, null, { COMPLETION_BARRIER_DIR: dir });
  const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
  expect(parent.status).toBe("completed");
  const batchForParent = () => server.organization.store.completionBatches().find(b => b.identity.rootOperationId === parent.id)!;
  await until(() => batchForParent()?.state === "dispatching");
  const batch = batchForParent();
  expect(batch.memberOperationIds).toHaveLength(2);
  expect(batch.continuationOperationId).toBeTruthy();
  await until(() => existsSync(join(dir, `continuation-${parent.id}.started`)));
  const rt = (server.organization as any).runtimes.get(root.id);
  const authenticated = await OrganizationClient.connect(join(dir, "server.sock"), rt.token);
  clients.push(authenticated);
  const results = [];
  for (const id of batch.memberOperationIds) {
    const op = await authenticated.request<Operation>("operation.get", { operationId: id });
    expect(op.status).toBe("completed");
    expect(op.result).toBeDefined();
    results.push(op.result);
  }
  expect(results.map((result: any) => result.text)).toEqual(["done:code done", "done:tests done"]);
  // Retention pressure cannot evict completion members while the continuation is running.
  const extra: Operation = { id: crypto.randomUUID(), type: "fixture", agentId: null, input: {}, caller: { kind: "server", id: "test" }, status: "completed", createdAt: now(), completedAt: now() };
  server.organization.store.saveOperation(extra);
  server.organization.operations.set(extra.id, extra);
  server.organization.store.pruneTerminalOperations(1);
  expect(batch.memberOperationIds.every(id => server.organization.store.operations().some(op => op.id === id))).toBe(true);
  expect(server.organization.store.pinnedOperationIds().sort()).toEqual([...batch.memberOperationIds].sort());
  const continuation = await client.request<Operation>("operation.get", { operationId: batch.continuationOperationId! });
  expect(continuation.status).toBe("running");
  const generated = (continuation.input as any).text as string;
  const payload = JSON.parse(generated.slice(generated.indexOf("\n") + 1));
  expect(payload.notification).toContain("Child work has settled");
  expect(payload.outcomes).toHaveLength(2);
  expect(payload.outcomes.map((item: any) => item.status)).toEqual(["completed", "completed"]);
  expect(payload.outcomes.every((item: any) => item.resultAvailable && item.previewUntrusted === true && item.preview.text.startsWith("done:"))).toBe(true);
  expect(payload.warning).toContain("untrusted");
  expect(payload.warning).toContain("operation_get");
  expect(batchForParent().state).toBe("dispatching");
  await Bun.write(join(dir, `continuation-${parent.id}.release`), "release");
  await until(() => batchForParent().state === "dispatched");
  expect(server.organization.operations.get(batch.continuationOperationId!)?.status).toBe("completed");
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
  const capacityProbe: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: root.id, input: {}, caller: { kind: "server", id: "capacity-probe" }, status: "completed", createdAt: now(), completedAt: now() };
  expect(server.organization.store.admitCompletionOperation(capacityProbe, { parentAgentId: root.id, parentSessionId: root.sessionId!, rootOperationId: crypto.randomUUID() }, [root.id], 2)).toBe(true);
  expect(server.organization.store.history(0, 10000).events.filter(e => e.type === "completion.dispatch_started" && (e.data as any).batchId === parent.id)).toHaveLength(1);
  await Bun.sleep(30);
  expect(server.organization.store.history(0, 10000).events.filter(e => e.type === "completion.dispatch_started" && (e.data as any).batchId === parent.id)).toHaveLength(1);
});

test("generated completion payload preserves previews, outcome states, and untrusted warnings", async () => {
  const { client, server, dir } = await setup();
  const root = await create(client), child = await create(client, root.id), batchId = crypto.randomUUID();
  const identity = { parentAgentId: root.id, parentSessionId: root.sessionId!, rootOperationId: batchId };
  const specs = [
    { status: "completed" as const, result: undefined },
    { status: "completed" as const, result: { text: "partial result" } },
    { status: "failed" as const, error: { code: "FIXTURE", message: "failed result" } },
    { status: "stopped" as const },
    { status: "completed" as const, result: "large".repeat(300) },
  ];
  const ids: string[] = [];
  for (const spec of specs) {
    const op: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: child.id, input: {}, caller: { kind: "server", id: "fixture" }, status: spec.status, createdAt: now(), completedAt: now(), result: spec.result, ...(spec.error ? { error: spec.error } : {}) };
    expect(server.organization.store.admitCompletionOperation(op, identity, [child.id], 20)).toBe(true);
    server.organization.operations.set(op.id, op); ids.push(op.id);
  }
  // Model the original result aging out independently of the retained batch ledger.
  server.organization.operations.delete(ids[0]);
  server.organization.store.deleteOperation(ids[0]);
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === batchId)!;
  batch.state = "ready";
  server.organization.store.setCompletionBatch(batch);
  (server.organization as any).dispatchCompletionBatch(batch);
  const continuation = await client.wait(server.organization.operations.get(batch.continuationOperationId!)!);
  const text = (continuation.input as any).text as string;
  const payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
  expect(payload.outcomes.map((outcome: any) => [outcome.status, outcome.resultAvailable])).toEqual([
    ["completed", false], ["completed", true], ["failed", true], ["stopped", true], ["completed", true],
  ]);
  expect(payload.outcomes[0].preview).toBe("No result available");
  expect(payload.outcomes[1].previewUntrusted).toBe(true);
  expect(payload.outcomes[2].error.message).toBe("failed result");
  expect(payload.outcomes[4].preview.truncated).toBe(true);
  expect(payload.warning).toContain("untrusted");
  expect(payload.warning).toContain("operation_get");
  const runtime = (server.organization as any).runtimes.get(root.id);
  const authorized = await OrganizationClient.connect(join(dir, "server.sock"), runtime.token);
  clients.push(authorized);
  for (const [index, id] of ids.slice(1).entries()) {
    const original = await authorized.request<Operation>("operation.get", { operationId: id });
    expect(original.id).toBe(id);
    expect(original.status).toBe(specs[index + 1].status);
    if (index !== 1 && index !== 2) expect(original.result).toBeDefined();
  }
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
});

test("completion dispatch does not preempt competing parent work and restores maxPrompts capacity", async () => {
  const { client, server } = await setup({ maxPrompts: 1 });
  const root = await create(client);
  const parent = await prompt(client, root.id, "delegate-return");
  const competing = await prompt(client, root.id, "sleep:1500", true);
  await client.wait(parent);
  await until(() => server.organization.operations.get(competing.id)?.status === "running");
  const batch = () => server.organization.store.completionBatches().find(item => item.identity.rootOperationId === parent.id)!;
  await until(() => batch()?.state === "collecting");
  expect(batch().continuationOperationId).toBeUndefined();
  expect(server.organization.operations.get(competing.id)?.status).toBe("running");
  // Even an already-ready batch must wait rather than preempt active parent work.
  const ready = batch();
  ready.state = "ready";
  server.organization.store.setCompletionBatch(ready);
  (server.organization as any).dispatchCompletionBatch(ready);
  expect(batch().state).toBe("ready");
  expect(batch().continuationOperationId).toBeUndefined();
  await client.wait(competing);
  await until(() => batch().state === "dispatched");
  expect(server.organization.operations.get(batch().continuationOperationId!)?.status).toBe("completed");
});

test("continuation failure and cancellation both terminalize dispatch and release pins", async () => {
  for (const outcome of ["cancel", "fail"] as const) {
    const { client, server, dir } = await setup();
    const root = await create(client, null, { COMPLETION_BARRIER_DIR: dir, ...(outcome === "fail" ? { COMPLETION_FAIL: "1" } : {}) });
    const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
    const findBatch = () => server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)!;
    await until(() => findBatch()?.state === "dispatching");
    const continuationId = findBatch().continuationOperationId!;
    await until(() => existsSync(join(dir, `continuation-${parent.id}.started`)));
    if (outcome === "cancel") {
      await client.request("operation.cancel", { operationId: continuationId });
      await until(() => server.organization.operations.get(continuationId)?.status === "stopped");
      await Bun.write(join(dir, `continuation-${parent.id}.release`), "release");
    } else {
      await Bun.write(join(dir, `continuation-${parent.id}.release`), "release");
      await until(() => server.organization.operations.get(continuationId)?.status === "failed");
    }
    await until(() => findBatch().state === "dispatched");
    expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
    expect(findBatch().state).toBe("dispatched");
  }
});

test("ready completion batch is suppressed after recipient session replacement", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const member: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: root.id, input: {}, caller: { kind: "server", id: "session-test" }, status: "completed", createdAt: now(), completedAt: now(), result: "retained" };
  const identity = { parentAgentId: root.id, parentSessionId: root.sessionId!, rootOperationId: crypto.randomUUID() };
  expect(server.organization.store.admitCompletionOperation(member, identity, [root.id], 10)).toBe(true);
  server.organization.operations.set(member.id, member);
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === identity.rootOperationId)!;
  batch.state = "ready";
  server.organization.store.setCompletionBatch(batch);
  const recipient = server.organization.agents.get(root.id)!;
  recipient.sessionId = crypto.randomUUID();
  server.organization.store.saveAgent(recipient);
  (server.organization as any).dispatchCompletionBatch(batch);
  expect(server.organization.store.completionBatches().find(item => item.identity.rootOperationId === identity.rootOperationId)).toMatchObject({ state: "dispatched", dispatchSuppressed: true, suppressionReason: "parent-session-replaced" });
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
});

test("completion metadata pages retain stable order, compact/expanded shapes, and recipient fencing", async () => {
  const { client, server } = await setup({ maxResponseBytes: 256 });
  const root = await create(client), child = await create(client, root.id), sibling = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:300");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const identity = { parentAgentId: root.id, parentSessionId: root.sessionId!, rootOperationId: parent.id };
  const ids = [0, 1, 2].map(() => crypto.randomUUID());
  for (const id of ids) {
    const op: Operation = { id, type: "agent.prompt", agentId: child.id, input: {}, caller: { kind: "server", id: "test" }, status: "completed", createdAt: now(), completedAt: now(), result: { value: id } };
    expect(server.organization.store.admitCompletionOperation(op, identity, [child.id], 10)).toBe(true);
    server.organization.operations.set(id, op);
  }
  const rt = (server.organization as any).runtimes.get(root.id);
  const auth = { sessionId: root.sessionId!, generation: rt.generation };
  const get = (caller: any, agentAuth: any, after = 0) => server.organization.request("completion.get", { batchId: parent.id, after, limit: 1 }, caller, agentAuth) as Promise<any>;
  const page1 = await get({ kind: "agent", id: root.id }, auth);
  expect(page1).toHaveProperty("b", parent.id);
  expect(page1.i[0]).toMatchObject({ x: 0, o: ids[0], g: child.id, r: true });
  expect(Buffer.byteLength(JSON.stringify(page1))).toBeLessThanOrEqual(256);
  const page2 = await get({ kind: "agent", id: root.id }, auth, page1.n);
  const page3 = await get({ kind: "agent", id: root.id }, auth, page2.n);
  expect([page1.i[0].o, page2.i[0].o, page3.i[0].o]).toEqual(ids);
  expect(page3.n).toBeNull();
  await expect(get({ kind: "agent", id: sibling.id }, { sessionId: sibling.sessionId!, generation: (server.organization as any).runtimes.get(sibling.id).generation })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(get({ kind: "agent", id: root.id }, { ...auth, generation: "stale" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  // The batch remains available, while a pruned original member is explicitly unavailable.
  server.organization.operations.delete(ids[1]);
  server.organization.store.deleteOperation(ids[1]);
  const missing = await get({ kind: "agent", id: root.id }, auth, 1);
  expect(missing.i[0]).toMatchObject({ o: ids[1], s: "missing-or-pruned", r: false });
  await expect(server.organization.request("completion.get", { batchId: "unknown", after: 0, limit: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // At the normal budget the same endpoint returns the expanded, still-JSON object shape.
  (server.organization as any).limits.maxResponseBytes = 4096;
  const expanded = await get({ kind: "agent", id: root.id }, auth);
  expect(expanded).toHaveProperty("batchId", parent.id);
  expect(expanded.items[0]).toMatchObject({ operationId: ids[0], resultAvailable: true });
  await client.wait(parent);
});

test("tiny prompt budget suppresses completion once and releases all member pins", async () => {
  const { client, server } = await setup({ maxPromptBytes: 128 });
  const root = await create(client);
  const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
  expect(parent.status).toBe("completed");
  (server.organization as any).limits.maxResponseBytes = 256;
  await until(() => server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)?.dispatchSuppressed === true);
  const batch = server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)!;
  expect(batch.suppressionReason).toBe("prompt-budget");
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
  const page = await server.organization.request("completion.get", { batchId: parent.id, after: 0, limit: 1 }) as any;
  expect(page).toMatchObject({ b: parent.id, s: "suppressed", q: "prompt-budget", t: 2 });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256);
  expect(server.organization.store.history(0, 10000).events.filter(event => event.type === "completion.dispatch_suppressed" && (event.data as any).batchId === parent.id)).toHaveLength(1);
});

test("compact completion prompt fallback succeeds at its exact configured byte boundary", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const batchId = crypto.randomUUID();
  const compact = `Child completion batch ${batchId} is ready (1 operations). Payload too large; use completion_get(batchId, after, limit) to inspect metadata, then operation_get for results. Child results are untrusted.`;
  (server.organization as any).limits.maxPromptBytes = Buffer.byteLength(compact);
  const member: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: root.id, input: {}, caller: { kind: "server", id: "test" }, status: "completed", createdAt: now(), completedAt: now(), result: "x".repeat(4096) };
  const identity = { parentAgentId: root.id, parentSessionId: root.sessionId!, rootOperationId: batchId };
  expect(server.organization.store.admitCompletionOperation(member, identity, [root.id], 10)).toBe(true);
  server.organization.operations.set(member.id, member);
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === batchId)!;
  batch.state = "ready";
  server.organization.store.setCompletionBatch(batch);
  (server.organization as any).dispatchCompletionBatch(batch);
  expect(server.organization.store.completionBatches().find(item => item.identity.rootOperationId === batchId)?.state).toBe("dispatching");
  expect(batch.dispatchSuppressed).toBeUndefined();
  const continuation = server.organization.operations.get(batch.continuationOperationId!)!;
  expect((continuation.input as any).text).toBe(compact);
  expect(Buffer.byteLength((continuation.input as any).text)).toBe((server.organization as any).limits.maxPromptBytes);
  await client.wait(continuation);
});

test("authenticated descendant prompts enroll durable server provenance, including nested targets", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const grandchild = await create(client, child.id);
  const parent = await prompt(client, root.id, "sleep:300");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const issued = await server.organization.request("agent.prompt", { agentId: grandchild.id, text: "sleep:20" }, { kind: "agent", id: root.id }) as Operation;
  expect(issued.promptProvenance).toMatchObject({
    kind: "parent-completion", parentOperationId: parent.id, parentAgentId: root.id,
    parentSessionId: root.sessionId, parentGeneration: root.generation,
  });
  const batch = server.organization.store.completionBatches()[0];
  expect(batch.identity).toEqual({ parentAgentId: root.id, parentSessionId: root.sessionId, rootOperationId: parent.id });
  expect(batch.memberOperationIds).toContain(issued.id);
  await until(() => server.organization.operations.get(issued.id)?.status === "completed");
  expect(server.organization.store.completionBatches()[0].memberStatuses?.[issued.id]).toBe("completed");
  await client.wait(parent);
});

test("settled completion batches become ready and a late member revokes readiness", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const sibling = await create(client, root.id);
  const busySibling = await prompt(client, sibling.id, "sleep:5000");
  await until(() => server.organization.operations.get(busySibling.id)?.status === "running");
  const parent = await prompt(client, root.id, "sleep:1500");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const issue = (text: string) => server.organization.request("agent.prompt", { agentId: child.id, text }, { kind: "agent", id: root.id }) as Promise<Operation>;
  const first = await issue("sleep:10");
  await until(() => server.organization.store.completionBatches()[0]?.state === "ready");
  const second = await issue("sleep:10");
  expect(server.organization.store.completionBatches()[0]).toMatchObject({ state: "collecting", memberOperationIds: [first.id, second.id] });
  await until(() => server.organization.store.completionBatches()[0]?.state === "ready");
  await client.wait(parent);
});

test("ancestor completion readiness waits for nested batches to become terminal", async () => {
  const { client, server } = await setup();
  const a = await create(client), b = await create(client, a.id), c = await create(client, b.id);
  const activeA = await prompt(client, a.id, "sleep:1000");
  await until(() => server.organization.operations.get(activeA.id)?.status === "running");
  const add = (parent: AgentRecord, target: AgentRecord, rootOperationId: string = crypto.randomUUID()) => {
    const op: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: target.id, input: {}, caller: { kind: "server", id: "test" }, status: "completed", createdAt: now(), completedAt: now() };
    const identity = { parentAgentId: parent.id, parentSessionId: parent.sessionId!, rootOperationId };
    expect(server.organization.store.admitCompletionOperation(op, identity, [target.id], 100)).toBe(true);
    server.organization.operations.set(op.id, op);
    return identity;
  };
  const outer = add(a, b, activeA.id), inner = add(b, c);
  (server.organization as any).reconcileCompletionBatches();
  expect(server.organization.store.completionBatches().find(x => x.identity.rootOperationId === inner.rootOperationId)?.state).toBe("ready");
  expect(server.organization.store.completionBatches().find(x => x.identity.rootOperationId === outer.rootOperationId)?.state).toBe("collecting");
  const nested = server.organization.store.completionBatches().find(x => x.identity.rootOperationId === inner.rootOperationId)!;
  nested.state = "dispatched";
  server.organization.store.setCompletionBatch(nested);
  (server.organization as any).reconcileCompletionBatches();
  expect(server.organization.store.completionBatches().find(x => x.identity.rootOperationId === outer.rootOperationId)?.state).toBe("ready");
  await client.wait(activeA);
});

test("queued recursive lifecycle work on an ancestor blocks delegated readiness", async () => {
  const { client, server } = await setup();
  const ancestor = await create(client), target = await create(client, ancestor.id);
  const member: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: target.id, input: {}, caller: { kind: "server", id: "test" }, status: "completed", createdAt: now(), completedAt: now() };
  const identity = { parentAgentId: ancestor.id, parentSessionId: ancestor.sessionId!, rootOperationId: crypto.randomUUID() };
  expect(server.organization.store.admitCompletionOperation(member, identity, [target.id], 100)).toBe(true);
  server.organization.operations.set(member.id, member);
  const pending: Operation = { id: crypto.randomUUID(), type: "agent.restart_subtree", agentId: ancestor.id, input: {}, caller: { kind: "server", id: "test" }, status: "queued", createdAt: now() };
  server.organization.operations.set(pending.id, pending);
  (server.organization as any).reconcileCompletionBatches();
  expect(server.organization.store.completionBatches()[0]?.state).toBe("collecting");
  pending.status = "completed";
  (server.organization as any).reconcileCompletionBatches();
  expect(server.organization.store.completionBatches()[0]?.state).toBe("ready");
});

test("enrolled members record failed, cancelled, superseded, and stopped terminal outcomes", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:3000");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const issue = (text: string, queue = false) => server.organization.request("agent.prompt", { agentId: child.id, text, queue }, { kind: "agent", id: root.id }) as Promise<Operation>;
  const failed = await client.wait(await issue("crash"));
  expect(failed.status).toBe("failed");
  await mutate(client, "agent.restart", child.id);
  const cancelled = await issue("sleep:1000");
  await until(() => server.organization.operations.get(cancelled.id)?.status === "running");
  await client.request("operation.cancel", { operationId: cancelled.id });
  expect((await client.wait(cancelled)).status).toBe("stopped");
  const active = await issue("sleep:1000");
  await until(() => server.organization.operations.get(active.id)?.status === "running");
  const superseded = await issue("sleep:50", true);
  const replacement = await issue("sleep:20");
  expect((await client.wait(superseded)).status).toBe("stopped");
  await client.wait(active);
  await client.wait(replacement);
  const stopped = await issue("sleep:1000");
  await until(() => server.organization.operations.get(stopped.id)?.status === "running");
  await mutate(client, "agent.stop", child.id);
  expect((await client.wait(stopped)).status).toBe("stopped");
  const batch = server.organization.store.completionBatches().find(b => b.identity.rootOperationId === parent.id)!;
  for (const [op, status] of [[failed, "failed"], [cancelled, "stopped"], [superseded, "stopped"], [stopped, "stopped"]] as const)
    expect(batch.memberStatuses?.[op.id]).toBe(status);
  await client.wait(parent);
});

test("enrolled child terminal persistence failure leaves live and durable state retryable", async () => {
  const { client, server } = await setup();
  const root = await create(client), child = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:1000");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const member = await server.organization.request("agent.prompt", { agentId: child.id, text: "sleep:500" }, { kind: "agent", id: root.id }) as Operation;
  await until(() => server.organization.operations.get(member.id)?.status === "running");
  const batch = server.organization.store.completionBatches().find(b => b.identity.rootOperationId === parent.id)!;
  server.organization.store.db.exec(`CREATE TRIGGER fail_member_terminal BEFORE INSERT ON operations WHEN NEW.id='${member.id}' AND json_extract(NEW.data, '$.status')='completed' BEGIN SELECT RAISE(ABORT, 'injected terminal persistence failure'); END`);
  expect(() => (server.organization as any).finish(server.organization.operations.get(member.id), "completed", { result: "durable" })).toThrow("injected terminal persistence failure");
  expect(server.organization.operations.get(member.id)?.status).toBe("running");
  expect(server.organization.store.operations().find(op => op.id === member.id)?.status).toBe("running");
  expect(batch.memberStatuses?.[member.id]).toBe("queued");
  expect(server.organization.store.pinnedOperationIds()).toContain(member.id);
  server.organization.store.db.exec("DROP TRIGGER fail_member_terminal");
  (server.organization as any).finish(server.organization.operations.get(member.id), "completed", { result: "durable" });
  expect(server.organization.store.operations().find(op => op.id === member.id)).toMatchObject({ status: "completed", result: { result: "durable" } });
  expect(server.organization.store.completionBatches().find(b => b.identity.rootOperationId === parent.id)?.memberStatuses?.[member.id]).toBe("completed");
  expect(server.organization.store.pinnedOperationIds()).toContain(member.id);
  await client.wait(parent);
  await client.wait(member);
});

test("ACP completion timer retries an injected terminal transaction rollback", async () => {
  const { client, server } = await setup();
  const root = await create(client), child = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:1200");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const realSetBatch = server.organization.store.setCompletionBatch.bind(server.organization.store);
  let attempts = 0;
  (server.organization.store as any).setCompletionBatch = (batch: any) => {
    attempts++;
    // finishOperation has already written the terminal operation inside its transaction;
    // failing the membership update proves rollback and the ACP callback timer retry.
    if (attempts === 1) throw new Error("injected membership write failure");
    return realSetBatch(batch);
  };
  const member = await server.organization.request("agent.prompt", { agentId: child.id, text: "sleep:20" }, { kind: "agent", id: root.id }) as Operation;
  await client.wait(member);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(server.organization.store.operations().find(op => op.id === member.id)?.status).toBe("completed");
  expect(server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)?.memberStatuses?.[member.id]).toBe("completed");
  await client.wait(parent);
});

test("diagnostic event-store failure cannot strand ACP child completion or continuation pins", async () => {
  const { client, server } = await setup();
  const root = await create(client), child = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:1200");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  server.organization.store.db.exec(`CREATE TRIGGER fail_agent_error BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.type')='agent.error' BEGIN SELECT RAISE(ABORT, 'diagnostic event failure'); END`);
  const member = await server.organization.request("agent.prompt", { agentId: child.id, text: "crash" }, { kind: "agent", id: root.id }) as Operation;
  const failed = await client.wait(member);
  expect(failed.status).toBe("failed");
  expect(server.organization.store.operations().find(op => op.id === member.id)?.status).toBe("failed");
  expect(server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)?.memberStatuses?.[member.id]).toBe("failed");
  await client.wait(parent);
  await until(() => server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)?.state === "dispatched");
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === parent.id)!;
  expect(server.organization.operations.get(batch.continuationOperationId!)?.status).toBe("completed");
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
});

test("completion.ready diagnostic failure does not block dispatch or release pins", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const emit = server.organization.emit.bind(server.organization);
  let failed = false;
  (server.organization as any).emit = (type: string, ...args: any[]) => {
    if (type === "completion.ready" && !failed) { failed = true; throw new Error("injected ready event failure"); }
    return (emit as any)(type, ...args);
  };
  const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
  expect(parent.status).toBe("completed");
  await until(() => server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)?.state === "dispatched");
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === parent.id)!;
  expect(failed).toBe(true);
  expect(server.organization.operations.get(batch.continuationOperationId!)?.status).toBe("completed");
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
  expect(server.organization.store.history(0, 10000).events.filter(event => event.type === "completion.dispatch_started" && (event.data as any).batchId === parent.id)).toHaveLength(1);
});

test("continuation start persistence failure retains queue ownership and retries after storage recovers", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  server.organization.store.db.exec(`CREATE TRIGGER reject_continuation_start BEFORE INSERT ON operations WHEN json_extract(NEW.data, '$.caller.id')='server' AND json_extract(NEW.data, '$.input.text') LIKE 'Review child completion batch%' AND json_extract(NEW.data, '$.status')='running' BEGIN SELECT RAISE(ABORT, 'injected start persistence failure'); END`);
  const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
  const batchForParent = () => server.organization.store.completionBatches().find(batch => batch.identity.rootOperationId === parent.id)!;
  await until(() => batchForParent()?.state === "dispatching" && !!(server.organization as any).runtimes.get(root.id)?.startRetry);
  const continuationId = batchForParent().continuationOperationId!;
  const rt = (server.organization as any).runtimes.get(root.id);
  expect(rt.queue.some((operation: Operation) => operation.id === continuationId)).toBe(true);
  expect(server.organization.operations.get(continuationId)?.status).toBe("queued");
  expect(server.organization.store.operations().find(operation => operation.id === continuationId)?.status).toBe("queued");
  server.organization.store.db.exec("DROP TRIGGER reject_continuation_start");
  await until(() => server.organization.operations.get(continuationId)?.status === "completed");
  await until(() => batchForParent().state === "dispatched");
  expect(rt.queue.some((operation: Operation) => operation.id === continuationId)).toBe(false);
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
  expect(server.organization.store.history(0, 10000).events.filter(event => event.type === "prompt.started" && (event.data as any).operationId === continuationId)).toHaveLength(1);
});

test("prompt.finished and continuation operation.changed event failures cannot strand completion work", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  server.organization.store.db.exec(`CREATE TRIGGER reject_completion_diagnostics BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.type')='prompt.finished' OR (json_extract(NEW.data, '$.type')='operation.changed' AND json_extract(NEW.data, '$.data.caller.id')='server' AND json_extract(NEW.data, '$.data.input.text') LIKE 'Review child completion batch%') BEGIN SELECT RAISE(ABORT, 'injected completion event failure'); END`);
  const parent = await client.wait(await prompt(client, root.id, "delegate-return"));
  expect(parent.status).toBe("completed");
  await until(() => (server.organization.agents.get(root.id)?.state === "idle") && server.organization.store.completionBatches().some(batch => batch.identity.rootOperationId === parent.id && batch.state === "dispatched"));
  const batch = server.organization.store.completionBatches().find(item => item.identity.rootOperationId === parent.id)!;
  expect(batch.continuationOperationId).toBeTruthy();
  expect(server.organization.operations.get(batch.continuationOperationId!)?.status).toBe("completed");
  expect(server.organization.store.pinnedOperationIds()).toHaveLength(0);
  expect(server.organization.store.history(0, 10000).events.filter(event => event.type === "completion.dispatch_started" && (event.data as any).batchId === parent.id)).toHaveLength(1);
});

test("completion storage failure leaves queued and active prompts untouched", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const child = await create(client, root.id);
  const parent = await prompt(client, root.id, "sleep:1000");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const active = await prompt(client, child.id, "sleep:1000");
  await until(() => server.organization.operations.get(active.id)?.status === "running");
  const queued = await prompt(client, child.id, "sleep:10", true);
  server.organization.store.db.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON operations WHEN json_extract(NEW.data, '$.promptProvenance.kind')='parent-completion' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;`);
  await expect(server.organization.request("agent.prompt", { agentId: child.id, text: "replacement" }, { kind: "agent", id: root.id })).rejects.toThrow();
  expect(server.organization.operations.get(active.id)?.status).toBe("running");
  expect(server.organization.operations.get(queued.id)?.status).toBe("queued");
  expect(server.organization.store.completionBatches()).toHaveLength(0);
  server.organization.store.db.exec("DROP TRIGGER reject_completion");
  await client.wait(parent);
  await client.wait(active);
});

test("socket prompts authenticated before queued restart reject stale generation without side effects", async () => {
  const passthroughTransform: ServerPlugin = {
    apiVersion: 1,
    name: "descendant-prompt-passthrough",
    setup(host) { host.transformTool("descendant_prompt", tool => tool); },
  };
  const { client, server, dir } = await setup({}, [passthroughTransform]);
  const root = await create(client);
  const child = await create(client, root.id);
  const blocker = await create(client, root.id, { START_DELAY: "350" });
  const parentWork = await prompt(client, root.id, "sleep:1000");
  await until(() => server.organization.operations.get(parentWork.id)?.status === "running");
  const childWork = await prompt(client, child.id, "sleep:1000");
  await until(() => server.organization.operations.get(childWork.id)?.status === "running");
  const blockerRestart = await client.request<Operation>("agent.restart", { agentId: blocker.id });
  await until(() => server.organization.operations.get(blockerRestart.id)?.status === "running");
  const parentRestart = await client.request<Operation>("agent.restart", { agentId: root.id });
  const oldToken = (server.organization as any).runtimes.get(root.id).token as string;
  const agentClient = await OrganizationClient.connect(join(dir, "server.sock"), oldToken);
  clients.push(agentClient);
  const stalePrompt = await agentClient.request<any>("mcp.call", {
    name: "descendant_prompt",
    arguments: { agentId: child.id, text: "must not supersede" },
  });
  expect(stalePrompt.isError).toBe(true);
  expect(JSON.parse(stalePrompt.content[0].text).code).toBe("FORBIDDEN");
  await client.wait(parentRestart);
  expect(server.organization.operations.get(childWork.id)?.status).toBe("running");
  expect(server.organization.store.completionBatches()).toHaveLength(0);
  await client.wait(childWork);
});

test("client prompts are unattributed and completion capacity rejection has no cancellation effects", async () => {
  const { client, server } = await setup({ maxPendingCompletionOperations: 1 });
  const root = await create(client);
  const child = await create(client, root.id);
  const grandchild = await create(client, child.id);
  const childWork = await prompt(client, child.id, "sleep:500");
  await until(() => server.organization.operations.get(childWork.id)?.status === "running");
  const parent = await prompt(client, root.id, "sleep:500");
  await until(() => server.organization.operations.get(parent.id)?.status === "running");
  const enrolled = await server.organization.request("agent.prompt", { agentId: grandchild.id, text: "sleep:10" }, { kind: "agent", id: root.id }) as Operation;
  expect(enrolled.promptProvenance?.kind).toBe("parent-completion");
  await expect(server.organization.request("agent.prompt", { agentId: child.id, text: "replacement" }, { kind: "agent", id: root.id })).rejects.toMatchObject({ code: "LIMIT" });
  expect(server.organization.operations.get(childWork.id)?.status).toBe("running");
  const clientPrompt = await prompt(client, grandchild.id, "client-origin", true);
  expect(clientPrompt.promptProvenance).toBeUndefined();
  await client.wait(parent);
  await client.wait(childWork);
});

test("live filters, monotonically increasing durable events, malformed requests", async () => {
  const { client, server, dir } = await setup({ maxEvents: 15 });
  const root = await create(client);
  const child = await create(client, root.id);
  const events: ServerEvent[] = [];
  client.onEvent((e) => events.push(e));
  await client.request("subscribe", {
    types: ["agent.message", "tool.call"],
    excludeTypes: ["tool.call"],
    agentIds: [root.id],
    subtrees: true,
  });
  await client.wait(await prompt(client, child.id, "hello"));
  await Bun.sleep(10);
  expect(events.length).toBeGreaterThan(0);
  expect(
    events.every((e) => e.type === "agent.message" && e.agentId === child.id),
  ).toBe(true);
  const history = await client.request<any>("events.history");
  expect(history.events.length).toBeLessThanOrEqual(15);
  expect(history.expired).toBe(true);
  const seq = server.organization.store.sequence();
  const path = join(dir, "server.sock");
  const socket = createConnection(path);
  await new Promise<void>((r) => socket.once("connect", r));
  const reply = new Promise<any>((r) => {
    const lines = new JsonLines(10000, (s) => {
      const v = JSON.parse(s);
      if (v.kind === "response") r(v);
    });
    socket.on("data", (b) => lines.push(Buffer.from(b)));
  });
  socket.write("not-json\n");
  expect((await reply).ok).toBe(false);
  socket.destroy();
  client.close();
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const restarted = await OrganizationServer.start({
    dataDir: dir,
    socketPath: path,
    plugins: [fixture],
  });
  servers.push(restarted);
  expect(restarted.organization.store.sequence()).toBeGreaterThan(seq);
});

test("limits on depth, children, processes, prompt/response size and startup failure", async () => {
  const { client } = await setup({
    maxDepth: 1,
    maxChildren: 1,
    maxProcesses: 2,
    maxPromptBytes: 100,
    maxResponseBytes: 256,
  });
  const root = await create(client);
  const child = await create(client, root.id);
  const extra = await client.wait(
    await client.request<Operation>("agent.create", {
      parentId: root.id,
      settings: { harness: "fixture", model: "gpt-6-luna" },
    }),
  );
  expect(extra.error?.code).toBe("LIMIT");
  const deep = await client.wait(
    await client.request<Operation>("agent.create", {
      parentId: child.id,
      settings: { harness: "fixture", model: "gpt-6-luna" },
    }),
  );
  expect(deep.error?.code).toBe("LIMIT");
  expect(
    await prompt(client, root.id, "x".repeat(101)).catch((e: any) => e.code),
  ).toBe("LIMIT");
  const invalid = await client.wait(
    await client.request<Operation>("agent.create", {
      settings: { harness: "invalid", model: "gpt-6-luna" },
    }),
  );
  expect(invalid.error?.code).toBe("INVALID_HARNESS");
});

test("permission events resolve and cancellation releases pending permission", async () => {
  const { client } = await setup();
  const root = await create(client);
  let permissionId = "";
  client.onEvent((e) => {
    if (e.type === "permission.requested")
      permissionId = (e.data as any).permissionId;
  });
  const op = await prompt(client, root.id, "permission");
  await until(() => !!permissionId);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: root.id }))
      .state,
  ).toBe("waiting");
  await client.request("permission.respond", { permissionId, optionId: "yes" });
  expect((await client.wait(op)).status).toBe("completed");
  permissionId = "";
  const cancelled = await prompt(client, root.id, "permission");
  await until(() => !!permissionId);
  await client.request("operation.cancel", { operationId: cancelled.id });
  expect((await client.wait(cancelled)).status).toBe("stopped");
});

test.each([undefined, true, false])("startup interruption policy (recover=%s) handles pending work and eligible agents", async (recover) => {
  const dir = mkdtempSync(join(tmpdir(), "org-recovery-"));
  dirs.push(dir);
  const store = new Store(join(dir, "organization.sqlite"));
  const record = (id: string, parentId: string | null): AgentRecord => ({
    id,
    parentId,
    name: id,
    metadata: {},
    settings: { harness: "fixture", model: "gpt-6-luna", options: {} },
    state: "running",
    revision: 1,
    generation: "old",
    sessionId: crypto.randomUUID(),
    sessionNumber: 1,
    removedAt: null,
    createdAt: now(),
    updatedAt: now(),
  });
  store.saveAgent(record("root", null));
  store.saveAgent(record("child", "root"));
  store.saveAgent({ ...record("stopped", "root"), state: "stopped" });
  store.saveAgent({ ...record("failed", "root"), state: "failed" });
  store.saveAgent({ ...record("removed", "root"), removedAt: now() });
  store.saveOperation({
    id: "interrupted",
    caller: { kind: "client", id: "old" },
    agentId: "root",
    type: "agent.prompt",
    input: {},
    status: "running",
    createdAt: now(),
  });
  store.close();
  const server = await OrganizationServer.start({
    dataDir: dir,
    socketPath: join(dir, "server.sock"),
    plugins: [fixture],
    recover,
    limits: { stopTimeoutMs: 100 },
  });
  servers.push(server);
  expect(server.organization.operations.get("interrupted")?.error?.code).toBe(
    "INTERRUPTED",
  );
  expect(server.organization.agents.get("root")?.state).toBe(recover === false ? "stopped" : "idle");
  expect(server.organization.agents.get("child")?.state).toBe(recover === false ? "stopped" : "idle");
  expect(server.organization.agents.get("stopped")?.state).toBe("stopped");
  expect(server.organization.agents.get("failed")?.state).toBe("failed");
  expect(server.organization.agents.get("removed")?.state).toBe("running");
  const starts = server.organization.store
    .history(0, 1000)
    .events.filter(
      (e) => e.type === "agent.state" && (e.data as any).state === "starting",
    );
  expect(starts.map((e) => e.agentId)).toEqual(recover === false ? [] : ["root", "child"]);
  const ready = server.organization.store.history(0, 1000).events.find(e => e.type === "server.ready");
  expect((ready?.data as any).recover).toBe(recover !== false);
});

test("generation fencing rejects late updates and terminalizes old prompt work", async () => {
  const { client, server } = await setup();
  const root = await create(client);
  const old = await prompt(client, root.id, "sleep:500");
  await mutate(client, "agent.restart", root.id);
  expect((await client.wait(old)).status).toBe("stopped");
  const newer = await prompt(client, root.id, "sleep:50");
  (server.organization as any).update(root.id, root.generation, {
    sessionId: root.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "STALE" },
    },
  });
  const done = await client.wait(newer);
  expect(done.status).toBe("completed");
  expect((done.result as any).text).not.toContain("STALE");
});

test("queued lifecycle cancellation is immediate while another startup holds the mutation queue", async () => {
  const { client, server } = await setup();
  const root = await create(client, null, { START_DELAY: "150" });
  const restarting = await client.request<Operation>("agent.restart", {
    agentId: root.id,
  });
  await until(
    () =>
      server.organization.operations.get(restarting.id)?.status === "running",
  );
  const queued = await client.request<Operation>("agent.stop", {
    agentId: root.id,
  });
  expect(
    (
      await client.request<Operation>("operation.cancel", {
        operationId: queued.id,
      })
    ).status,
  ).toBe("stopped");
  expect(
    await client
      .request("operation.cancel", { operationId: restarting.id })
      .catch((e: any) => e.code),
  ).toBe("NOT_CANCELLABLE");
  await client.wait(restarting);
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: root.id }))
      .state,
  ).toBe("idle");
});

test("process/startup/response/queue limits fail deterministically", async () => {
  const { client, server } = await setup({
    maxProcesses: 1,
    maxQueuedPrompts: 1,
    maxResponseBytes: 512,
    startTimeoutMs: 200,
  });
  const root = await create(client);
  const extra = await client.wait(
    await client.request<Operation>("agent.create", {
      parentId: root.id,
      settings: { harness: "fixture", model: "gpt-6-luna" },
    }),
  );
  expect(extra.error?.code).toBe("LIMIT");
  expect(server.organization.agents.get(extra.agentId!)?.state).toBe("failed");
  const running = await prompt(client, root.id, "sleep:200");
  const queued = await prompt(client, root.id, "q", true);
  expect(
    await prompt(client, root.id, "q2", true).catch((e: any) => e.code),
  ).toBe("LIMIT");
  await client.wait(running);
  await client.wait(queued);
  const long = await client.wait(
    await prompt(client, root.id, "x".repeat(1000)),
  );
  expect(Buffer.byteLength(JSON.stringify(long.result))).toBeLessThanOrEqual(
    512,
  );
  await mutate(client, "agent.stop", root.id);
  const slow = await client.wait(
    await client.request<Operation>("agent.modify", {
      agentId: root.id,
      settings: { env: { START_DELAY: "1000" } },
    }),
  );
  expect(slow.status).toBe("completed");
  const failed = await mutate(client, "agent.restart", root.id);
  expect(failed.status).toBe("failed");
  expect(
    (await client.request<AgentRecord>("agent.get", { agentId: root.id }))
      .state,
  ).toBe("failed");
});

test("second server cannot share a database and regular socket-path files are never deleted", async () => {
  const { dir, server } = await setup();
  await expect(
    OrganizationServer.start({
      dataDir: dir,
      socketPath: join(dir, "other.sock"),
      plugins: [fixture],
    }),
  ).rejects.toThrow("already running");
  expect(server.organization.store.sequence()).toBeGreaterThan(0);
  const otherDir = mkdtempSync(join(tmpdir(), "org-existing-"));
  dirs.push(otherDir);
  const file = join(otherDir, "server.sock");
  await Bun.write(file, "keep");
  await expect(
    OrganizationServer.start({
      dataDir: otherDir,
      socketPath: file,
      plugins: [fixture],
    }),
  ).rejects.toThrow("exists");
  expect(await Bun.file(file).text()).toBe("keep");
});

test("plugin hooks/endpoints/tools and incompatible versions", async () => {
  const observed: string[] = [];
  const plugin: ServerPlugin = {
    apiVersion: 1,
    name: "test-plugin",
    setup(host) {
      host.onEvent((e) => {
        observed.push(e.type);
      });
      host.beforeLaunch((spec) => ({
        ...spec,
        env: { ...spec.env, CUSTOM: "yes" },
      }));
      host.registerEndpoint("custom.echo", (p) => p);
      host.registerEndpoint("custom.fail", () => {
        throw new Error("isolated");
      });
      host.registerTool({
        name: "custom_echo",
        description: "Echo",
        inputSchema: { type: "object" },
        execute: (args) => args,
      });
    },
  };
  const { client, server } = await setup({}, [plugin]);
  expect(
    await client.request<{ value: number }>("custom.echo", { value: 1 }),
  ).toEqual({ value: 1 });
  expect(await client.request("custom.fail").catch((e: any) => e.message)).toBe(
    "test-plugin: isolated",
  );
  await create(client);
  expect(observed).toContain("agent.created");
  await expect(
    server.organization.use({ apiVersion: 2, name: "bad", setup() {} } as any),
  ).rejects.toThrow("unsupported");
});
