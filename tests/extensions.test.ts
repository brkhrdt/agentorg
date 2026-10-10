import { expect, test } from "bun:test";
import { settingsSchema, settingsPatchSchema, type AgentRecord, type Operation } from "../src/types.ts";
import { Organization } from "../src/organization.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settings = { harness: "fixture", model: "test", options: {} };
test("strict built-ins and generic extension patches", () => {
  const original = settingsSchema.parse({ ...settings, options: { mode: "high" }, extensions: { demo: { value: 1 } } });
  const patch = settingsPatchSchema.parse({ model: "other" });
  expect(settingsSchema.parse({ ...original, ...patch }).extensions).toEqual(original.extensions);
  expect(patch.options).toBeUndefined();
  expect(() => settingsSchema.parse({ ...settings, unknown: true })).toThrow();
});

test("generic participant atomic related updates, compensation, finalize and nested request protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-host-"));
  const org = new Organization(join(dir, "server.sock"), dir, { stopTimeoutMs: 100, killTimeoutMs: 50 });
  const calls: string[] = [];
  try {
    org.registerHarness({ name: "fixture", launch: () => ({ command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }) });
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
