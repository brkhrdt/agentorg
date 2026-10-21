import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

test("completion pins stay out of lightweight snapshots while active descendant work remains authorized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-completion-"));
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "snapshot-fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  const connect = async (token?: string) => { const client = await OrganizationClient.connect(join(dir, "server.sock"), token); clients.push(client); return client; };
  try {
    const client = await connect();
    const create = async (parentId?: string) => (await client.wait(await client.request<Operation>("agent.create", { parentId, settings: { harness: "fixture" } }))).result as AgentRecord;
    const root = await create(), child = await create(root.id), sibling = await create(root.id);
    const batchId = crypto.randomUUID();
    const pinned: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: child.id, input: { text: "private terminal body" }, caller: { kind: "server", id: "fixture" }, status: "completed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), result: { text: "pinned result" } };
    expect(server.organization.store.admitCompletionOperation(pinned, { parentAgentId: root.id, parentSessionId: root.sessionId, rootOperationId: batchId }, [child.id], 4)).toBe(true);
    server.organization.operations.set(pinned.id, pinned);
    const continuation: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: child.id, input: { text: `Review child completion batch ${batchId}` }, caller: { kind: "server", id: "server" }, status: "running", createdAt: new Date().toISOString() };
    server.organization.store.saveOperation(continuation); server.organization.operations.set(continuation.id, continuation);
    const interrupted: Operation = { id: crypto.randomUUID(), type: "agent.prompt", agentId: child.id, input: { text: "old continuation" }, caller: { kind: "server", id: "server" }, status: "interrupted", createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    server.organization.store.saveOperation(interrupted); server.organization.operations.set(interrupted.id, interrupted);
    const batch = server.organization.store.completionBatches()[0]!; batch.state = "dispatching"; batch.continuationOperationId = continuation.id; server.organization.store.setCompletionBatch(batch);

    const lite: any = await client.request("organization.snapshot", { includeTerminalOperations: false });
    expect(lite.operations.map((op: Operation) => op.id)).toContain(continuation.id);
    expect(lite.operations.map((op: Operation) => op.id)).not.toContain(pinned.id);
    expect(lite.operations.map((op: Operation) => op.id)).not.toContain(interrupted.id);
    expect(lite).not.toHaveProperty("completionBatches");
    const full: any = await client.request("organization.snapshot");
    expect(full.operations.map((op: Operation) => op.id)).toContain(pinned.id);
    expect(full.operations.map((op: Operation) => op.id)).toContain(interrupted.id);
    expect(full.operations.find((op: Operation) => op.id === interrupted.id)?.status).toBe("interrupted");
    expect(full).not.toHaveProperty("completionBatches");

    const rootClient = await connect(tokens.get(root.id));
    const rootLite: any = JSON.parse((await rootClient.request<any>("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } })).content[0].text);
    expect(rootLite.operations.map((op: Operation) => op.id)).toContain(continuation.id);
    const childClient = await connect(tokens.get(child.id));
    const childLite: any = JSON.parse((await childClient.request<any>("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } })).content[0].text);
    expect(childLite.operations.map((op: Operation) => op.id)).not.toContain(continuation.id);
    const siblingClient = await connect(tokens.get(sibling.id));
    const siblingLite: any = JSON.parse((await siblingClient.request<any>("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } })).content[0].text);
    expect(siblingLite.operations.map((op: Operation) => op.id)).not.toContain(continuation.id);
    const page = await client.request<any>("completion.get", { batchId, after: 0, limit: 1 });
    expect(page.items?.[0]?.operationId ?? page.i?.[0]?.o).toBe(pinned.id);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("lightweight snapshots retain active operations without resending terminal prompt bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-"));
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({
    dataDir: dir, socketPath: join(dir, "server.sock"), limits: { maxClientBufferBytes: 32768 },
    plugins: [{ apiVersion: 1, name: "fixture", setup(host) {
      host.registerHarness({ name: "fixture", launch(context) {
        tokens.set(context.agent.id, context.token);
        return { command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] };
      } });
    } }],
  });
  const clients: OrganizationClient[] = [];
  const connect = async (token?: string) => {
    const client = await OrganizationClient.connect(join(dir, "server.sock"), token);
    clients.push(client);
    return client;
  };
  try {
    const client = await connect();
    const created = await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture" } }));
    const root = created.result as AgentRecord;
    for (let i = 0; i < 8; i++) {
      const prompt = await client.wait(await client.request<Operation>("agent.prompt", { agentId: root.id, text: "x".repeat(6000) }));
      expect(prompt.status).toBe("completed");
    }
    const full: any = await server.organization.request("organization.snapshot");
    expect(full.operations.filter((op: Operation) => op.status === "completed")).toHaveLength(9);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(32768);
    const pending = await client.request<Operation>("agent.prompt", { agentId: root.id, text: "sleep:300", queue: true });
    const snapshots: any[] = await Promise.all([0, 1].map(() => client.request("organization.snapshot", { includeTerminalOperations: false })));
    for (const snapshot of snapshots) {
      expect(snapshot.agents.map((agent: AgentRecord) => agent.id)).toEqual([root.id]);
      expect(snapshot.operations.map((op: Operation) => op.id)).toEqual([pending.id]);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(32768);
    }
    const agentClient = await connect(tokens.get(root.id));
    const mcp: any = await agentClient.request("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } });
    // Agent callers still cannot manage/read the client's operation on themselves.
    expect(JSON.parse(mcp.content[0].text).operations).toEqual([]);
    await expect(client.request("organization.snapshot", { includeTerminalOperations: "false" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const probe = await connect();
    await expect(probe.request("organization.snapshot")).rejects.toThrow("socket closed");
    expect((await client.wait(pending)).status).toBe("completed");
    expect((await client.request<any>("organization.snapshot", { includeTerminalOperations: false })).operations).toEqual([]);
  } finally {
    clients.forEach(client => client.close());
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
