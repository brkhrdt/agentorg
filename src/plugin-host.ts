import type { LaunchSpec, MutationChange, PluginHost, ToolDefinition } from "./plugin.ts";
import { ApiError, errorShape } from "./types.ts";

type Callback = (...args: any[]) => any;
const owners = new WeakMap<Callback, string>();
const attributed = new WeakSet<Error>();

export function pluginError(name: string, error: unknown): Error {
  // Keep the originating plugin when callbacks delegate to another plugin.
  if (error instanceof Error && attributed.has(error)) return error;
  const shape = errorShape(error);
  const result = new ApiError(shape.code, pluginMessage(name, shape.message));
  result.cause = error;
  attributed.add(result);
  return result;
}

function pluginMessage(name: string, message: string): string {
  return message.startsWith(`${name}: `) ? message : `${name}: ${message}`;
}

/** Include attribution in host-owned callback timeout diagnostics too. */
export function pluginTimeout(callback: Callback, message: string): string {
  const name = owners.get(callback);
  return name === undefined ? message : pluginMessage(name, message);
}

/** Retain plugin ownership after setup, without exposing organization internals. */
export function pluginHost(host: PluginHost, name: string): PluginHost {
  function wrap<F extends Callback>(callback: F, mapResult?: (result: any) => any): F {
    const wrapped = function (this: unknown, ...args: any[]) {
      try {
        const result = callback.apply(this, args);
        if (result && typeof result.then === "function") {
          return Promise.resolve(result)
            .then(value => mapResult ? mapResult(value) : value)
            .catch(error => { throw pluginError(name, error); });
        }
        return mapResult ? mapResult(result) : result;
      } catch (error) {
        throw pluginError(name, error);
      }
    } as F;
    owners.set(wrapped, name);
    return wrapped;
  }
  function launchSpec(spec: LaunchSpec): LaunchSpec {
    return spec.gracefulStop ? { ...spec, gracefulStop: wrap(spec.gracefulStop) } : spec;
  }
  function mutation(change: MutationChange | void): MutationChange | void {
    return change && {
      ...change,
      apply: wrap(change.apply.bind(change)),
      rollback: wrap(change.rollback.bind(change)),
      committed: wrap(change.committed.bind(change)),
    };
  }
  function tool(definition: ToolDefinition): ToolDefinition {
    return {
      ...definition,
      execute: wrap((args, caller) => definition.execute(args, caller, scoped)),
    };
  }
  const scoped: PluginHost = {
    get dataDir() { return host.dataDir; },
    registerSettings(extension) {
      host.registerSettings({
        ...extension,
        validate: wrap(extension.validate.bind(extension)),
        ...(extension.launchKey && { launchKey: wrap(extension.launchKey.bind(extension)) }),
        ...(extension.migrate && { migrate: wrap(extension.migrate.bind(extension)) }),
      });
    },
    registerCapability: (namespace, value) => host.registerCapability(namespace, value),
    beforeMutation: handler => host.beforeMutation(wrap(handler, mutation)),
    onInitialize: handler => host.onInitialize(wrap(handler)),
    prepareLaunch: handler => host.prepareLaunch(wrap(handler)),
    validateLaunch: handler => host.validateLaunch(wrap(handler)),
    registerHarness(harness) {
      host.registerHarness({ ...harness, launch: wrap(harness.launch.bind(harness), launchSpec) });
    },
    registerEndpoint: (endpoint, handler) => host.registerEndpoint(endpoint, wrap(handler)),
    registerTool: definition => host.registerTool(tool(definition)),
    transformTool: (toolName, transform) => host.transformTool(toolName, wrap(transform, tool)),
    beforeSettings: handler => host.beforeSettings(wrap(handler)),
    onEvent: handler => host.onEvent(wrap(handler)),
    beforeLaunch: handler => host.beforeLaunch(wrap(handler, launchSpec)),
    onShutdown: handler => host.onShutdown(wrap(handler)),
    request: (method, params, caller) => host.request(method, params, caller),
    emit(type, data, agentId) {
      if (/(?:^|[._-])(?:error|warn|warning)$/.test(type)) {
        if (typeof data === "string") data = pluginMessage(name, data);
        else if (data && typeof data === "object" && "message" in data && typeof data.message === "string")
          data = { ...data, message: pluginMessage(name, data.message) };
      }
      host.emit(type, data, agentId);
    },
  };
  return scoped;
}
