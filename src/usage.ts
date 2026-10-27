import { z } from "zod";
export const metricIdSchema = z.string().min(3).max(128).regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/);
export interface UsageNotification {
  version: 1;
  sessionId: string;
  reportId: string;
  metrics: Record<string, number>;
}
/** ACP parser that tolerates bad/missing metric fields and drops empty reports. */
export const usageNotificationSchema = {
  parse(input: unknown): UsageNotification | null {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    if (value.version !== 1 || typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 256 ||
      typeof value.reportId !== "string" || value.reportId.length < 1 || value.reportId.length > 256) return null;
    const metrics: Record<string, number> = Object.create(null);
    if (value.metrics !== null && typeof value.metrics === "object" && !Array.isArray(value.metrics)) {
      for (const [id, raw] of Object.entries(value.metrics as Record<string, unknown>)) {
        if (Object.keys(metrics).length >= 256) break;
        if (!metricIdSchema.safeParse(id).success || typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) continue;
        if ((id.startsWith("token.") || id.startsWith("tokens.")) && !Number.isSafeInteger(raw)) continue;
        metrics[id] = raw;
      }
    }
    return Object.keys(metrics).length ? { version: 1, sessionId: value.sessionId, reportId: value.reportId, metrics } : null;
  },
};
export interface UsageRecord extends UsageNotification {
  agentId: string;
  generation: string;
  recordedAt: string;
}
export interface UsageMetricDefinition {
  id: string;
  title: string;
  unit: string;
  description?: string;
}
export interface UsageQuery {
  agentId?: string;
  scope?: "self" | "subtree";
  metricIds?: string[];
}
export interface UsageQueryResult {
  version: 1;
  agentId: string;
  scope: "self" | "subtree";
  metrics: Record<string, number>;
  reporting: { reports: number; agentCount: number; latestAt: string | null; includesRemoved: true; metrics: Record<string, { observations: number; contributors: number }> };
  catalog: UsageMetricDefinition[];
}
