import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentRecord, Caller, ServerEvent, Settings } from "./types.ts";

export const PLUGIN_API_VERSION = 1 as const;
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Optional container/wrapper-specific graceful shutdown, bounded by stopTimeoutMs. */
  gracefulStop?: (pid: number) => void | Promise<void>;
}
export interface LaunchContext {
  agent: Readonly<AgentRecord>;
  socketPath: string;
  dataDir: string;
  token: string;
  mcpServers: McpServer[];
}
export interface HarnessPlugin {
  name: string;
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
/** API v1 is additive. Breaking changes require a new apiVersion. Plugins are trusted. */
export interface PluginHost {
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
