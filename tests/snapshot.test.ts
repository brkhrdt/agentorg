import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

test("agent snapshots select adjacent records and export a complete safe metadata report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-export-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "metadata-fixture", setup(host) {
    host.registerSettings({ namespace: "public-fixture", validate: value => value, snapshotMetadata(value) { const v = value as any; return { directoryGrants: { readOnly: v.readOnly, readWrite: v.readWrite }, skills: v.skills }; } });
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const create = async (parentId?: string, settings: any = {}) => (await client.wait(await client.request<Operation>("agent.create", { parentId, settings: { harness: "fixture", cwd: workspace, ...settings } }))).result as AgentRecord;
    const caller = await create(undefined, { env: { SECRET_TEST: "never-export" }, options: { secret: "never-export" } });
    const child = await create(caller.id, { extensions: { "public-fixture": { readOnly: ["/docs"], readWrite: ["/work"], skills: ["review"] } } });
    const grandchild = await create(child.id);
    const agent = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(agent);
    const compact: any = await agent.request("organization.snapshot", {});
    expect(compact).toEqual({ parent: null, subagents: [{ agentId: child.id, name: child.name }] });
    expect(compact.subagents.map((agent: any) => agent.agentId)).not.toContain(caller.id);
    expect(compact).not.toHaveProperty("operations");
    expect(compact).not.toHaveProperty("parentId");
    const reportPath = join(workspace, "report.json");
    writeFileSync(reportPath, "x".repeat(10000));
    const exported: any = await agent.request("organization.snapshot", { path: reportPath });
    expect(exported.parent).toEqual(compact.parent);
    expect(exported.subagents).toEqual(compact.subagents);
    expect(exported.export.agentCount).toBe(1);
    const raw = readFileSync(reportPath, "utf8");
    expect(raw.endsWith("\\n")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(raw)).toBe(statSync(reportPath).size);
    const report = JSON.parse(raw);
    expect(report.parent).toBeNull();
    expect(report.subagents.map((a: any) => a.agentId)).toEqual([child.id]);
    expect(report.subagents[0]).not.toHaveProperty("parentId");
    expect(report.subagents[0].extensions["public-fixture"]).toEqual({ availability: "available", metadata: { directoryGrants: { readOnly: ["/docs"], readWrite: ["/work"] }, skills: ["review"] } });
    expect(raw).not.toContain("never-export");
    server.organization.limits.maxSnapshotReportBytes = 128;
    await expect(agent.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "LIMIT" });
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    server.organization.limits.maxSnapshotReportBytes = 16 * 1024 * 1024;
    await expect(agent.request("organization.snapshot", { path: "bad\0path" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(agent.request("organization.snapshot", { path: "   " })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(agent.request("organization.snapshot", { path: "../escape.json" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.request("organization.snapshot", { path: "missing/report.json" })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    expect(grandchild.id).not.toBe(child.id);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("container execution denies host-side snapshot export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-sandbox-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "container-fixture", setup(host) {
    host.prepareLaunch(context => { context.executionEnvironment = "container"; });
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const caller = (await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture", cwd: workspace } }))).result as AgentRecord;
    const agent = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(agent);
    expect(await agent.request<any>("organization.snapshot", {})).toEqual({ parent: null, subagents: [] });
    await expect(agent.request("organization.snapshot", { path: "report.json" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
    expect(rootLite.parent).toBeNull();
    expect(rootLite.subagents.map((agent: any) => agent.agentId)).toEqual([child.id, sibling.id]);
    const childClient = await connect(tokens.get(child.id));
    const childLite: any = JSON.parse((await childClient.request<any>("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } })).content[0].text);
    expect(childLite.parent.agentId).toBe(root.id);
    expect(childLite.subagents).toEqual([]);
    const siblingClient = await connect(tokens.get(sibling.id));
    const siblingLite: any = JSON.parse((await siblingClient.request<any>("mcp.call", { name: "snapshot_organization", arguments: { includeTerminalOperations: false } })).content[0].text);
    expect(siblingLite.parent.agentId).toBe(root.id);
    expect(siblingLite.subagents).toEqual([]);
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
    expect(JSON.parse(mcp.content[0].text)).toEqual({ parent: null, subagents: [] });
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
