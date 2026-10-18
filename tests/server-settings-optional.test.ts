import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../src/organization.ts";
import type { ServerSettingsView } from "../src/plugin.ts";

const caller = { kind: "client", id: "test" } as const;
test("optional public fields preserve absence, explicit empty values and reset across persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "optional-settings-"));
  let org = new Organization(join(dir, "server.sock"), dir);
  const register = () => org.registerServerSettings({ namespace: "optional", title: "Optional fields", version: 1,
    defaults: { required: "yes", profiles: [] }, fields: [
      { key: "required", label: "Required", editor: "text", effect: "future-launch" },
      { key: "tools", label: "Tools", editor: "list", optional: true, effect: "future-launch" },
      { key: "prompt", label: "Prompt", editor: "text", optional: true, effect: "future-launch" },
      { key: "profiles", label: "Profiles", editor: "list", effect: "future-launch",
        itemFields: [
          { key: "name", label: "Name", editor: "text", effect: "future-launch" },
          { key: "tools", label: "Tools", editor: "list", optional: true, effect: "future-launch" },
        ], itemDefaults: { name: "New profile" }, itemLabelKey: "name" },
    ], validate: value => value,
  });
  const get = () => org.request("organization.settings.get", { namespace: "optional" }, caller) as Promise<ServerSettingsView>;
  const update = (expectedRevision: number, patch = {}, reset: string[] = []) => org.request("organization.settings.update", { namespace: "optional", expectedRevision, patch, reset }, caller);
  try {
    register();
    expect((await get()).values).not.toHaveProperty("tools");
    await update(0, { tools: [], prompt: "", profiles: [{ name: "Sparse" }] });
    expect((await get()).effective).toMatchObject({ tools: [], prompt: "", profiles: [{ name: "Sparse" }] });
    await org.close(); org = new Organization(join(dir, "server.sock"), dir); register();
    expect((await get()).values.tools).toEqual([]);
    await update(1, {}, ["tools", "prompt"]);
    expect((await get()).effective).not.toHaveProperty("tools");
    expect((await get()).effective).not.toHaveProperty("prompt");
    await expect(update(2, { tools: null })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(update(2, { required: null })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(update(2, { secret: "no" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});
