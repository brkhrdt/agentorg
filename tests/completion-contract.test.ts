import { expect, test } from "vitest";
import { canAdmitCompletionOperation, canMarkCompletionBatchReady, classifyPrompt, sameCompletionSession, transitionCompletionBatch, type CompletionBatch } from "../src/completion-contract.ts";
import { defaults, type Operation } from "../src/types.ts";

test("prompt provenance is optional and legacy operations remain unattributed", () => {
  const legacy = { id: "old" } as Pick<Operation, "promptProvenance">;
  expect(classifyPrompt(legacy)).toEqual({ kind: "legacy-or-unattributed" });
  const operation = { promptProvenance: { kind: "parent-completion", parentOperationId: "p", parentAgentId: "a", parentSessionId: "s", parentGeneration: "g" } } as Pick<Operation, "promptProvenance">;
  expect(classifyPrompt(operation)).toEqual({ kind: "parent-completion", provenance: operation.promptProvenance! });
});

test("batch readiness requires nonempty distinct members and can be revoked before dispatch", () => {
  const batch: CompletionBatch = { identity: { parentAgentId: "a", parentSessionId: "s", rootOperationId: "root" }, state: "collecting", memberOperationIds: [], relevantRootAgentIds: ["a"] };
  expect(canMarkCompletionBatchReady(batch)).toBe(false);
  batch.memberOperationIds.push("op");
  expect(canMarkCompletionBatchReady(batch)).toBe(true);
  batch.memberOperationIds.push("op");
  expect(canMarkCompletionBatchReady(batch)).toBe(false);
  batch.memberOperationIds = ["op"];
  expect(transitionCompletionBatch("collecting", "became-ready")).toBeUndefined();
  expect(transitionCompletionBatch("collecting", "became-ready", ["op"])).toBe("ready");
  expect(transitionCompletionBatch("ready", "readiness-revoked")).toBe("collecting");
  expect(transitionCompletionBatch("ready", "dispatch-started")).toBe("dispatching");
  expect(transitionCompletionBatch("dispatching", "readiness-revoked")).toBeUndefined();
});

test("session identity is stable across generation changes and capacity is server-global", () => {
  expect(sameCompletionSession({ parentAgentId: "a", parentSessionId: "s" }, { parentAgentId: "a", parentSessionId: "s" })).toBe(true);
  expect(sameCompletionSession({ parentAgentId: "a", parentSessionId: "s" }, { parentAgentId: "a", parentSessionId: "new" })).toBe(false);
  expect(defaults.maxPendingCompletionOperations).toBe(1024);
  expect(canAdmitCompletionOperation(1023, defaults.maxPendingCompletionOperations)).toBe(true);
  expect(canAdmitCompletionOperation(1024, defaults.maxPendingCompletionOperations)).toBe(false);
  expect(canAdmitCompletionOperation(-1, 1024)).toBe(false);
});
