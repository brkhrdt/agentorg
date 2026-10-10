import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../src/organization.ts";
import { pluginHost } from "../src/plugin-host.ts";
import { ApiError, errorShape, type Operation, type ServerEvent } from "../src/types.ts";
import type { PluginHost, ServerPlugin } from "../src/plugin.ts";

const settings = { harness: "fixture", options: {} };
async function withOrg(run: (org: Organization, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-errors-"));
  const org = new Organization(join(dir, "server.sock"), dir, { startTimeoutMs: 100, stopTimeoutMs: 50, killTimeoutMs: 50 });
  try { await run(org, dir); }
  finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function operation(org: Organization, method: string, params: unknown): Promise<Operation> {
  const accepted = await org.request(method, params) as Operation;
  return await org.request("operation.wait", { operationId: accepted.id, waitMs: 2000 }) as Operation;
}
const fixture: ServerPlugin = {
  apiVersion: 1, name: "fixture",
  setup(host) {
    host.registerHarness({ name: "fixture", launch: () => ({ command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] }) });
  },
};

test("plugin setup errors preserve codes and attribute non-Error throws", async () => {
  await withOrg(async org => {
    for (const error of [new ApiError("CONFLICT", "setup failed"), Object.assign(new Error("setup failed"), { code: "CONFLICT" }), "setup failed"]) {
      try {
        await org.use({ apiVersion: 1, name: "demo", setup() { throw error; } });
        throw new Error("expected setup failure");
      } catch (caught) {
        expect(errorShape(caught)).toEqual({ code: typeof error === "string" ? "INTERNAL" : "CONFLICT", message: "demo: setup failed" });
        expect((caught as Error).cause).toBe(error);
      }
    }
    await expect(org.use({ apiVersion: 1, name: "demo", setup(host) {
      host.registerHarness({ name: "same", launch: () => ({ command: "unused", args: [] }) });
      host.registerHarness({ name: "same", launch: () => ({ command: "unused", args: [] }) });
    } })).rejects.toThrow("demo: Duplicate harness same");
  });
});

test("duplicate cwd failure names the owning plugin in operation errors", async () => {
  await withOrg(async (org, dir) => {
    await org.use(fixture);
    await org.use({ apiVersion: 1, name: "skills", setup(host) {
      host.beforeMutation(context => {
        if (context.agents.some(agent => agent.id !== context.agent.id && agent.settings.cwd === context.agent.settings.cwd))
          throw new ApiError("CONFLICT", "cwd must be unique");
      });
    } });
    const parent = await operation(org, "agent.create", { settings: { ...settings, cwd: dir } });
    expect(parent.status).toBe("completed");
    const failed = await operation(org, "agent.create", { parentId: parent.agentId, settings: { ...settings, cwd: dir } });
    expect(failed.error).toEqual({ code: "CONFLICT", message: "skills: cwd must be unique" });
  });
});

test("endpoint, tool, observer, shutdown and emitted diagnostics retain plugin identity", async () => {
  await withOrg(async org => {
    const events: ServerEvent[] = [];
    org.subscribe(event => events.push(event));
    await org.use({ apiVersion: 1, name: "demo", setup(host) {
      host.registerEndpoint("demo.fail", async () => { throw new ApiError("CONFLICT", "endpoint failed"); });
      host.registerTool({ name: "demo_fail", description: "test", inputSchema: { type: "object" }, execute() { throw new Error("tool failed"); } });
      host.transformTool("agent_get", tool => ({ ...tool, execute() { throw new Error("transform failed"); } }));
      host.onEvent(async event => { if (event.type === "test.event") throw new Error("observer failed"); });
      host.onShutdown(() => { throw new Error("shutdown failed"); });
      host.emit("demo.warning", { message: "warning", extra: 1 });
      host.emit("demo.warn", "warning");
      host.emit("demo.error", { message: "demo: already prefixed" });
      host.emit("demo.info", { message: "not a diagnostic" });
    } });
    await expect(org.request("demo.fail", {})).rejects.toThrow("demo: endpoint failed");
    for (const [name, message] of [["demo_fail", "tool failed"], ["agent_get", "transform failed"]]) {
      const result = await org.request("mcp.call", { name, arguments: {} }, { kind: "agent", id: "test" }) as any;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ code: "INTERNAL", message: `demo: ${message}` });
    }
    org.emit("test.event", {});
    await new Promise(resolve => setTimeout(resolve, 0));
    await org.close();
    expect(events.filter(e => e.type === "plugin.error").map(e => (e.data as any).message)).toEqual([
      "demo: endpoint failed", "demo: observer failed", "demo: shutdown failed",
    ]);
    expect(events.find(e => e.type === "demo.warning")!.data).toEqual({ message: "demo: warning", extra: 1 });
    expect(events.find(e => e.type === "demo.warn")!.data).toBe("demo: warning");
    expect(events.find(e => e.type === "demo.error")!.data).toEqual({ message: "demo: already prefixed" });
    expect(events.find(e => e.type === "demo.info")!.data).toEqual({ message: "not a diagnostic" });
  });
});

