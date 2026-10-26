import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../src/organization.ts";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import { ApiError, defaults, type Operation, type ServerEvent } from "../src/types.ts";
import type { ServerSettingsDefinition, ServerSettingsView } from "../src/plugin.ts";

const client = { kind: "client", id: "test" } as const;
const temp = () => mkdtempSync(join(tmpdir(), "server-settings-"));
const open = (dir: string, limits = {}) => new Organization(join(dir, "server.sock"), dir, limits);
const get = (org: Organization, namespace = "core") => org.request("organization.settings.get", { namespace }, client) as Promise<ServerSettingsView>;
const update = (org: Organization, expectedRevision: number, patch = {}, reset: string[] = [], namespace = "core") => org.request("organization.settings.update", { namespace, expectedRevision, patch, reset }, client) as Promise<ServerSettingsView>;
const definition = (version = 1): ServerSettingsDefinition => ({
  namespace: "demo", title: "Demo public settings", version,
  defaults: { enabled: true, mode: "safe", entries: [{ id: "one" }], labels: {}, workers: 1 },
  fields: [
    { key: "enabled", label: "Enabled", editor: "boolean", effect: "immediate" },
    { key: "mode", label: "Mode", editor: "select", choices: ["safe", "fast"], effect: "restart" },
    { key: "entries", label: "Entries", editor: "list", effect: "future-launch" },
    { key: "labels", label: "Labels", editor: "string-map", effect: "immediate" },
    { key: "workers", label: "Workers", editor: "number", min: 1, max: 10, effect: "future-launch" },
  ],
  validate(value) {
    if (!(value.entries as any[]).every(entry => entry && typeof entry.id === "string")) throw new ApiError("INVALID_PARAMS", "Each entry needs an ID");
    return value;
  },
});

