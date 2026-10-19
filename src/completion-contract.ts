import type { Operation, PromptProvenance } from "./types.ts";

/** Legacy prompt operations have no provenance; consumers must not infer it from input. */
export type PromptClassification =
  | { kind: "legacy-or-unattributed" }
  | { kind: "parent-completion"; provenance: PromptProvenance };

export function classifyPrompt(operation: Pick<Operation, "promptProvenance">): PromptClassification {
  const provenance = operation.promptProvenance;
  return provenance?.kind === "parent-completion"
    ? { kind: "parent-completion", provenance }
    : { kind: "legacy-or-unattributed" };
}

/**
 * A batch is identified by its parent session, not its mutable generation. Members
 * are distinct operation IDs, and relevantRoots scopes which descendants matter.
 */
export interface CompletionBatchIdentity {
  parentAgentId: string;
  parentSessionId: string;
  rootOperationId: string;
}
export type CompletionBatchState = "collecting" | "ready" | "dispatching" | "dispatched" | "invalidated";
export interface CompletionBatch {
  identity: CompletionBatchIdentity;
  state: CompletionBatchState;
  memberOperationIds: string[];
  relevantRootAgentIds: string[];
  memberStatuses?: Record<string, import("./types.ts").Operation["status"]>;
  continuationOperationId?: string;
  dispatchSuppressed?: boolean;
  suppressionReason?: string;
}

export type CompletionBatchAction = "member-added" | "became-ready" | "readiness-revoked" | "dispatch-started" | "dispatch-finished" | "invalidated";
const transitions: Record<CompletionBatchState, Partial<Record<CompletionBatchAction, CompletionBatchState>>> = {
  collecting: { "member-added": "collecting", "became-ready": "ready", invalidated: "invalidated" },
  ready: { "member-added": "collecting", "readiness-revoked": "collecting", "dispatch-started": "dispatching", invalidated: "invalidated" },
  dispatching: { "dispatch-finished": "dispatched", invalidated: "invalidated" },
  dispatched: {},
  invalidated: {},
};

/** Pure transition policy; callers must enforce membership/non-empty invariants. */
export function transitionCompletionBatch(state: CompletionBatchState, action: CompletionBatchAction, memberOperationIds: readonly string[] = []): CompletionBatchState | undefined {
  if (action === "became-ready" && !canMarkCompletionBatchReady({ memberOperationIds: [...memberOperationIds] })) return undefined;
  return transitions[state][action];
}

export function canMarkCompletionBatchReady(batch: Pick<CompletionBatch, "memberOperationIds">): boolean {
  return batch.memberOperationIds.length > 0 && new Set(batch.memberOperationIds).size === batch.memberOperationIds.length;
}

/** Generation changes alone do not invalidate work in the same parent session. */
export function sameCompletionSession(a: Pick<CompletionBatchIdentity, "parentAgentId" | "parentSessionId">, b: Pick<CompletionBatchIdentity, "parentAgentId" | "parentSessionId">): boolean {
  return a.parentAgentId === b.parentAgentId && a.parentSessionId === b.parentSessionId;
}

/** Global admission policy. pendingCount includes all pending completion operations. */
export function canAdmitCompletionOperation(pendingCount: number, maxPendingCompletionOperations: number): boolean {
  return Number.isSafeInteger(pendingCount) && pendingCount >= 0 && Number.isSafeInteger(maxPendingCompletionOperations) && maxPendingCompletionOperations >= 1 && pendingCount < maxPendingCompletionOperations;
}
