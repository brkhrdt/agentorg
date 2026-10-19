import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { Operation } from "../src/types.ts";

function fixture(run: (store: Store, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "completion-store-")), file = join(dir, "db.sqlite");
  let store = new Store(file);
  try { run(store, file); } finally { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}
const identity = { parentAgentId: "parent", parentSessionId: "session", rootOperationId: "root" };
function op(id: string, status: Operation["status"] = "queued"): Operation {
  return { id, type: "prompt", agentId: "child", input: "prompt", caller: { kind: "server", id: "test" }, status, createdAt: "now", result: { bounded: true } };
}

test("completion membership/pins survive reopen; pinned results evade pruning and release restores it", () => fixture((store, file) => {
  expect(store.admitCompletionOperation(op("member"), identity, ["child"], 1)).toBe(true);
  expect(store.admitCompletionOperation(op("rejected"), identity, [], 1)).toBe(false);
  expect(store.operations().map(o => o.id)).toEqual(["member"]);
  store.saveOperation(op("member", "completed"));
  store.saveOperation(op("ordinary", "completed"));
  store.close();
  const reopened = new Store(file);
  try {
    expect(reopened.completionBatches()[0].memberOperationIds).toEqual(["member"]);
    expect(reopened.pruneTerminalOperations(1)).toEqual(["ordinary"]);
    expect(reopened.operations().map(o => o.id)).toEqual(["member"]);
    reopened.event({ kind: "event", type: "noise", data: {}, time: "now" }, 0);
    expect(reopened.operations().map(o => o.id)).toEqual(["member"]);
    reopened.releaseCompletionPins(identity);
    expect(reopened.pruneTerminalOperations(0)).toEqual(["member"]);
  } finally { reopened.close(); }
}));

test("admission rejection and transaction failures leave no partial operation, batch, membership, or pin", () => fixture(store => {
  expect(store.admitCompletionOperation(op("first"), identity, [], 1)).toBe(true);
  expect(store.admitCompletionOperation(op("second"), { ...identity, rootOperationId: "other" }, [], 1)).toBe(false);
  store.db.exec("CREATE TRIGGER fail_pin BEFORE INSERT ON result_pins BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
  expect(() => store.admitCompletionOperation(op("rollback"), { ...identity, rootOperationId: "rollback" }, [], 2)).toThrow();
  expect(store.operations().map(o => o.id)).toEqual(["first"]);
  expect(store.completionBatches()).toHaveLength(1);
  expect(store.pinnedOperationIds()).toEqual(["first"]);
}));

test("admission capacity includes completed pinned results across reopen, until release", () => fixture((store, file) => {
  expect(store.admitCompletionOperation(op("done"), identity, [], 1)).toBe(true);
  store.saveOperation(op("done", "completed"));
  store.close();
  const reopened = new Store(file);
  try {
    expect(reopened.admitCompletionOperation(op("blocked"), { ...identity, rootOperationId: "other" }, [], 1)).toBe(false);
    reopened.releaseCompletionPins(identity);
    expect(reopened.admitCompletionOperation(op("admitted"), { ...identity, rootOperationId: "other" }, [], 1)).toBe(true);
  } finally { reopened.close(); }
}));

test("ready membership addition revokes readiness atomically; dispatching excludes additions", () => fixture((store, file) => {
  expect(store.admitCompletionOperation(op("one"), identity, ["child"], 4)).toBe(true);
  const batch = store.completionBatches()[0]; batch.state = "ready"; store.setCompletionBatch(batch);
  expect(store.admitCompletionOperation(op("two"), identity, ["other"], 4)).toBe(true);
  expect(store.completionBatches()[0]).toMatchObject({ state: "collecting", memberOperationIds: ["one", "two"] });
  const dispatching = store.completionBatches()[0]; dispatching.state = "dispatching"; store.setCompletionBatch(dispatching);
  store.close();
  const reopened = new Store(file);
  try {
    expect(reopened.completionBatches()[0].state).toBe("dispatching");
    expect(reopened.admitCompletionOperation(op("three"), identity, [], 4)).toBe(false);
    expect(reopened.completionBatches()[0].memberOperationIds).toEqual(["one", "two"]);
  } finally { reopened.close(); }
}));

test("retains bounded terminal result shapes at maxOperations one without copying bodies to ledger", () => fixture(store => {
  const cases: Operation[] = [
    { ...op("absent", "completed"), result: undefined },
    { ...op("partial", "completed"), result: { partial: true } },
    { ...op("failed", "failed"), result: undefined, error: { code: "FAILED", message: "failure" } },
    { ...op("stopped", "stopped"), result: undefined },
    { ...op("truncated", "completed"), result: { truncated: true, originalBytes: 10000, preview: "bounded preview" } },
  ];
  for (const operation of cases) { expect(store.admitCompletionOperation(operation, { ...identity, rootOperationId: operation.id }, [], 10)).toBe(true); }
  expect(store.operations().find(o => o.id === "truncated")!.result).toHaveProperty("truncated", true);
  for (const operation of cases) store.saveOperation({ ...operation, status: operation.status === "queued" ? "completed" : operation.status });
  expect(store.pruneTerminalOperations(1)).toEqual([]);
  for (const operation of cases) store.releaseCompletionPins({ ...identity, rootOperationId: operation.id });
  expect(store.pruneTerminalOperations(1)).toHaveLength(4);
  const ledger = JSON.stringify(store.completionBatches());
  expect(ledger).not.toContain("output");
  expect(ledger).not.toContain("failure");
}));

test("genuine populated schema version 1 database migrates additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "completion-legacy-")), file = join(dir, "db.sqlite");
  const legacy = new Database(file, { create: true });
  legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO meta VALUES ('schema', 1), ('sequence', 7);
    CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE server_settings (namespace TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, agent_id TEXT, data TEXT NOT NULL);`);
  legacy.query("INSERT INTO agents VALUES (?, ?)").run("legacy-agent", JSON.stringify({ id: "legacy-agent" }));
  legacy.query("INSERT INTO operations VALUES (?, ?)").run("legacy-op", JSON.stringify(op("legacy-op", "completed")));
  legacy.close();
  const migrated = new Store(file);
  try {
    expect(migrated.db.query<{ value: number }, []>("SELECT value FROM meta WHERE key='schema'").get()!.value).toBe(2);
    expect(migrated.agents()).toEqual([{ id: "legacy-agent" }]);
    expect(migrated.operations().map(o => o.id)).toEqual(["legacy-op"]);
    expect(migrated.completionBatches()).toEqual([]);
  } finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});
