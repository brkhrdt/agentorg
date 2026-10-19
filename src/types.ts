import { z } from "zod";

export const settingsSchema = z
  .object({
    harness: z.string().min(1),
    model: z.string().min(1).optional(),
    provider: z.string().optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
// Patches must not apply creation defaults (notably options: {}).
export const settingsPatchSchema = settingsSchema.partial().extend({
  options: z.record(z.string(), z.unknown()).optional(),
});
export type Settings = z.infer<typeof settingsSchema>;
export type AgentState =
  | "starting"
  | "running"
  | "idle"
  | "waiting"
  | "recovering"
  | "stopped"
  | "failed";
export interface AgentRecord {
  id: string;
  parentId: string | null;
  name: string;
  metadata: Record<string, unknown>;
  settings: Settings;
  state: AgentState;
  revision: number;
  generation: string | null;
  sessionId: string;
  sessionNumber: number;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export type OperationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";
export interface Operation {
  id: string;
  /** Optional server-owned prompt origin. Absent on legacy and non-prompt operations. */
  promptProvenance?: PromptProvenance;
  caller: Caller;
  agentId: string | null;
  type: string;
  status: OperationStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: ApiErrorShape;
  cancelRequested?: boolean;
  input: unknown;
}
export interface PromptProvenance {
  kind: "parent-completion";
  parentOperationId: string;
  parentAgentId: string;
  parentSessionId: string;
  parentGeneration: string | null;
}
export type Caller =
  | { kind: "client"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "server"; id: string };
export interface ServerEvent {
  kind: "event";
  seq: number;
  time: string;
  type: string;
  agentId?: string;
  generation?: string;
  data: unknown;
}
export interface ApiErrorShape {
  code: string;
  message: string;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorShape(error: unknown): ApiErrorShape {
  return {
    code:
      error instanceof ApiError
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_PARAMS"
          : error instanceof Error && typeof (error as any).code === "string" && /^[A-Z][A-Z_]+$/.test((error as any).code)
            ? (error as any).code
            : "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}
export const terminal = (op: Operation) =>
  ["completed", "failed", "stopped"].includes(op.status);
export const now = () => new Date().toISOString();
export const defaults = {
  maxDepth: 8,
  maxChildren: 16,
  maxProcesses: 32,
  maxPrompts: 8,
  maxPromptBytes: 128 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxEvents: 100_000,
  maxOperations: 10_000,
  maxQueuedPrompts: 100,
  maxPendingCompletionOperations: 1024,
  maxAgents: 10_000,
  maxLineBytes: 2 * 1024 * 1024,
  maxClientBufferBytes: 4 * 1024 * 1024,
  stopTimeoutMs: 5000,
  killTimeoutMs: 1000,
  startTimeoutMs: 30_000,
  cancelTimeoutMs: 5000,
  maxWaitMs: 30_000,
};
export type Limits = typeof defaults;
export function bounded(value: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) <= maxBytes) return value;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(json),
    preview: Buffer.from(json)
      .subarray(0, Math.max(0, Math.floor((maxBytes - 120) / 6)))
      .toString("utf8"),
  };
}
