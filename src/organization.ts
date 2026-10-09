import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type * as acp from "@agentclientprotocol/sdk";
import { Store } from "./store.ts";
import { AgentProcess, deadline } from "./process.ts";
import type {
  HarnessPlugin,
  LaunchContext,
  LaunchSpec,
  PluginHost,
  ServerPlugin,
  ToolDefinition,
} from "./plugin.ts";
import {
  ApiError,
  bounded,
  defaults,
  errorShape,
  now,
  settingsSchema,
  terminal,
  type AgentRecord,
  type Caller,
  type Limits,
  type Operation,
  type ServerEvent,
  type Settings,
} from "./types.ts";

const object = z.object({}).passthrough();
const target = z.object({ agentId: z.string() });
const page = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(1000).default(100),
  agentId: z.string().optional(),
});
interface ActivePrompt {
  op: Operation;
  work: Promise<acp.PromptResponse>;
  cancelling: boolean;
}
interface Runtime {
  process: AgentProcess;
  generation: string;
  token: string;
  queue: Operation[];
  active?: ActivePrompt;
}
interface Permission {
  agentId: string;
  generation: string;
  options: acp.PermissionOption[];
  finish: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Organization implements PluginHost {
  readonly agents = new Map<string, AgentRecord>();
  readonly operations = new Map<string, Operation>();
  readonly limits: Limits;
  readonly store: Store;
  private runtimes = new Map<string, Runtime>();
  private tokens = new Map<string, string>();
  private harnesses = new Map<string, HarnessPlugin>();
  private endpoints = new Map<
    string,
    (params: unknown, caller: Caller) => unknown | Promise<unknown>
  >();
  private tools = new Map<string, ToolDefinition>();
  private listeners = new Set<(event: ServerEvent) => void>();
  private observers: Array<
    (event: Readonly<ServerEvent>) => void | Promise<void>
  > = [];
  private launchHooks: Array<
    (
      spec: LaunchSpec,
      context: LaunchContext,
    ) => LaunchSpec | Promise<LaunchSpec>
  > = [];
  private settingsHooks: Array<
    (
      settings: Settings,
      agent: Readonly<AgentRecord>,
    ) => Settings | Promise<Settings>
  > = [];
  private shutdownHooks: Array<() => void | Promise<void>> = [];
  private permissions = new Map<string, Permission>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private observerContext = new AsyncLocalStorage<boolean>();
  constructor(
    readonly socketPath: string,
    readonly dataDir: string,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid limit ${name}`);
    }
    if (this.limits.maxResponseBytes < 256)
      throw new Error("maxResponseBytes must be at least 256");
    this.store = new Store(join(dataDir, "organization.sqlite"));
    for (const a of this.store.agents()) this.agents.set(a.id, a);
    for (const op of this.store.operations()) this.operations.set(op.id, op);
    this.registerBuiltinTools();
  }
  async use(plugin: ServerPlugin) {
    if (plugin.apiVersion !== 1)
      throw new Error(
        `Plugin ${plugin.name} requires unsupported API ${plugin.apiVersion}`,
      );
    await plugin.setup(this);
  }
  registerHarness(harness: HarnessPlugin) {
    if (this.harnesses.has(harness.name))
      throw new Error(`Duplicate harness ${harness.name}`);
    this.harnesses.set(harness.name, harness);
  }
  registerEndpoint(
    name: string,
    handler: (params: unknown, caller: Caller) => unknown | Promise<unknown>,
  ) {
    if (
      !name.includes(".") ||
      /^(agent|operation|organization|events|permission|mcp|subscribe)\./.test(
        name,
      ) ||
      this.endpoints.has(name)
    )
      throw new Error(`Invalid/duplicate plugin endpoint ${name}`);
    this.endpoints.set(name, handler);
  }
  registerTool(tool: ToolDefinition) {
    if (!/^[a-zA-Z0-9_]+$/.test(tool.name) || this.tools.has(tool.name))
      throw new Error(`Invalid/duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  transformTool(
    name: string,
    transform: (tool: ToolDefinition) => ToolDefinition,
  ) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const transformed = transform({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
    });
    if (transformed.name !== name)
      throw new Error("Tool transformations cannot rename tools");
    this.tools.set(name, transformed);
  }
  beforeSettings(
    handler: (
      settings: Settings,
      agent: Readonly<AgentRecord>,
    ) => Settings | Promise<Settings>,
  ) {
    this.settingsHooks.push(handler);
  }
  private async prepareSettings(
    settings: Settings,
    agent: AgentRecord,
  ): Promise<Settings> {
    for (const hook of this.settingsHooks)
      settings = settingsSchema.parse(
        await hook(structuredClone(settings), structuredClone(agent)),
      );
    return { ...settings, cwd: resolve(settings.cwd ?? process.cwd()) };
  }
  onEvent(handler: (event: Readonly<ServerEvent>) => void | Promise<void>) {
    this.observers.push(handler);
  }
  beforeLaunch(
    handler: (
      spec: LaunchSpec,
      context: LaunchContext,
    ) => LaunchSpec | Promise<LaunchSpec>,
  ) {
    this.launchHooks.push(handler);
  }
  onShutdown(handler: () => void | Promise<void>) {
    this.shutdownHooks.push(handler);
  }
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(type: string, data: unknown, agentId?: string, generation?: string) {
    const event = this.store.event(
      {
        kind: "event",
        time: now(),
        type,
        agentId,
        generation,
        data: bounded(data, this.limits.maxResponseBytes),
      },
      this.limits.maxEvents,
    );
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
    // Hooks do not block lifecycle or transport; recursive hook emission is not re-observed.
    if (this.observerContext.getStore() || type === "plugin.error") return;
    for (const observer of this.observers) {
      this.observerContext.run(true, () => {
        try {
          Promise.resolve(observer(structuredClone(event))).catch((error) => {
            if (!this.closing) this.emit("plugin.error", errorShape(error));
          });
        } catch (error) {
          this.emit("plugin.error", errorShape(error));
        }
      });
    }
  }
  private serialize<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        if (!this.closing) this.pump();
      });
    return result;
  }
  private saveAgent(a: AgentRecord) {
    a.updatedAt = now();
    this.store.saveAgent(a);
  }
  private state(a: AgentRecord, state: AgentRecord["state"], error?: string) {
    a.state = state;
    a.error = error;
    this.saveAgent(a);
    this.emit(
      "agent.state",
      { state, error, revision: a.revision },
      a.id,
      a.generation ?? undefined,
    );
  }
  private saveOp(op: Operation) {
    this.store.saveOperation(op);
    this.emit("operation.changed", op, op.agentId ?? undefined);
    const done = [...this.operations.values()].filter(terminal);
    for (const old of done.slice(
      0,
      Math.max(0, done.length - this.limits.maxOperations),
    )) {
      this.operations.delete(old.id);
      this.store.deleteOperation(old.id);
    }
  }
  private finish(
    op: Operation,
    status: "completed" | "failed" | "stopped",
    result?: unknown,
    error?: unknown,
  ) {
    if (terminal(op)) return;
    op.status = status;
    op.completedAt = now();
    op.result = bounded(result, this.limits.maxResponseBytes);
    if (error) op.error = errorShape(error);
    this.saveOp(op);
  }
  private newOp(
    type: string,
    agentId: string | null,
    input: unknown,
    caller: Caller,
  ): Operation {
    const op: Operation = {
      id: crypto.randomUUID(),
      type,
      agentId,
      input: structuredClone(input),
      caller,
      status: "queued",
      createdAt: now(),
    };
    this.operations.set(op.id, op);
    this.saveOp(op);
    return op;
  }
  private agent(id: string, active = true): AgentRecord {
    const a = this.agents.get(id);
    if (!a || (active && a.removedAt))
      throw new ApiError("NOT_FOUND", `Agent ${id} not found`);
    return a;
  }
  isDescendant(id: string, ancestor: string, self = true): boolean {
    let a = this.agents.get(id);
    if (!self) a = a?.parentId ? this.agents.get(a.parentId) : undefined;
    while (a) {
      if (a.id === ancestor) return true;
      a = a.parentId ? this.agents.get(a.parentId) : undefined;
    }
    return false;
  }
  private authorize(caller: Caller, id: string, manage = false) {
    if (caller.kind === "agent" && !this.isDescendant(id, caller.id, !manage))
      throw new ApiError(
        "FORBIDDEN",
        "Agents may manage only descendants, and read themselves",
      );
  }
  private authorizeOp(caller: Caller, op: Operation) {
    if (caller.kind === "agent" && op.caller.id !== caller.id) {
      if (!op.agentId)
        throw new ApiError("FORBIDDEN", "Operation outside caller subtree");
      this.authorize(caller, op.agentId, true);
    }
  }
  callerForToken(token: string): Caller {
    const id = this.tokens.get(token);
    if (!id || !this.runtimes.has(id))
      throw new ApiError("FORBIDDEN", "Expired agent capability");
    return { kind: "agent", id };
  }
  async initialize(recover = false) {
    await this.serialize(async () => {
      for (const op of this.operations.values())
        if (!terminal(op))
          this.finish(
            op,
            "stopped",
            undefined,
            new ApiError("INTERRUPTED", "Server restarted"),
          );
      const candidates = [...this.agents.values()].filter(
        (a) => !a.removedAt && !["stopped", "failed"].includes(a.state),
      );
      for (const a of candidates) {
        a.generation = null;
        this.state(a, recover ? "recovering" : "stopped");
      }
      if (recover)
        for (const a of candidates.sort(
          (a, b) => this.depth(a) - this.depth(b),
        )) {
          try {
            await this.start(a, true);
          } catch (error) {
            this.state(a, "failed", errorShape(error).message);
          }
        }
      this.emit("server.ready", { recover, limits: this.limits });
    });
  }
  private depth(a: AgentRecord): number {
    let depth = 0;
    while (a.parentId) {
      a = this.agent(a.parentId, false);
      depth++;
    }
    return depth;
  }
  private subtree(a: AgentRecord): AgentRecord[] {
    return [...this.agents.values()]
      .filter((x) => !x.removedAt && this.isDescendant(x.id, a.id))
      .sort((x, y) => this.depth(x) - this.depth(y));
  }
  private lifecycle(
    type: string,
    id: string | null,
    params: unknown,
    caller: Caller,
    work: (op: Operation) => Promise<unknown>,
  ): Operation {
    const op = this.newOp(type, id, params, caller);
    void this.serialize(async () => {
      if (terminal(op)) return;
      if (this.closing) {
        this.finish(op, "stopped");
        return;
      }
      op.status = "running";
      op.startedAt = now();
      this.saveOp(op);
      try {
        this.finish(op, "completed", await work(op));
      } catch (error) {
        this.finish(op, "failed", undefined, error);
      }
    });
    return structuredClone(op);
  }
  async request(
    method: string,
    params: unknown = {},
    caller: Caller = { kind: "server", id: "server" },
  ): Promise<unknown> {
    if (this.closing)
      throw new ApiError("SHUTTING_DOWN", "Server is shutting down");
    switch (method) {
      case "organization.snapshot":
        return {
          seq: this.store.sequence(),
          agents: [...this.agents.values()]
            .filter(
              (a) =>
                caller.kind !== "agent" || this.isDescendant(a.id, caller.id),
            )
            .map((a) => structuredClone(a)),
          operations: [...this.operations.values()]
            .filter((op) => {
              try {
                this.authorizeOp(caller, op);
                return true;
              } catch {
                return false;
              }
            })
            .map((op) => structuredClone(op)),
        };
      case "agent.get": {
        const { agentId } = target.parse(params);
        this.authorize(caller, agentId);
        return structuredClone(this.agent(agentId, false));
      }
      case "agent.create": {
        const p = z
          .object({
            parentId: z.string().nullable().default(null),
            name: z.string().min(1).max(256).default("agent"),
            metadata: z.record(z.string(), z.unknown()).default({}),
            settings: settingsSchema,
          })
          .strict()
          .parse(params);
        if (caller.kind === "agent" && p.parentId !== caller.id)
          throw new ApiError(
            "FORBIDDEN",
            "An agent may create only its own direct children",
          );
        return this.lifecycle(method, p.parentId, p, caller, async (op) => {
          if (this.agents.size >= this.limits.maxAgents)
            throw new ApiError("LIMIT", "Agent record limit reached");
          if (!this.harnesses.has(p.settings.harness))
            throw new ApiError(
              "INVALID_HARNESS",
              `Unknown harness ${p.settings.harness}`,
            );
          if (p.parentId) {
            const parent = this.agent(p.parentId);
            if (this.depth(parent) + 1 > this.limits.maxDepth)
              throw new ApiError("LIMIT", "Organization depth limit reached");
            if (
              [...this.agents.values()].filter(
                (a) => !a.removedAt && a.parentId === parent.id,
              ).length >= this.limits.maxChildren
            )
              throw new ApiError("LIMIT", "Children limit reached");
          } else if (
            [...this.agents.values()].some((a) => !a.removedAt && !a.parentId)
          )
            throw new ApiError("ROOT_EXISTS", "An active root already exists");
          const a: AgentRecord = {
            id: crypto.randomUUID(),
            parentId: p.parentId,
            name: p.name,
            metadata: p.metadata,
            settings: p.settings,
            state: "starting",
            revision: 1,
            generation: null,
            sessionId: crypto.randomUUID(),
            sessionNumber: 1,
            removedAt: null,
            createdAt: now(),
            updatedAt: now(),
          };
          a.settings = await this.prepareSettings(a.settings, a);
          this.agents.set(a.id, a);
          this.saveAgent(a);
          op.agentId = a.id;
          this.saveOp(op);
          this.emit("agent.created", a, a.id);
          await this.start(a, false);
          return structuredClone(a);
        });
      }
      case "agent.modify": {
        const p = z
          .object({
            agentId: z.string(),
            expectedRevision: z.number().int().optional(),
            name: z.string().min(1).max(256).optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            settings: settingsSchema.partial().optional(),
          })
          .strict()
          .parse(params);
        this.authorize(caller, p.agentId, true);
        return this.lifecycle(method, p.agentId, p, caller, async () => {
          const a = this.agent(p.agentId);
          if (
            p.expectedRevision !== undefined &&
            p.expectedRevision !== a.revision
          )
            throw new ApiError("CONFLICT", "Stale agent revision");
          const settings = await this.prepareSettings(
            settingsSchema.parse({ ...a.settings, ...p.settings }),
            a,
          );
          if (!this.harnesses.has(settings.harness))
            throw new ApiError(
              "INVALID_HARNESS",
              `Unknown harness ${settings.harness}`,
            );
          const launchChanged = !isDeepStrictEqual(settings, a.settings);
          const active = this.runtimes.has(a.id);
          if (launchChanged && active) await this.stop(a);
          if (p.name !== undefined) a.name = p.name;
          if (p.metadata !== undefined) a.metadata = p.metadata;
          const harnessChanged = settings.harness !== a.settings.harness;
          a.settings = settings;
          a.revision++;
          if (harnessChanged) {
            a.sessionId = crypto.randomUUID();
            a.sessionNumber++;
          }
          this.saveAgent(a);
          this.emit("agent.modified", a, a.id);
          if (launchChanged && active) await this.start(a, !harnessChanged);
          return structuredClone(a);
        });
      }
      case "agent.stop":
      case "agent.restart":
      case "agent.restart_subtree":
      case "agent.replace_session":
      case "agent.remove": {
        const p = target.strict().parse(params);
        this.authorize(caller, p.agentId, true);
        return this.lifecycle(method, p.agentId, p, caller, async () => {
          const a = this.agent(p.agentId);
          const tree =
            method === "agent.remove" || method === "agent.restart_subtree"
              ? this.subtree(a)
              : [a];
          for (const x of [...tree].reverse()) await this.stop(x);
          if (method === "agent.remove") {
            for (const x of tree) {
              x.removedAt = now();
              x.revision++;
              this.saveAgent(x);
              this.emit("agent.removed", { removedAt: x.removedAt }, x.id);
            }
          } else if (method !== "agent.stop") {
            if (method === "agent.replace_session") {
              a.sessionId = crypto.randomUUID();
              a.sessionNumber++;
              a.revision++;
              this.saveAgent(a);
              this.emit(
                "agent.session_replaced",
                { sessionNumber: a.sessionNumber },
                a.id,
              );
            }
            const errors: string[] = [];
            for (const x of tree) {
              try {
                await this.start(x, method !== "agent.replace_session");
              } catch (error) {
                errors.push(`${x.id}: ${errorShape(error).message}`);
              }
            }
            if (errors.length)
              throw new ApiError("START_FAILED", errors.join("; "));
          }
          return structuredClone(a);
        });
      }
      case "agent.prompt": {
        const p = z
          .object({
            agentId: z.string(),
            text: z.string().min(1),
            queue: z.boolean().default(false),
          })
          .strict()
          .parse(params);
        this.authorize(caller, p.agentId, true);
        if (Buffer.byteLength(p.text) > this.limits.maxPromptBytes)
          throw new ApiError("LIMIT", "Prompt size limit reached");
        return this.serialize(() => {
          const a = this.agent(p.agentId);
          const rt = this.runtimes.get(a.id);
          if (!rt || ["stopped", "failed", "starting"].includes(a.state))
            throw new ApiError("NOT_RUNNING", "Agent is not available");
          if (p.queue && rt.queue.length >= this.limits.maxQueuedPrompts)
            throw new ApiError("LIMIT", "Prompt queue limit reached");
          if (!p.queue) {
            for (const queued of rt.queue.splice(0))
              this.finish(
                queued,
                "stopped",
                undefined,
                new ApiError("SUPERSEDED", "Prompt superseded"),
              );
            if (rt.active) this.cancelPrompt(a, rt, rt.active);
          }
          const op = this.newOp(method, a.id, p, caller);
          rt.queue.push(op);
          if (!rt.active) this.state(a, "waiting");
          this.emit(
            "prompt.queued",
            { operationId: op.id, text: p.text },
            a.id,
            rt.generation,
          );
          return structuredClone(op);
        });
      }
      case "operation.get":
      case "operation.wait": {
        const p = z
          .object({
            operationId: z.string(),
            waitMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .parse(params);
        const op = this.operations.get(p.operationId);
        if (!op) throw new ApiError("NOT_FOUND", "Operation not found");
        this.authorizeOp(caller, op);
        if (method === "operation.wait" && !terminal(op))
          await this.wait(
            op,
            Math.min(p.waitMs ?? 1000, this.limits.maxWaitMs),
          );
        return structuredClone(op);
      }
      case "operation.cancel": {
        const p = z.object({ operationId: z.string() }).strict().parse(params);
        const op = this.operations.get(p.operationId);
        if (!op) throw new ApiError("NOT_FOUND", "Operation not found");
        this.authorizeOp(caller, op);
        // Queued lifecycle cancellation bypasses the queue currently running another lifecycle operation.
        if (op.status === "queued" && op.type !== "agent.prompt") {
          this.finish(op, "stopped");
          return structuredClone(op);
        }
        if (terminal(op)) return structuredClone(op);
        if (op.type !== "agent.prompt")
          throw new ApiError(
            "NOT_CANCELLABLE",
            "A running lifecycle mutation cannot be rolled back; stop its target afterward",
          );
        return this.serialize(() => {
          const rt = op.agentId ? this.runtimes.get(op.agentId) : undefined;
          if (rt?.active?.op.id === op.id)
            this.cancelPrompt(this.agent(op.agentId!), rt, rt.active);
          else {
            if (rt) rt.queue = rt.queue.filter((x) => x.id !== op.id);
            this.finish(op, "stopped");
          }
          return structuredClone(op);
        });
      }
      case "events.history": {
        const p = page.parse(params);
        if (caller.kind === "agent" && !p.agentId) p.agentId = caller.id;
        if (p.agentId) this.authorize(caller, p.agentId);
        return this.store.history(p.after, p.limit, p.agentId);
      }
      case "permission.respond": {
        const p = z
          .object({
            permissionId: z.string(),
            optionId: z.string().optional(),
            cancelled: z.boolean().optional(),
          })
          .strict()
          .parse(params);
        const permission = this.permissions.get(p.permissionId);
        if (!permission) throw new ApiError("NOT_FOUND", "Permission expired");
        this.authorize(caller, permission.agentId, true);
        if (
          !p.cancelled &&
          !permission.options.some((x) => x.optionId === p.optionId)
        )
          throw new ApiError("INVALID_PARAMS", "Unknown permission option");
        permission.finish(
          p.cancelled
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: p.optionId! } },
        );
        return { accepted: true };
      }
      case "mcp.list": {
        if (caller.kind !== "agent")
          throw new ApiError("FORBIDDEN", "MCP requires an agent capability");
        return {
          tools: [...this.tools.values()].map(
            ({ execute, ...definition }) => definition,
          ),
        };
      }
      case "mcp.call": {
        if (caller.kind !== "agent")
          throw new ApiError("FORBIDDEN", "MCP requires an agent capability");
        const p = z
          .object({ name: z.string(), arguments: object.default({}) })
          .strict()
          .parse(params);
        const tool = this.tools.get(p.name);
        if (!tool) throw new ApiError("NOT_FOUND", "Unknown MCP tool");
        try {
          const result = bounded(
            await tool.execute(p.arguments, caller, this),
            this.limits.maxResponseBytes,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result ?? null) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(errorShape(error)) },
            ],
          };
        }
      }
      default: {
        const endpoint = this.endpoints.get(method);
        if (!endpoint)
          throw new ApiError("METHOD_NOT_FOUND", `Unknown method ${method}`);
        try {
          return bounded(
            await endpoint(params, caller),
            this.limits.maxResponseBytes,
          );
        } catch (error) {
          this.emit("plugin.error", { method, ...errorShape(error) });
          throw error;
        }
      }
    }
  }
  private wait(op: Operation, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsub();
        resolve();
      };
      const unsub = this.subscribe((event) => {
        if (event.type === "operation.changed" && terminal(op)) done();
      });
      const timer = setTimeout(done, ms);
      if (terminal(op)) done();
    });
  }
  private mcpServers(token: string): acp.McpServer[] {
    return [
      {
        name: "organization",
        command: process.execPath,
        args: [join(import.meta.dir, "mcp-bridge.ts")],
        env: [
          { name: "ORG_SOCKET", value: this.socketPath },
          { name: "ORG_TOKEN", value: token },
        ],
      },
    ];
  }
  private async start(a: AgentRecord, resume: boolean) {
    if (this.runtimes.size >= this.limits.maxProcesses) {
      this.state(a, "failed", "Process limit reached");
      throw new ApiError("LIMIT", "Process limit reached");
    }
    const harness = this.harnesses.get(a.settings.harness);
    if (!harness) {
      this.state(a, "failed", "Harness unavailable");
      throw new ApiError(
        "INVALID_HARNESS",
        `Unknown harness ${a.settings.harness}`,
      );
    }
    const generation = crypto.randomUUID(),
      token = crypto.randomUUID();
    a.generation = generation;
    this.state(a, "starting");
    const context: LaunchContext = {
      agent: structuredClone(a),
      socketPath: this.socketPath,
      dataDir: this.dataDir,
      token,
      mcpServers: this.mcpServers(token),
    };
    let rt: Runtime | undefined;
    try {
      let spec = await deadline(
        Promise.resolve(harness.launch(context)),
        this.limits.startTimeoutMs,
        "Harness launch timed out",
      );
      for (const hook of this.launchHooks)
        spec = await deadline(
          Promise.resolve(hook(spec, context)),
          this.limits.startTimeoutMs,
          "Launch hook timed out",
        );
      spec = {
        ...spec,
        cwd: spec.cwd ?? a.settings.cwd ?? process.cwd(),
        env: { ...process.env, ...a.settings.env, ...spec.env },
      };
      const proc = new AgentProcess(
        spec,
        this.limits,
        (notification) => {
          if (!this.closing)
            void this.serialize(() =>
              this.update(a.id, generation, notification),
            );
        },
        (request) => this.permission(a.id, generation, request),
        (message) => {
          if (!this.closing)
            void this.serialize(() => this.crashed(a.id, generation, message));
        },
      );
      rt = { process: proc, generation, token, queue: [] };
      this.runtimes.set(a.id, rt);
      this.tokens.set(token, a.id);
      await deadline(
        proc.start(spec.cwd!, a.sessionId, context.mcpServers, resume),
        this.limits.startTimeoutMs,
        "ACP startup timed out",
      );
      a.sessionId = proc.sessionId;
      this.state(a, "idle");
    } catch (error) {
      if (rt) {
        this.runtimes.delete(a.id);
        this.tokens.delete(token);
        await rt.process.stop();
      }
      a.generation = null;
      this.state(a, "failed", errorShape(error).message);
      throw error;
    }
  }
  private async stop(a: AgentRecord, error?: Error) {
    const rt = this.runtimes.get(a.id);
    if (rt) {
      this.runtimes.delete(a.id);
      this.tokens.delete(rt.token);
      this.cancelPermissions(a.id);
      for (const op of rt.queue) this.finish(op, "stopped");
      await rt.process.stop();
      if (rt.active)
        this.finish(
          rt.active.op,
          error && !rt.active.op.cancelRequested ? "failed" : "stopped",
          rt.active.op.result,
          error,
        );
    }
    a.generation = null;
    this.state(a, "stopped");
  }
  private async crashed(id: string, generation: string, message: string) {
    const rt = this.runtimes.get(id);
    if (!rt || rt.generation !== generation) return;
    const a = this.agent(id);
    await this.stop(a, new ApiError("PROCESS_EXITED", message));
    this.state(a, "failed", message);
    this.emit("agent.error", { message }, id, generation);
  }
  private update(
    id: string,
    generation: string,
    notification: acp.SessionNotification,
  ) {
    const rt = this.runtimes.get(id);
    if (
      !rt ||
      rt.generation !== generation ||
      notification.sessionId !== rt.process.sessionId
    )
      return;
    const u = notification.update;
    if (
      u.sessionUpdate === "agent_message_chunk" &&
      u.content.type === "text" &&
      rt.active
    ) {
      const op = rt.active.op;
      const text = (op.result as { text?: string } | undefined)?.text ?? "";
      const bytes = Buffer.from(text + u.content.text);
      op.result = {
        text: bytes
          .subarray(0, this.limits.maxResponseBytes - 128)
          .toString("utf8"),
        truncated:
          bytes.length > this.limits.maxResponseBytes - 128 ||
          (op.result as any)?.truncated === true,
      };
    }
    const category =
      u.sessionUpdate === "tool_call"
        ? "tool.call"
        : u.sessionUpdate === "tool_call_update"
          ? u.status === "completed" || u.status === "failed"
            ? "tool.result"
            : "tool.update"
          : u.sessionUpdate === "plan"
            ? "agent.plan"
            : u.sessionUpdate.includes("message") ||
                u.sessionUpdate.includes("thought")
              ? "agent.message"
              : "agent.update";
    this.emit(category, u, id, generation);
  }
  private pump() {
    let active = [...this.runtimes.values()].filter((rt) => rt.active).length;
    for (const [id, rt] of this.runtimes) {
      if (active >= this.limits.maxPrompts) break;
      if (rt.active || !rt.queue.length) continue;
      const op = rt.queue.shift()!;
      if (terminal(op)) continue;
      const a = this.agent(id);
      active++;
      op.status = "running";
      op.startedAt = now();
      this.saveOp(op);
      this.state(a, "running");
      this.emit("prompt.started", { operationId: op.id }, id, rt.generation);
      const work = rt.process.prompt((op.input as { text: string }).text);
      rt.active = { op, work, cancelling: false };
      void work.then(
        (result) => {
          if (!this.closing)
            return this.serialize(() =>
              this.completePrompt(id, rt, op, result),
            );
        },
        (error) => {
          if (!this.closing)
            return this.serialize(() =>
              this.completePrompt(id, rt, op, undefined, error),
            );
        },
      );
    }
  }
  private completePrompt(
    id: string,
    rt: Runtime,
    op: Operation,
    response?: acp.PromptResponse,
    error?: unknown,
  ) {
    if (this.runtimes.get(id) !== rt || rt.active?.op.id !== op.id) return;
    rt.active = undefined;
    this.cancelPermissions(id);
    if (error)
      this.emit(
        "agent.error",
        { operationId: op.id, ...errorShape(error) },
        id,
        rt.generation,
      );
    this.finish(
      op,
      op.cancelRequested || response?.stopReason === "cancelled"
        ? "stopped"
        : error
          ? "failed"
          : "completed",
      { ...((op.result as object) ?? {}), stopReason: response?.stopReason },
      error,
    );
    this.emit(
      "prompt.finished",
      { operationId: op.id, status: op.status },
      id,
      rt.generation,
    );
    this.state(this.agent(id), rt.queue.length ? "waiting" : "idle");
  }
  private cancelPrompt(a: AgentRecord, rt: Runtime, active: ActivePrompt) {
    if (active.cancelling) return;
    active.cancelling = true;
    active.op.cancelRequested = true;
    this.saveOp(active.op);
    this.cancelPermissions(a.id);
    this.emit(
      "prompt.cancelling",
      { operationId: active.op.id },
      a.id,
      rt.generation,
    );
    void deadline(
      Promise.all([rt.process.cancel(), active.work.catch(() => {})]),
      this.limits.cancelTimeoutMs,
      "ACP cancellation timed out",
    ).catch((error) =>
      this.serialize(async () => {
        if (
          !this.closing &&
          this.runtimes.get(a.id) === rt &&
          rt.active === active
        ) {
          await this.stop(a);
          this.state(a, "failed", errorShape(error).message);
        }
      }),
    );
  }
  private permission(
    id: string,
    generation: string,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const rt = this.runtimes.get(id);
    if (!rt || rt.generation !== generation || rt.active?.cancelling)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (value: acp.RequestPermissionResponse) => {
        const p = this.permissions.get(permissionId);
        if (!p) return;
        clearTimeout(p.timer);
        this.permissions.delete(permissionId);
        resolve(value);
        this.emit(
          "permission.resolved",
          { permissionId, ...value },
          id,
          generation,
        );
        if (this.runtimes.get(id) === rt && rt.active)
          this.state(this.agent(id), "running");
      };
      const timer = setTimeout(
        () => finish({ outcome: { outcome: "cancelled" } }),
        this.limits.maxWaitMs,
      );
      this.permissions.set(permissionId, {
        agentId: id,
        generation,
        options: request.options,
        finish,
        timer,
      });
      this.state(this.agent(id), "waiting");
      this.emit(
        "permission.requested",
        { permissionId, ...request },
        id,
        generation,
      );
    });
  }
  private cancelPermissions(id: string) {
    for (const p of [...this.permissions.values()])
      if (p.agentId === id) p.finish({ outcome: { outcome: "cancelled" } });
  }
  private registerBuiltinTools() {
    const id = { type: "string" };
    const add = (
      name: string,
      method: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[] = [],
    ) =>
      this.registerTool({
        name,
        description,
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
        execute: (args, caller) => this.request(method, args, caller),
      });
    this.registerTool({
      name: "child_create",
      description:
        "Create your own direct child. Returns a lifecycle operation; use operation_wait until completed to obtain result.id. Children may use a different harness/model.",
      inputSchema: {
        type: "object",
        properties: {
          name: id,
          settings: {
            type: "object",
            properties: {
              harness: id,
              model: id,
              provider: id,
              cwd: id,
              options: { type: "object" },
              env: { type: "object" },
            },
            required: ["harness", "model"],
            additionalProperties: false,
          },
        },
        required: ["settings"],
        additionalProperties: false,
      },
      execute: (args, caller) =>
        this.request(
          "agent.create",
          { ...object.parse(args), parentId: caller.id },
          caller,
        ),
    });
    add(
      "descendant_prompt",
      "agent.prompt",
      "Send work to a descendant. Default supersedes active and queued prompts; queue=true appends FIFO. Returns operation ID.",
      { agentId: id, text: id, queue: { type: "boolean" } },
      ["agentId", "text"],
    );
    add(
      "agent_get",
      "agent.get",
      "Inspect yourself or a descendant, including historical records.",
      { agentId: id },
      ["agentId"],
    );
    add(
      "organization_snapshot",
      "organization.snapshot",
      "List your subtree and operations.",
      {},
    );
    for (const action of [
      "stop",
      "restart",
      "restart_subtree",
      "replace_session",
      "remove",
    ])
      add(
        `descendant_${action}`,
        `agent.${action}`,
        `Request ${action} for a descendant. Removal stops its subtree but keeps workspaces and history.`,
        { agentId: id },
        ["agentId"],
      );
    add(
      "descendant_modify",
      "agent.modify",
      "Modify descendant settings (active process restarts) or metadata/name; expectedRevision rejects stale changes.",
      {
        agentId: id,
        expectedRevision: { type: "integer" },
        name: id,
        metadata: { type: "object" },
        settings: { type: "object" },
      },
      ["agentId"],
    );
    add(
      "operation_get",
      "operation.get",
      "Query an operation in your subtree.",
      { operationId: id },
      ["operationId"],
    );
    add(
      "operation_wait",
      "operation.wait",
      "Wait up to 30 seconds without cancelling. Repeat until completed/failed/stopped; result.text contains prompt output. Waiting consumes your current prompt slot: leave room for children.",
      {
        operationId: id,
        waitMs: { type: "integer", minimum: 0, maximum: 30000 },
      },
      ["operationId"],
    );
    add(
      "operation_cancel",
      "operation.cancel",
      "Cancel queued work immediately; active prompts remain running until ACP acknowledges cancellation or the process is killed.",
      { operationId: id },
      ["operationId"],
    );
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.serialize(async () => {
      for (const a of [...this.agents.values()]
        .filter((a) => this.runtimes.has(a.id))
        .sort((a, b) => this.depth(b) - this.depth(a)))
        await this.stop(a);
      for (const op of this.operations.values())
        if (!terminal(op)) this.finish(op, "stopped");
      this.emit("server.stopped", {});
      for (const hook of this.shutdownHooks) {
        try {
          await deadline(
            Promise.resolve(hook()),
            this.limits.stopTimeoutMs,
            "Plugin shutdown timed out",
          );
        } catch (error) {
          this.emit("plugin.error", errorShape(error));
        }
      }
      this.listeners.clear();
      this.store.close();
    });
    return this.closePromise;
  }
}
