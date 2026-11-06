import { tsxImport } from "./runtime.ts";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import { CLIENT_MAX_RESPONSE_LINE_BYTES } from "../src/jsonl.ts";
import { responseRecordByteLength } from "../src/server.ts";
import { now, type AgentRecord, type Operation } from "../src/types.ts";

test("response envelope byte accounting includes escaping exactly at the client record limit", () => {
  const response: any = { content: [{ type: "text", text: "\0".repeat(2_000_000) }] };
  const current = responseRecordByteLength("request-id", response);
  expect(current).toBeLessThan(CLIENT_MAX_RESPONSE_LINE_BYTES);
  response.content[0].text += "a".repeat(CLIENT_MAX_RESPONSE_LINE_BYTES - current);
  expect(responseRecordByteLength("request-id", response)).toBe(CLIENT_MAX_RESPONSE_LINE_BYTES);
  response.content[0].text += "a";
  expect(responseRecordByteLength("request-id", response)).toBe(CLIENT_MAX_RESPONSE_LINE_BYTES + 1);
});

test("escaping-heavy MCP export preflights the fixed client cap before overwriting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-response-cap-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "response-cap-fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  const reportPath = join(workspace, "boundary.json");
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const caller = (await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture", cwd: workspace } }))).result as AgentRecord;
    const agent = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(agent);
    const org = server.organization as any;
    org.limits.maxResponseBytes = 64 * 1024 * 1024;
    org.limits.maxSnapshotReportBytes = 64 * 1024 * 1024;
    org.limits.maxClientBufferBytes = 32 * 1024 * 1024;
    org.limits.maxLineBytes = 32 * 1024 * 1024;
    writeFileSync(reportPath, "previous report must survive");
    const escapedName = "\0".repeat(256);
    const children: string[] = [];
    for (let i = 0; i < 9020; i++) {
      const id = crypto.randomUUID();
      children.push(id);
      org.agents.set(id, { ...structuredClone(caller), id, parentId: caller.id, name: escapedName, state: "stopped", generation: null, removedAt: null });
    }
    const tooLarge: any = await agent.request("mcp.call", { name: "snapshot_organization", arguments: { path: "boundary.json" } });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.content[0].text).toContain("LIMIT");
    expect(readFileSync(reportPath, "utf8")).toBe("previous report must survive");
    for (const id of children.slice(9000)) org.agents.delete(id);
    const nearLimit: any = await agent.request("mcp.call", { name: "snapshot_organization", arguments: { path: "boundary.json" } });
    expect(nearLimit.isError).not.toBe(true);
    const actualRecordBytes = responseRecordByteLength("0".repeat(36), nearLimit);
    expect(actualRecordBytes).toBeLessThanOrEqual(CLIENT_MAX_RESPONSE_LINE_BYTES);
    expect(CLIENT_MAX_RESPONSE_LINE_BYTES - actualRecordBytes).toBeLessThan(64 * 1024);
    expect(readFileSync(reportPath, "utf8")).not.toBe("previous report must survive");
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("agent snapshots select adjacent records and export a complete safe metadata report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-export-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "metadata-fixture", setup(host) {
    host.registerSettings({ namespace: "public-fixture", validate: value => value, snapshotMetadata(value) { const v = value as any; return { directoryGrants: { readOnly: v.readOnly, readWrite: v.readWrite }, skills: v.skills }; } });
    host.registerSettings({ namespace: "private-fixture", validate: value => value });
    host.registerSettings({ namespace: "invalid-fixture", validate: value => value, snapshotMetadata() { const cyclic: any = {}; cyclic.self = cyclic; return cyclic; } });
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const create = async (parentId?: string, settings: any = {}, metadata: any = {}) => (await client.wait(await client.request<Operation>("agent.create", { parentId, metadata, settings: { harness: "fixture", cwd: workspace, ...settings } }))).result as AgentRecord;
    const parent = await create(undefined, { env: { SELECTED_PARENT_ENV_SECRET: "parent-env-private" }, options: { secret: "SELECTED_PARENT_OPTION_SECRET" }, extensions: { "private-fixture": { credential: "SELECTED_PARENT_EXTENSION_SECRET" } } }, { sentinel: "SELECTED_PARENT_METADATA_SECRET" });
    const caller = await create(parent.id, { env: { SECRET_TEST: "caller-secret" }, options: { secret: "caller-secret" } });
    const child = await create(caller.id, { env: { SELECTED_CHILD_ENV_SECRET: "child-env-private" }, options: { secret: "SELECTED_CHILD_OPTION_SECRET" }, extensions: { "public-fixture": { readOnly: ["/docs"], readWrite: ["/work"], skills: ["review"] }, "private-fixture": { credential: "SELECTED_CHILD_EXTENSION_SECRET" } } }, { sentinel: "SELECTED_CHILD_METADATA_SECRET" });
    const grandchild = await create(child.id);
    const agent = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(agent);
    const compact: any = await agent.request("organization.snapshot", {});
    expect(compact).toEqual({ parent: { agentId: parent.id, name: parent.name }, subagents: [{ agentId: child.id, name: child.name }] });
    expect(compact.subagents.map((agent: any) => agent.agentId)).not.toContain(caller.id);
    expect(compact).not.toHaveProperty("operations");
    expect(compact).not.toHaveProperty("parentId");
    const reportPath = join(workspace, "report.json");
    writeFileSync(reportPath, "x".repeat(10000));
    const exported: any = await agent.request("organization.snapshot", { path: reportPath });
    expect(exported.parent).toEqual(compact.parent);
    expect(exported.subagents).toEqual(compact.subagents);
    expect(exported.export.agentCount).toBe(2);
    const raw = readFileSync(reportPath, "utf8");
    expect(raw.endsWith("\\n")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(raw)).toBe(statSync(reportPath).size);
    const report = JSON.parse(raw);
    expect(report.parent.agentId).toBe(parent.id);
    expect(report.subagents.map((a: any) => a.agentId)).toEqual([child.id]);
    expect(report.subagents[0]).not.toHaveProperty("parentId");
    expect(report.subagents[0].extensions["public-fixture"]).toEqual({ availability: "available", metadata: { directoryGrants: { readOnly: ["/docs"], readWrite: ["/work"] }, skills: ["review"] } });
    expect(report.parent.extensions["private-fixture"]).toMatchObject({ availability: "unavailable" });
    expect(report.subagents[0].extensions["private-fixture"]).toMatchObject({ availability: "unavailable" });
    for (const secret of ["parent-env-private", "SELECTED_PARENT_OPTION_SECRET", "SELECTED_PARENT_EXTENSION_SECRET", "SELECTED_PARENT_METADATA_SECRET", "child-env-private", "SELECTED_CHILD_OPTION_SECRET", "SELECTED_CHILD_EXTENSION_SECRET", "SELECTED_CHILD_METADATA_SECRET", "caller-secret"])
      expect(raw).not.toContain(secret);
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(workspace, "linked"), "dir");
    await expect(agent.request("organization.snapshot", { path: "linked/escape.json" })).rejects.toMatchObject({ code: "INVALID_PATH" });
    server.organization.agents.get(child.id)!.settings.extensions!["invalid-fixture"] = {};
    await expect(agent.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "METADATA_INVALID" });
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    delete server.organization.agents.get(child.id)!.settings.extensions!["invalid-fixture"];
    server.organization.limits.maxSnapshotReportBytes = 128;
    await expect(agent.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "LIMIT" });
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    server.organization.limits.maxSnapshotReportBytes = 16 * 1024 * 1024;
    server.organization.limits.maxClientBufferBytes = 700;
    const oversizedPath = "x".repeat(1000) + ".json";
    await expect(agent.request("organization.snapshot", { path: oversizedPath })).rejects.toMatchObject({ code: "LIMIT" });
    const mcpBoundary: any = await agent.request("mcp.call", { name: "snapshot_organization", arguments: { path: oversizedPath } });
    expect(mcpBoundary.isError).toBe(true);
    expect(mcpBoundary.content[0].text).toContain("LIMIT");
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    server.organization.limits.maxClientBufferBytes = 4 * 1024 * 1024;
    await expect(agent.request("organization.snapshot", { path: "bad\0path" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(agent.request("organization.snapshot", { path: "   " })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(agent.request("organization.snapshot", { path: "../escape.json" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.request("organization.snapshot", { path: "missing/report.json" })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(readFileSync(reportPath, "utf8")).toBe(raw);
    expect(grandchild.id).not.toBe(child.id);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an implicit server-default cwd does not authorize agent snapshot export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-implicit-cwd-"));
  const tokens = new Map<string, string>();
  const plugins = [{ apiVersion: 1 as const, name: "cwd-fixture", setup(host: any) {
    host.registerHarness({ name: "fixture", launch(context: any) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
  } }];
  let server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins });
  const clients: OrganizationClient[] = [];
  const workspace = join(dir, "explicit-workspace"); mkdirSync(workspace);
  const reportPath = `snapshot-implicit-cwd-${crypto.randomUUID()}.json`;
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const caller = (await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture" } }))).result as AgentRecord;
    expect(caller.settings.cwd).toBe(process.cwd());
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(false);
    const agent = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(agent);
    await expect(agent.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(join(process.cwd(), reportPath))).toBe(false);
    await client.wait(await client.request<Operation>("agent.modify", { agentId: caller.id, settings: { model: "fixture-model" } }));
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(false);
    await client.wait(await client.request<Operation>("agent.restart", { agentId: caller.id }));
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(false);
    agent.close();
    const refreshed = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(refreshed);
    await expect(refreshed.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "FORBIDDEN" });
    clients.forEach(client => client.close()); clients.length = 0;
    await server.close();
    server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins });
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(false);
    const afterRestart = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(afterRestart);
    await afterRestart.wait(await afterRestart.request<Operation>("agent.restart", { agentId: caller.id }));
    const capability = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(capability);
    expect(await capability.request<any>("organization.snapshot", {})).toEqual({ parent: null, subagents: [] });
    await expect(capability.request("organization.snapshot", { path: reportPath })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(false);
    await afterRestart.wait(await afterRestart.request<Operation>("agent.modify", { agentId: caller.id, settings: { cwd: workspace } }));
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(true);
    capability.close();
    const explicitCapability = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(explicitCapability);
    const explicitPath = join(workspace, "explicit.json");
    await explicitCapability.request("organization.snapshot", { path: explicitPath });
    expect(existsSync(explicitPath)).toBe(true);
    clients.forEach(client => client.close()); clients.length = 0;
    await server.close();
    server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins });
    expect(server.organization.store.cwdWasExplicit(caller.id)).toBe(true);
    const afterExplicitRestart = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(afterExplicitRestart);
    await afterExplicitRestart.wait(await afterExplicitRestart.request<Operation>("agent.restart", { agentId: caller.id }));
    const afterExplicitCapability = await OrganizationClient.connect(join(dir, "server.sock"), tokens.get(caller.id)); clients.push(afterExplicitCapability);
    const postRestartPath = join(workspace, "explicit-after-restart.json");
    await afterExplicitCapability.request("organization.snapshot", { path: postRestartPath });
    expect(existsSync(postRestartPath)).toBe(true);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot exports reject protected data and socket paths inside caller cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-protected-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const dataDir = join(workspace, ".server-data"), socketPath = join(workspace, "server.sock");
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir, socketPath, plugins: [{ apiVersion: 1, name: "protected-fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  try {
    const client = await OrganizationClient.connect(socketPath); clients.push(client);
    const caller = (await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture", cwd: workspace } }))).result as AgentRecord;
    const agent = await OrganizationClient.connect(socketPath, tokens.get(caller.id)); clients.push(agent);
    const dbPath = join(dataDir, "organization.sqlite"), dbBefore = readFileSync(dbPath);
    await expect(agent.request("organization.snapshot", { path: ".server-data/organization.sqlite" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readFileSync(dbPath)).toEqual(dbBefore);
    await expect(agent.request("organization.snapshot", { path: "server.sock" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(lstatSync(socketPath).isSocket()).toBe(true);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("scoped snapshots omit removed parents/children but retain stopped and failed direct records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-states-"));
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "state-fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(context) { return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
  } }] });
  const clients: OrganizationClient[] = [];
  try {
    const client = await OrganizationClient.connect(join(dir, "server.sock")); clients.push(client);
    const create = async (parentId?: string) => (await client.wait(await client.request<Operation>("agent.create", { parentId, settings: { harness: "fixture" } }))).result as AgentRecord;
    const removedParent = await create();
    const caller = await create(removedParent.id);
    const stopped = await create(caller.id), failed = await create(caller.id), removedChild = await create(caller.id);
    const grandchild = await create(stopped.id);
    await client.wait(await client.request<Operation>("agent.stop", { agentId: stopped.id }));
    await client.wait(await client.request<Operation>("agent.stop", { agentId: failed.id }));
    server.organization.agents.get(failed.id)!.state = "failed";
    server.organization.agents.get(removedParent.id)!.removedAt = now();
    server.organization.agents.get(removedChild.id)!.removedAt = now();
    const snapshot: any = await server.organization.request("organization.snapshot", {}, { kind: "agent", id: caller.id });
    expect(snapshot.parent).toBeNull();
    expect(snapshot.subagents.map((agent: any) => agent.agentId)).toEqual([stopped.id, failed.id]);
    expect(snapshot.subagents.map((agent: any) => agent.agentId)).not.toContain(caller.id);
    expect(snapshot.subagents.map((agent: any) => agent.agentId)).not.toContain(grandchild.id);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("container execution denies host-side snapshot export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-sandbox-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "container-fixture", setup(host) {
    host.prepareLaunch(context => { context.executionEnvironment = "container"; });
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
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
    host.registerHarness({ name: "fixture", launch(context) { tokens.set(context.agent.id, context.token); return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }; } });
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
        return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] };
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
