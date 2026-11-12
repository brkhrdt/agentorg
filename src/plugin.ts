import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentRecord, Caller, ServerEvent, Settings } from "./types.ts";

import type { ServerSettingsDefinition } from "./server-settings.ts";
import type { UsageMetricDefinition, UsageQuery, UsageQueryResult } from "./usage.ts";
export type { UsageMetricDefinition, UsageQuery, UsageQueryResult, UsageNotification } from "./usage.ts";
export type { ServerSettingsDefinition, ServerSettingsDescriptor, ServerSettingsField, ServerSettingsView, SettingsEffect } from "./server-settings.ts";

import type { EventRenderer } from "./rendering.ts";
export type { EventRenderer, RenderContext, RenderLevels, ExtendedDiff, EventRendering, RendererMetadata, RendererExample } from "./rendering.ts";
export { renderTool, renderGenericTool, toolExamples, fenced } from "./rendering.ts";
export { editDiff } from "./tool-diff.ts";
export { MCP_TOOL_NAMES, renderMcpTool, coreMcpRenderers, decodeMcpOutput } from "./mcp-tool-rendering.ts";

export const PLUGIN_API_VERSION = 1 as const;
export const COMPACTION_METHOD = "_agentorg/compaction";
export type CompactionNotification = {
  sessionId: string;
  compactionId: string;
  phase: "start" | "end";
  reason: "manual" | "threshold" | "overflow";
  aborted?: boolean;
  willRetry?: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  errorMessage?: string;
};
export {
  STEERING_EXTENSION,
  STEERING_METHOD,
  STEERING_STATUS_METHOD,
  STEERING_VERSION,
  steeringCapability,
  type SteeringCapability,
  type SteeringRequest,
  type SteeringResponse,
  type SteeringStatus,
  type SteeringRunMetadata,
} from "./steering-contract.ts";
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Default true. Wrappers can opt out of host/agent environment merging. */
  inheritEnv?: boolean;
  /** Environment contracts consumed by this harness/wrapper, for plugin readiness validation. */
  consumesEnv?: string[];
  /** Optional container/wrapper-specific graceful shutdown, bounded by stopTimeoutMs. */
  gracefulStop?: (pid: number) => void | Promise<void>;
}
export interface LaunchContext {
  agent: Readonly<AgentRecord>;
  socketPath: string;
  dataDir: string;
  token: string;
  /** Set by a container plugin before harness launch; commands must exist in the image. */
  executionEnvironment?: "container";
  /** Host-owned MCP launch specs, including full argv/env; adapters must not infer core worker paths. */
  mcpServers: McpServer[];
  /** Plugin-provided launch environment; merged after harness environment. */
  env: Record<string, string | undefined>;
}
export interface ModelDiscoveryContext {
  cwd?: string;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
}
export interface HarnessModel {
  provider: string;
  id: string;
  name?: string;
}
export interface HarnessPlugin {
  name: string;
  /** Optional presentation contract v1; tool-specific matches precede type-wide matches. */
  renderers?: EventRenderer[];
  /** Explicit emitted tool identity to canonical identity map; no suffix guessing. */
  toolAliases?: Record<string, string> | ((canonicalTools: readonly string[]) => Record<string, string>);
  /** Public namespaced numeric usage metrics emitted by this harness. */
  usageMetrics?: UsageMetricDefinition[];
  /** Available models using server-side credentials/configuration; never return secrets. */
  listModels?(context: ModelDiscoveryContext): HarnessModel[] | Promise<HarnessModel[]>;
  /** Launch a stdio ACP v1 agent; non-ACP harnesses must supply an adapter. */
  launch(context: LaunchContext): LaunchSpec | Promise<LaunchSpec>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute(
    args: unknown,
    caller: Extract<Caller, { kind: "agent" }>,
    api: PluginHost,
    authenticatedAgent?: { generation: string; sessionId: string },
  ): unknown | Promise<unknown>;
}
export interface MutationChange {
  /** Optional complete target settings replacement. */
  settings?: Settings;
  /** Atomic related settings replacements; plugins own authorization. */
  updates?: Array<{ agentId: string; expectedRevision: number; settings: Settings }>;
  /** Called after the old process stops, before records commit. */
  apply(): Promise<void>;
  /** Compensate on pre-commit failure, retaining uncertain/user artifacts. */
  rollback(): Promise<void>;
  /** Records committed; journal finalization failure cannot undo the commit. */
  committed(): Promise<void>;
}
export interface MutationContext {
  method: string;
  caller: Caller;
  agent: Readonly<AgentRecord>;
  previous?: Readonly<AgentRecord>;
  settingsPatch?: Partial<Settings>;
  agents: Readonly<AgentRecord>[];
}
/** Additive presentation hints; validation/authorization remain plugin-owned. */
export interface SettingsEditorField {
  /** A top-level key inside settings.extensions[namespace]. */
  key: string;
  label?: string;
  editor: "text" | "number" | "boolean" | "string-map" | "object-map" | "list" | "directory" | "path" | "directories" | "paths";
  sensitive?: boolean;
}
export interface ExtensionSettings {
  namespace: string;
  /** Advertised in snapshot.capabilities.settingsEditors, independent of plugin endpoints. */
  ui?: { fields: SettingsEditorField[] };
  validate(value: unknown): unknown;
  /** Identity of launch resources; defaults to the whole value. */
  launchKey?(value: unknown): unknown;
  /** Synchronously project detached, intentionally public per-agent metadata for snapshot exports. Return bounded JSON only; omit secrets and raw settings. */
  snapshotMetadata?(value: unknown): unknown;
  /** Runs only over persisted records, before startup reconciliation. The optional context is a detached pre-migration tree snapshot. */
  migrate?(settings: Record<string, unknown>, context?: { agent: Readonly<AgentRecord>; agents: readonly Readonly<AgentRecord>[] }): Record<string, unknown>;
}