for (const phase of ["apply", "rollback", "committed"] as const) {
  test(`mutation ${phase} failures retain plugin identity`, async () => {
    await withOrg(async org => {
      await org.use(fixture);
      await org.use({ apiVersion: 1, name: "participant", setup(host) {
        host.beforeMutation(() => ({
          async apply() { if (phase === "apply") throw new Error("apply failed"); if (phase === "rollback") throw new Error("trigger rollback"); },
          async rollback() { if (phase === "rollback") throw new Error("rollback failed"); },
          async committed() { if (phase === "committed") throw new Error("committed failed"); },
        }));
      } });
      const result = await operation(org, "agent.create", { settings });
      if (phase === "apply") expect(result.error?.message).toBe("participant: apply failed");
      else {
        const messages = org.store.history(0, 1000).events.filter(e => e.type === "plugin.error").map(e => (e.data as any).message);
        expect(messages).toContain(`participant: ${phase} failed`);
        if (phase === "committed") expect(result.status).toBe("completed");
      }
    });
  });
}

for (const hook of ["prepareLaunch", "beforeLaunch", "validateLaunch", "harness", "timeout"] as const) {
  test(`${hook} failures identify plugin in operation and agent state`, async () => {
    await withOrg(async org => {
      if (hook !== "harness") await org.use(fixture);
      await org.use({ apiVersion: 1, name: "launcher", setup(host) {
        const fail = () => { throw new Error("launch failed"); };
        if (hook === "harness") host.registerHarness({ name: "fixture", launch: fail });
        else if (hook === "timeout") host.prepareLaunch(() => new Promise(() => {}));
        else host[hook](fail);
      } });
      const result = await operation(org, "agent.create", { settings });
      const message = hook === "timeout" ? "launcher: Launch preparation timed out" : "launcher: launch failed";
      expect(result.error?.message).toBe(message);
      expect(org.agents.get(result.agentId!)!.error).toBe(message);
    });
  });
}

test("sync settings callbacks and initialize hooks retain attribution and error codes", async () => {
  // Capture registered callbacks to exercise synchronous contracts without coercing them to promises.
  const registered: Record<string, any[]> = {};
  const host = new Proxy({ dataDir: "test" }, {
    get(target, method: string) {
      if (method === "dataDir") return target.dataDir;
      return (...args: any[]) => { registered[method] = args; };
    },
  }) as PluginHost;
  const scoped = pluginHost(host, "settings-owner");
  const fail = () => { throw Object.assign(new Error("invalid"), { code: "INVALID_PARAMS" }); };
  scoped.registerSettings({ namespace: "demo", validate: fail, launchKey: fail, migrate: fail });
  const extension = registered.registerSettings![0];
  for (const method of ["validate", "launchKey", "migrate"]) {
    try { extension[method]({}); throw new Error("expected failure"); }
    catch (error) { expect(errorShape(error)).toEqual({ code: "INVALID_PARAMS", message: "settings-owner: invalid" }); }
  }
  scoped.beforeSettings(fail);
  expect(() => registered.beforeSettings![0](settings, {})).toThrow("settings-owner: invalid");
  await withOrg(async org => {
    await org.use({ apiVersion: 1, name: "initializer", setup(host) {
      host.onInitialize(async () => { throw new Error("init failed"); });
    } });
    await expect(org.initialize()).rejects.toThrow("initializer: init failed");
  });
});

test("delegated plugin failures keep the original owner without duplicate prefixes", async () => {
  await withOrg(async org => {
    await org.use({ apiVersion: 1, name: "origin", setup(host) {
      host.registerEndpoint("origin.fail", () => { throw new Error("failed"); });
    } });
    await org.use({ apiVersion: 1, name: "delegate", setup(host) {
      host.registerEndpoint("delegate.fail", (_params, caller) => host.request("origin.fail", {}, caller));
    } });
    await expect(org.request("delegate.fail", {})).rejects.toThrow(/^origin: failed$/);
  });
});
