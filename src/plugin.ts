import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentRecord, Caller, ServerEvent, Settings } from "./types.ts";

import type { ServerSettingsDefinition } from "./server-settings.ts";
export type { ServerSettingsDefinition, ServerSettingsDescriptor, ServerSettingsField, ServerSettingsView, SettingsEffect } from "./server-settings.ts";

export const PLUGIN_API_VERSION = 1 as const;
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
  /** Runs only over persisted records, before startup reconciliation. */
  migrate?(settings: Record<string, unknown>): Record<string, unknown>;
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
  beforeMutation(handler: (context: MutationContext) => MutationChange | void | Promise<MutationChange | void>): void;
  onInitialize(handler: (agents: Readonly<AgentRecord>[]) => void | Promise<void>): void;
  prepareLaunch(handler: (context: LaunchContext) => void | Promise<void>): void;
  validateLaunch(handler: (spec: LaunchSpec, context: LaunchContext) => void | Promise<void>): void;
  registerHarness(harness: HarnessPlugin): void;
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