/** API v1 is additive. Breaking changes require a new apiVersion. Plugins are trusted. */
export interface PluginHost {
  readonly dataDir: string;
  registerSettings(extension: ExtensionSettings): void;
  /** Server-wide public configuration; distinct from per-agent registerSettings. */
  registerServerSettings(definition: ServerSettingsDefinition): void;
  /** Effective public configuration, including persisted overrides. Returns a detached copy. */
  serverSettings(namespace: string): Record<string, unknown>;
  registerCapability(namespace: string, value: unknown): void;
  /** Query durable usage, enforcing the same self/subtree authorization as core requests. */
  queryUsage(query: UsageQuery, caller: Caller): UsageQueryResult;
  /** Advertise a public metric definition; unknown metrics remain queryable. */
  registerUsageMetric(definition: UsageMetricDefinition): void;
  beforeMutation(handler: (context: MutationContext) => MutationChange | void | Promise<MutationChange | void>): void;
  onInitialize(handler: (agents: Readonly<AgentRecord>[]) => void | Promise<void>): void;
  prepareLaunch(handler: (context: LaunchContext) => void | Promise<void>): void;
  validateLaunch(handler: (spec: LaunchSpec, context: LaunchContext) => void | Promise<void>): void;
  registerHarness(harness: HarnessPlugin): void;
  /** Register a server-default candidate, selectable via rendering.defaultToolRenderer. */
  registerRenderer(renderer: EventRenderer): void;
  /** Register an automatic canonical per-tool renderer; it is not a selectable global default. */
  registerToolRenderer(renderer: EventRenderer): void;
  registerEndpoint(
    name: string,
    handler: (params: unknown, caller: Caller) => unknown | Promise<unknown>,
  ): void;
  registerTool(tool: ToolDefinition): void;
  /** Augment an existing tool's schema and execution without registering a duplicate. */
  transformTool(
    name: string,
    transform: (tool: ToolDefinition) => ToolDefinition,
  ): void;
  /** Runs inside the lifecycle queue before create/modify is persisted or stops a process. */
  beforeSettings(
    handler: (
      settings: Settings,
      agent: Readonly<AgentRecord>,
    ) => Settings | Promise<Settings>,
  ): void;
  onEvent(
    handler: (event: Readonly<ServerEvent>) => void | Promise<void>,
  ): void;
  beforeLaunch(
    handler: (
      spec: LaunchSpec,
      context: LaunchContext,
    ) => LaunchSpec | Promise<LaunchSpec>,
  ): void;
  onShutdown(handler: () => void | Promise<void>): void;
  request(method: string, params: unknown, caller: Caller): Promise<unknown>;
  emit(type: string, data: unknown, agentId?: string): void;
}
export interface ServerPlugin {
  apiVersion: typeof PLUGIN_API_VERSION;
  name: string;
  setup(host: PluginHost): void | Promise<void>;
}
