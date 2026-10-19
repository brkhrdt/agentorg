import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
