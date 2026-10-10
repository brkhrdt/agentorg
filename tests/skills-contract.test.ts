import { expect, test } from "bun:test";
import { settingsSchema, settingsPatchSchema, type AgentRecord } from "../src/types.ts";
import { Store } from "../src/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("settings patches preserve omitted options and skill selections; explicit maps replace", () => {
  const original = settingsSchema.parse({ harness: "pi", model: "test", options: { thinking: "high" }, skills: { alpha: "installed" } });
  const patch = settingsPatchSchema.parse({ skills: {} });
  const next = settingsSchema.parse({ ...original, ...patch });
  expect(next.options).toEqual({ thinking: "high" });
  expect(next.skills).toEqual({});
  expect(settingsSchema.parse({ ...original, ...settingsPatchSchema.parse({ model: "other" }) }).skills).toEqual({ alpha: "installed" });
  expect(() => settingsSchema.parse({ harness: "pi", model: "test", skills: { "../bad": "installed" } })).toThrow();
});

test("multi-agent storage updates roll back all rows when one write fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-store-"));
  const store = new Store(join(dir, "organization.sqlite"));
  try {
    const row = (id: string, revision: number) => ({ id, revision, settings: { skills: revision === 1 ? {} : { alpha: "available" } } }) as AgentRecord;
    store.saveAgents([row("child", 1), row("parent", 1)]);
    store.db.exec(`CREATE TRIGGER reject_parent BEFORE INSERT ON agents WHEN NEW.id='parent' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
    expect(() => store.saveAgents([row("child", 2), row("parent", 2)])).toThrow();
    expect(store.agents().map(a => a.revision)).toEqual([1, 1]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
