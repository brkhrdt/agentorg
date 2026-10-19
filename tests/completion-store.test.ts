import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

test("schema version 1 databases migrate additively and reopen", () => fixture((store, file) => {
  store.db.query("UPDATE meta SET value=1 WHERE key='schema'").run();
  store.close();
  const migrated = new Store(file);
  try {
    expect(migrated.db.query<{ value: number }, []>("SELECT value FROM meta WHERE key='schema'").get()!.value).toBe(2);
    expect(migrated.completionBatches()).toEqual([]);
  } finally { migrated.close(); }
}));