test("core descriptors, shared reads, safe validation and client-only authorization", async () => {
  const dir = temp(), org = open(dir);
  try {
    const snapshot = await org.request("organization.snapshot", {}, client) as any;
    expect(snapshot.capabilities.serverSettings.version).toBe(1);
    expect(snapshot.capabilities.serverSettings.groups[0].fields).toHaveLength(Object.keys(defaults).length);
    expect(defaults.maxPendingCompletionOperations).toBe(1024);
    const completionLimit = snapshot.capabilities.serverSettings.groups[0].fields.find((field: any) => field.key === "maxPendingCompletionOperations");
    expect(completionLimit).toMatchObject({ editor: "number", min: 1, effect: "immediate" });
    expect(completionLimit.description).toContain("entire server");
    expect(JSON.stringify(snapshot.capabilities.serverSettings)).not.toContain('"values"');
    const catalog = await org.request("organization.settings.list", {}, client) as any;
    expect(catalog.facts.dataDir).toBe(dir);
    expect(catalog.groups[0].values).toEqual(defaults);
    const agent = { kind: "agent", id: "unprivileged" } as const;
    for (const method of ["list", "get", "update"]) await expect(org.request(`organization.settings.${method}`, {}, agent)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(org.request("organization.snapshot", {}, agent)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const patch of [{ maxDepth: 0 }, { maxDepth: 1.1 }, { maxDepth: Number.MAX_SAFE_INTEGER + 1 }, { maxResponseBytes: 255 }, { maxPendingCompletionOperations: 0 }, { secret: "never save" }]) {
      await expect(update(org, 0, patch)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
    await expect(update(org, 0, { maxDepth: 2 }, ["maxDepth"])).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(update(org, 0, {}, ["secret"])).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect((await get(org)).revision).toBe(0);
    expect(org.store.serverSettings("core")).toBeUndefined();
    expect(org.store.history(0, 100).events).toHaveLength(0);
    snapshot.capabilities.serverSettings.groups[0].fields[0].label = "tampered";
    catalog.groups[0].values.maxDepth = 999;
    expect((await get(org)).values.maxDepth).toBe(defaults.maxDepth);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("persisted overrides beat operator defaults; reset is durable and restart indicators are accurate", async () => {
  const dir = temp(); let org = open(dir, { maxDepth: 12 });
  try {
    const view = await update(org, 0, { maxDepth: 3, maxLineBytes: 4096 });
    expect(view.revision).toBe(1);
    expect(view.defaults.maxDepth).toBe(12);
    expect(view.restartRequired).toEqual(["maxLineBytes"]);
    expect(org.limits.maxDepth).toBe(3);
    expect(org.limits.maxLineBytes).toBe(defaults.maxLineBytes);
    await org.close(); org = open(dir, { maxDepth: 14 });
    expect(org.limits.maxDepth).toBe(3);
    expect(org.limits.maxLineBytes).toBe(4096);
    expect((await get(org)).restartRequired).toEqual([]);
    const reset = await update(org, 1, {}, ["maxDepth", "maxLineBytes"]);
    expect(reset.values.maxDepth).toBe(14);
    expect(reset.overridden).toEqual([]);
    expect(reset.restartRequired).toEqual(["maxLineBytes"]);
    await org.close(); org = open(dir, { maxDepth: 15 });
    expect(org.limits.maxDepth).toBe(15);
    expect(org.limits.maxLineBytes).toBe(defaults.maxLineBytes);
    expect((await get(org)).revision).toBe(2);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent clients are fenced; settings and events commit atomically with no-op saves", async () => {
  const dir = temp(), org = open(dir);
  try {
    const observed: ServerEvent[] = [];
    org.subscribe(event => { if (event.type === "organization.settings.changed") { expect(org.limits.maxDepth).toBe(3); observed.push(event); } });
    const results = await Promise.allSettled([update(org, 0, { maxDepth: 3 }), update(org, 0, { maxDepth: 4 })]);
    expect(results[0].status).toBe("fulfilled");
    expect((results[1] as PromiseRejectedResult).reason.code).toBe("CONFLICT");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.data).toEqual({ namespace: "core", revision: 1, changedKeys: ["maxDepth"], restartRequired: [] });
    expect((await update(org, 1, { maxDepth: 3 })).revision).toBe(1);
    expect(observed).toHaveLength(1);
    org.store.db.exec("CREATE TRIGGER reject_settings_event BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.type')='organization.settings.changed' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    await expect(update(org, 1, { maxDepth: 5 })).rejects.toThrow("fixture failure");
    expect(org.limits.maxDepth).toBe(3);
    expect(org.store.serverSettings("core")!.revision).toBe(1);
    expect((await get(org)).revision).toBe(1);
    expect(org.store.sequence()).toBe(1);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("plugins opt in with public declarations, defaults, normalization, list deletion and effects", async () => {
  const dir = temp(); let org = open(dir);
  try {
    const def = definition();
    await org.use({ name: "demo-owner", apiVersion: 1, setup(host) { host.registerServerSettings(def); } });
    def.defaults.enabled = false; def.fields[0]!.label = "mutated";
    expect((await get(org, "demo")).defaults.enabled).toBe(true);
    expect((await get(org, "demo")).plugin).toBe("demo-owner");
    await expect(update(org, 0, { mode: "invalid" }, [], "demo")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(update(org, 0, { workers: 11 }, [], "demo")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(update(org, 0, { entries: [{ token: "not public" }] }, [], "demo")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const view = await update(org, 0, { enabled: false, mode: "fast", entries: [] }, [], "demo");
    expect(view.values.entries).toEqual([]);
    expect(org.serverSettings("demo")).toEqual({ enabled: false, mode: "safe", entries: [], labels: {}, workers: 1 });
    expect(view.restartRequired).toEqual(["mode"]);
    const copy = org.serverSettings("demo"); copy.enabled = true;
    expect(org.serverSettings("demo").enabled).toBe(false);
    await org.close(); org = open(dir);
    // Disabling a plugin preserves its records but hides mutation/discovery.
    await expect(get(org, "demo")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(org.store.serverSettings("demo")!.overrides.entries).toEqual([]);
    org.registerServerSettings(definition());
    expect(org.serverSettings("demo").mode).toBe("fast");
    expect((await get(org, "demo")).restartRequired).toEqual([]);
    await update(org, 1, {}, ["entries", "mode"], "demo");
    expect((await get(org, "demo")).values.entries).toEqual([{ id: "one" }]);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("declarations exclude secret/undeclared fields and migrations retain revision fences", async () => {
  const dir = temp(); let org = open(dir);
  try {
    expect(() => org.registerServerSettings({ ...definition(), defaults: { ...definition().defaults, secret: "credential" } })).toThrow("Unknown server setting secret");
    expect(() => org.registerServerSettings({ ...definition(), fields: [{ ...definition().fields[0]!, sensitive: true } as any] })).toThrow();
    expect(() => org.registerServerSettings({ ...definition(), fields: [definition().fields[0]!, definition().fields[0]!] })).toThrow("Duplicate");
    org.registerServerSettings(definition());
    await update(org, 0, { workers: 3 }, [], "demo");
    await org.close(); org = open(dir);
    expect(() => org.registerServerSettings(definition(2))).toThrow("Unsupported");
    expect(() => org.registerServerSettings({ ...definition(2), migrate: () => ({ workers: 20 }) })).toThrow("Invalid");
    expect(org.store.serverSettings("demo")!.version).toBe(1);
    org.registerServerSettings({ ...definition(2), migrate: (overrides, from) => { expect(from).toBe(1); return { ...overrides, workers: 4 }; } });
    expect((await get(org, "demo")).revision).toBe(2);
    expect(org.store.serverSettings("demo")!.version).toBe(2);
    await expect(update(org, 1, {}, [], "demo")).rejects.toMatchObject({ code: "CONFLICT" });
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("runtime changes affect admissions without restarting or deleting existing agents and expose no MCP tool", async () => {
  const dir = temp(), org = open(dir);
  try {
    org.registerHarness({ name: "fixture", launch: () => ({ command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }) });
    const create = async (parentId?: string) => {
      const op = await org.request("agent.create", { parentId, settings: { harness: "fixture" } }, client) as Operation;
      return org.request("operation.wait", { operationId: op.id, waitMs: 2000 }, client) as Promise<Operation>;
    };
    const root = await create(); const id = (root.result as any).id;
    const before = org.agents.get(id)!;
    await update(org, 0, { maxProcesses: 1, maxAgents: 1 });
    expect(org.agents.get(id)!.generation).toBe(before.generation);
    expect(org.agents.get(id)!.revision).toBe(before.revision);
    const failed = await create(id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("LIMIT");
    const tools = await org.request("mcp.list", {}, { kind: "agent", id }) as any;
    expect(JSON.stringify(tools)).not.toContain("organization.settings");
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("async availability validation runs only on changed saves, is fenced and attributed, and cannot enqueue nested mutations", async () => {
  const dir = temp(), org = open(dir);
  let checks = 0, release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve), gate = new Promise<void>(resolve => release = resolve);
  try {
    await org.use({ name: 'availability', apiVersion: 1, setup(host) {
      host.registerServerSettings({ ...definition(), async validateChange(value) {
        checks++; started();
        await expect(host.request('organization.settings.update', { namespace: 'core', expectedRevision: 0, patch: { maxDepth: 1 } }, client)).rejects.toMatchObject({ code: 'NESTED_MUTATION' });
        if (value.workers === 2) { await gate; throw new ApiError('INVALID_PARAMS', 'Unavailable resource'); }
      } });
    } });
    await get(org, 'demo'); await get(org, 'demo'); expect(checks).toBe(0);
    const rejected = update(org, 0, { workers: 2 }, [], 'demo'); await ready;
    expect((await get(org, 'demo')).revision).toBe(0); expect(org.serverSettings('demo').workers).toBe(1);
    expect(org.store.serverSettings('demo')).toBeUndefined();
    const accepted = update(org, 0, { workers: 3 }, [], 'demo'); release();
    await expect(rejected).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'availability: Unavailable resource' });
    expect((await accepted).revision).toBe(1); expect(checks).toBe(2);
    await update(org, 1, { workers: 3 }, [], 'demo'); expect(checks).toBe(2);
  } finally { release?.(); await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("record-list descriptors and server option endpoints are portable, bounded and detached", async () => {
  const dir = temp(), org = open(dir);
  try {
    const spec = definition();
    const field = spec.fields.find(f => f.key === 'entries')!;
    field.itemFields = [{ key: 'id', label: 'ID', editor: 'text', effect: 'future-launch', choicesEndpoint: 'demo.choices' }];
    field.itemDefaults = { id: '' }; field.itemIdKey = 'id'; field.itemLabelKey = 'id';
    org.registerServerSettings(spec);
    const descriptor = (await get(org, 'demo')).fields.find(f => f.key === 'entries')!;
    expect(descriptor.itemFields?.[0]?.choicesEndpoint).toBe('demo.choices');
    descriptor.itemDefaults!.id = 'tampered'; expect((await get(org, 'demo')).fields.find(f => f.key === 'entries')!.itemDefaults).toEqual({ id: '' });
    const invalid = definition(); invalid.namespace = 'invalid';
    invalid.fields[2] = { ...field, itemFields: [field.itemFields[0]!, field.itemFields[0]!] };
    expect(() => org.registerServerSettings(invalid)).toThrow('Invalid record-list');
    const mapField = { ...field, key: 'mounts', editor: 'object-map' as const, itemIdKey: undefined, choicesEndpoint: 'maps.choices' };
    org.registerServerSettings({ namespace: 'maps', title: 'Maps', version: 1, defaults: { mounts: {} }, fields: [mapField], validate: value => value });
    expect((await get(org, 'maps')).fields[0]?.itemFields).toEqual(field.itemFields);
    expect(() => org.registerServerSettings({ namespace: 'badmaps', title: 'Maps', version: 1, defaults: { mounts: {} },
      fields: [{ ...mapField, choicesEndpoint: undefined }], validate: value => value })).toThrow('key choices endpoint');
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("two real socket clients see one shared revision and change event", async () => {
  const dir = temp(); const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "server.sock"), recover: false, plugins: [] });
  const a = await OrganizationClient.connect(server.organization.socketPath), b = await OrganizationClient.connect(server.organization.socketPath);
  try {
    const notification = new Promise<ServerEvent>(resolve => b.onEvent(e => { if (e.type === "organization.settings.changed") resolve(e); }));
    await b.request("subscribe", { types: ["organization.settings.changed"] });
    await a.request("organization.settings.update", { namespace: "core", expectedRevision: 0, patch: { maxChildren: 2 } });
    expect((await b.request<ServerSettingsView>("organization.settings.get", { namespace: "core" })).values.maxChildren).toBe(2);
    expect((await notification).data).toMatchObject({ namespace: "core", revision: 1 });
    await expect(b.request("organization.settings.update", { namespace: "core", expectedRevision: 0, patch: { maxChildren: 3 } })).rejects.toMatchObject({ code: "CONFLICT" });
  } finally { a.close(); b.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
