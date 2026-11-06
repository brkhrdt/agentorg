import { tsxImport } from "./runtime.ts";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../src/organization.ts";
import type { Operation } from "../src/types.ts";

test.each([true, false])("launch inheritEnv=%s preserves opt-in wrapper environment isolation", async inheritEnv => {
  const dir = mkdtempSync(join(tmpdir(), "launch-env-"));
  const org = new Organization(join(dir, "server.sock"), dir);
  try {
    org.prepareLaunch(context => { context.executionEnvironment = "container"; context.env.TRUSTED_PLUGIN_ENV = "trusted"; });
    org.registerHarness({ name: "fixture", launch: context => {
      expect(context.executionEnvironment).toBe("container");
      return { command: process.execPath, args: ["--import", tsxImport, join(import.meta.dirname, "fixtures/agent.ts")], inheritEnv, env: { EXPLICIT_ENV: "explicit" } };
    } });
    let validated = false;
    org.validateLaunch(spec => {
      validated = true;
      expect(spec.env?.EXPLICIT_ENV).toBe("explicit");
      expect(spec.env?.TRUSTED_PLUGIN_ENV).toBe("trusted");
      expect(spec.env?.AGENT_ONLY_ENV).toBe(inheritEnv ? "untrusted" : undefined);
      expect(spec.env?.HOME).toBe(inheritEnv ? process.env.HOME : undefined);
      expect(spec.env?.ORG_TOKEN).toEqual(expect.any(String));
    });
    const accepted = await org.request("agent.create", { settings: { harness: "fixture", env: { AGENT_ONLY_ENV: "untrusted" } } }) as Operation;
    const result = await org.request("operation.wait", { operationId: accepted.id, waitMs: 5000 }) as Operation;
    expect(result.status).toBe("completed"); expect(validated).toBe(true);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});
