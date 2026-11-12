import { tsxImport } from "./runtime.ts";
import { expect, test } from "vitest";
import { settingsSchema, settingsPatchSchema, type AgentRecord, type Operation } from "../src/types.ts";
import { Organization } from "../src/organization.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settings = { harness: "fixture", model: "test", options: {} };
test("plugin settings editor discovery is additive, validated and detached from plugin and client objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-editors-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    const ui = { fields: [{ key: "files", editor: "paths" as const, label: "Input files" }, { key: "env", editor: "string-map" as const, sensitive: true }] };
    org.registerSettings({ namespace: "demo", validate: value => value, ui });
    org.registerSettings({ namespace: "opaque", validate: value => value });
    ui.fields[0]!.label = "mutated";
    const snapshot = await org.request("organization.snapshot") as any;
    expect(snapshot.capabilities.settingsEditors).toEqual({ demo: { fields: [{ key: "files", editor: "paths", label: "Input files" }, { key: "env", editor: "string-map", sensitive: true }] } });
    snapshot.capabilities.settingsEditors.demo.fields[0].editor = "text";
    expect((await org.request("organization.snapshot") as any).capabilities.settingsEditors.demo.fields[0].editor).toBe("paths");
    expect(() => org.registerSettings({ namespace: "bad", validate: value => value, ui: { fields: [{ key: "x", editor: "unknown" as any }] } })).toThrow();
    expect(() => org.registerSettings({ namespace: "duplicate", validate: value => value, ui: { fields: [{ key: "x", editor: "text" }, { key: "x", editor: "list" }] } })).toThrow("Duplicate editor field");
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("strict built-ins and generic extension patches", () => {
  const original = settingsSchema.parse({ ...settings, options: { mode: "high" }, extensions: { demo: { value: 1 } } });
  const patch = settingsPatchSchema.parse({ model: "other" });
  expect(settingsSchema.parse({ ...original, ...patch }).extensions).toEqual(original.extensions);
  expect(patch.options).toBeUndefined();
  expect(() => settingsSchema.parse({ ...settings, unknown: true })).toThrow();
});

test("transparent extension grant arrays survive cwd-only and name-only lifecycle updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-grant-preservation-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    org.registerHarness({ name: "fixture", launch: () => ({ command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }) });
    org.registerSettings({ namespace: "podman", validate: value => value });
    org.registerSettings({ namespace: "sibling", validate: value => value });
    const initial = {
      id: "grant-agent", parentId: null, name: "before", metadata: {},
      settings: { ...settings, cwd: "/before", extensions: {
        podman: {
          image: "fixture:v1", profile: { id: "profile" }, runtime: { network: "none" },
          configGrants: { readOnlyDirs: ["/configured-ro"], readWriteDirs: ["/configured-rw"], readOnlyVolumes: ["configured-ro"], readWriteVolumes: ["configured-rw"] },
          readOnlyDirs: ["/extra-ro"], readWriteDirs: ["/extra-rw"], readOnlyVolumes: ["extra-ro"], readWriteVolumes: ["extra-rw"],
        }, sibling: { retained: true },
      } },
      state: "stopped", revision: 4, generation: null, sessionId: "session", sessionNumber: 1,
      removedAt: null, createdAt: "now", updatedAt: "now",
    } as unknown as AgentRecord;
    org.agents.set(initial.id, initial); org.store.saveAgent(initial);
    await org.initialize();
    const run = async (params: unknown) => {
      const accepted = await org.request("agent.modify", params) as Operation;
      for (let n = 0; n < 200; n++) {
        const op = await org.request("operation.wait", { operationId: accepted.id, waitMs: 50 }) as Operation;
        if (["completed", "failed", "stopped"].includes(op.status)) return op;
      }
      throw new Error("operation timed out");
    };
    const first = await run({ agentId: initial.id, expectedRevision: 4, settings: { cwd: "/after" } });
    expect(first.status).toBe("completed");
    const returned = first.result as AgentRecord;
    const grants = returned.settings.extensions!.podman as Record<string, any>;
    expect(returned.revision).toBe(5);
    expect(returned.settings.cwd).toBe("/after");
    expect(grants).toMatchObject({ readOnlyDirs: ["/extra-ro"], readWriteDirs: ["/extra-rw"], readOnlyVolumes: ["extra-ro"], readWriteVolumes: ["extra-rw"],
      configGrants: { readOnlyDirs: ["/configured-ro"], readWriteDirs: ["/configured-rw"], readOnlyVolumes: ["configured-ro"], readWriteVolumes: ["configured-rw"] },
      image: "fixture:v1", profile: { id: "profile" }, runtime: { network: "none" } });
    expect(returned.settings.extensions!.sibling).toEqual({ retained: true });
    expect(org.store.agents().find(agent => agent.id === initial.id)).toEqual(returned);

    const second = await run({ agentId: initial.id, expectedRevision: 5, name: "renamed" });
    expect(second.status).toBe("completed");
    const renamed = second.result as AgentRecord;
    expect(renamed.revision).toBe(6);
    expect(renamed.name).toBe("renamed");
    expect(renamed.settings.extensions!.podman).toEqual(grants);
    expect(org.store.agents().find(agent => agent.id === initial.id)).toEqual(renamed);
    const conflict = await run({ agentId: initial.id, expectedRevision: 5, settings: { cwd: "/stale" } });
    expect(conflict.status).toBe("failed");
    expect(conflict.error?.code).toBe("CONFLICT");
    expect(org.store.agents().find(agent => agent.id === initial.id)).toEqual(renamed);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("generic participant atomic related updates, compensation, finalize and nested request protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-host-"));
  const org = new Organization(join(dir, "server.sock"), dir, { stopTimeoutMs: 100, killTimeoutMs: 50 });
  const calls: string[] = [];
  try {
    org.registerHarness({ name: "fixture", launch: () => ({ command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")] }) });
    expect((await org.request("organization.snapshot") as any).capabilities.harnesses).toEqual(["fixture"]);
    org.registerSettings({ namespace: "demo", validate: value => value, launchKey: () => "none" });
    org.registerSettings({ namespace: "other", validate: value => value });
    org.registerCapability("demo", { settingsNamespace: "demo" });
    org.prepareLaunch(context => { context.env.DEMO_RESOURCE = "explicit"; });
    org.beforeLaunch(spec => ({ ...spec, env: { ...spec.env, DEMO_TRANSFORM: "applied" } }));
    org.validateLaunch(spec => {
      expect(spec.env!.DEMO_RESOURCE).toBe("explicit");
      expect(spec.env!.DEMO_TRANSFORM).toBe("applied");
    });
    const run = async (method: string, params: unknown) => {
      const accepted = await org.request(method, params) as Operation;
      for (let n = 0; n < 200; n++) {
        const op = await org.request("operation.wait", { operationId: accepted.id, waitMs: 50 }) as Operation;
        if (["completed", "failed", "stopped"].includes(op.status)) return op;
      }
      throw new Error("operation timed out");
    };
    const parent = (await run("agent.create", { settings })).result as AgentRecord;
    const child = (await run("agent.create", { parentId: parent.id, settings: { ...settings, extensions: { other: { keep: true } } } })).result as AgentRecord;
    org.beforeMutation(async context => {
      if (context.method !== "agent.modify") return;
      await expect(org.request("agent.restart", { agentId: child.id })).rejects.toThrow("cannot enqueue");
      const related = context.agents.find(a => a.id === parent.id)!;
      return {
        updates: [{ agentId: parent.id, expectedRevision: related.revision, settings: { ...related.settings, extensions: { demo: { granted: true } } } }],
        apply: async () => { calls.push("apply"); },
        rollback: async () => { calls.push("rollback"); },
        committed: async () => { calls.push("commit"); throw new Error("finalize only"); },
      };
    });
    org.store.db.exec(`CREATE TRIGGER reject_parent BEFORE INSERT ON agents WHEN NEW.id='${parent.id}' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
    const failed = await run("agent.modify", { agentId: child.id, settings: { extensions: { demo: { value: 1 } } } });
    expect(failed.status).toBe("failed");
    expect(calls).toEqual(["apply", "rollback"]);
    expect(org.agents.get(child.id)!.revision).toBe(child.revision);
    expect(org.store.agents().find(a => a.id === parent.id)!.revision).toBe(parent.revision);
    org.store.db.exec("DROP TRIGGER reject_parent");
    calls.length = 0;
    const success = await run("agent.modify", { agentId: child.id, settings: { extensions: { demo: {} } } });
    expect(success.status).toBe("completed");
    expect(calls).toEqual(["apply", "commit"]);
    expect(org.agents.get(child.id)!.settings.extensions).toEqual({ other: { keep: true }, demo: {} });
    expect(org.agents.get(parent.id)!.revision).toBe(parent.revision + 1);
    expect(org.store.history(0, 1000).events.some(e => e.type === "plugin.error")).toBe(true);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("zero harness/feature plugins initialize successfully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-disabled-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    await org.initialize();
    const snapshot = await org.request("organization.snapshot") as any;
    expect(snapshot.capabilities.harnesses).toEqual([]);
    expect(snapshot.capabilities.plugins).toEqual({});
    const accepted = await org.request("agent.create", { settings }) as Operation;
    const op = await org.request("operation.wait", { operationId: accepted.id, waitMs: 1000 }) as Operation;
    expect(op.error?.code).toBe("INVALID_HARNESS");
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unknown persisted namespaces and legacy data are retained and cannot be silently launched or cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-retained-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    org.registerHarness({ name: "fixture", launch: () => { throw new Error("must not reach harness"); } });
    const row = { id: "root", parentId: null, name: "root", metadata: {}, settings: { ...settings, extensions: { absent: { resource: "keep" } }, historicalFeature: { retain: true } }, state: "stopped", revision: 3, generation: null, sessionId: "session", sessionNumber: 1, removedAt: null, createdAt: "now", updatedAt: "now" } as unknown as AgentRecord;
    org.agents.set(row.id, row); org.store.saveAgent(row);
    await org.initialize();
    const restart = await org.request("agent.restart", { agentId: row.id }) as Operation;
    const failed = await org.request("operation.wait", { operationId: restart.id, waitMs: 1000 }) as Operation;
    expect(failed.error?.message).toContain("owning plugin");
    const modify = await org.request("agent.modify", { agentId: row.id, settings: { extensions: {} } }) as Operation;
    expect((await org.request("operation.wait", { operationId: modify.id, waitMs: 1000 }) as Operation).error?.code).toBe("EXTENSION_REQUIRED");
    expect(org.store.agents()[0]!.settings).toEqual(row.settings);
    expect(org.agents.get(row.id)!.revision).toBe(3);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("tree-aware migration receives detached stable pre-migration records and remains compatible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-migration-tree-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    const row = { id: "tree-root", parentId: null, name: "root", metadata: {}, settings: { ...settings, extensions: { demo: { legacy: true } } }, revision: 9, state: "stopped", generation: null, sessionId: null, sessionNumber: 0, removedAt: null, createdAt: "now", updatedAt: "now" } as unknown as AgentRecord;
    org.agents.set(row.id, row); org.store.saveAgent(row);
    let context: any;
    org.registerSettings({ namespace: "demo", validate: value => value, migrate(raw, supplied) { context = supplied; return { ...raw, extensions: { ...raw.extensions as object, demo: { migrated: true } } }; } });
    await org.initialize(false);
    expect(context.agent.id).toBe(row.id);
    expect(context.agents).toHaveLength(1);
    context.agents[0].settings.extensions.demo.legacy = false;
    expect(org.agents.get(row.id)!.settings.extensions!.demo).toEqual({ migrated: true });
    expect(org.agents.get(row.id)!.revision).toBe(9);
    const before = org.store.agents()[0]!.settings;
    await org.initialize(false);
    expect(org.store.agents()[0]!.settings).toEqual(before);
    // Existing one-argument callbacks remain valid.
    org.registerSettings({ namespace: "old", validate: value => value, migrate(raw) { return raw; } });
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("representation migrations are atomic and preserve journal revision fences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-migration-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    for (const id of ["first", "ambiguous"]) {
      const row = { id, settings: { ...settings, historicalFeature: { id } }, revision: 7, state: "stopped", removedAt: null } as unknown as AgentRecord;
      org.agents.set(id, row); org.store.saveAgent(row);
    }
    org.registerSettings({ namespace: "demo", validate: value => value, migrate(raw) {
      const historical = raw.historicalFeature as { id: string };
      if (historical.id === "ambiguous") throw new Error("ambiguous migration");
      const { historicalFeature, ...rest } = raw;
      return { ...rest, extensions: { demo: historicalFeature } };
    } });
    await expect(org.initialize()).rejects.toThrow("ambiguous");
    expect(org.store.agents().every(row => Object.hasOwn(row.settings, "historicalFeature"))).toBe(true);
    expect(org.store.agents().map(row => row.revision)).toEqual([7, 7]);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});
