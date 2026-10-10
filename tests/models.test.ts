import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Organization } from "../src/organization.ts";

const dir = () => mkdtempSync(join(tmpdir(), "model-discovery-"));
test("provider-first discovery is scoped, sorted, deduplicated and strips private model fields", async () => {
  const dataDir = dir();
  const org = new Organization(join(dataDir, "server.sock"), dataDir);
  let context: unknown;
  try {
    org.registerHarness({ name: "legacy", launch() { throw new Error("must not launch"); } });
    org.registerHarness({ name: "catalog", launch() { throw new Error("must not launch"); }, listModels(input) {
      context = input;
      return [
        { provider: "z", id: "shared" }, { provider: "a", id: "two" },
        { provider: "a", id: "one", name: "One", apiKey: "secret" },
        { provider: "a", id: "two" },
      ];
    } });
    expect((await org.request("organization.snapshot") as any).capabilities.modelDiscovery).toEqual(["catalog"]);
    const params = { harness: "catalog", cwd: ".", env: { CONFIG: "test" }, options: { executable: "custom" } };
    expect(await org.request("organization.providers", params)).toEqual({ providers: ["a", "z"] });
    expect(context).toEqual({ cwd: resolve("."), env: params.env, options: params.options });
    expect(await org.request("organization.models", { ...params, provider: "a" })).toEqual({ models: [
      { provider: "a", id: "one", name: "One" }, { provider: "a", id: "two" },
    ] });
    expect(await org.request("organization.models", { harness: "catalog", provider: "missing" })).toEqual({ models: [] });
    await expect(org.request("organization.models", { harness: "catalog" })).rejects.toThrow();
    await expect(org.request("organization.models", { harness: "catalog", provider: "" })).rejects.toThrow();
    await expect(org.request("organization.providers", { harness: "missing" })).rejects.toMatchObject({ code: "INVALID_HARNESS" });
    await expect(org.request("organization.providers", { harness: "legacy" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(org.agents.size).toBe(0);
    expect(org.operations.size).toBe(0);
  } finally { await org.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("discovery failures and deadlines retain harness plugin attribution", async () => {
  const dataDir = dir();
  const org = new Organization(join(dataDir, "server.sock"), dataDir, { startTimeoutMs: 20 });
  try {
    await org.use({ apiVersion: 1, name: "catalog-plugin", setup(host) {
      host.registerHarness({ name: "broken", launch() { throw new Error(); }, listModels() { throw new Error("catalog failed"); } });
      host.registerHarness({ name: "slow", launch() { throw new Error(); }, listModels: () => new Promise(() => {}) });
    } });
    await expect(org.request("organization.providers", { harness: "broken" })).rejects.toThrow("catalog-plugin: catalog failed");
    await expect(org.request("organization.providers", { harness: "slow" })).rejects.toThrow("catalog-plugin: Model discovery timed out");
  } finally { await org.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
