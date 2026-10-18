import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ApiError, defaults, type Limits, type ServerEvent } from "./types.ts";
import type { Store } from "./store.ts";

export type SettingsEffect = "immediate" | "future-launch" | "restart";
export interface ServerSettingsField {
  key: string;
  label: string;
  description?: string;
  /** Public compatibility field; omit from normal editing, never a secret mask. */
  deprecated?: boolean;
  /** Missing values inherit the plugin/runtime default; forms can reset to absence. */
  optional?: boolean;
  editor: "text" | "number" | "boolean" | "select" | "list" | "string-map" | "object-map";
  effect: SettingsEffect;
  choices?: string[];
  min?: number;
  max?: number;
  /** Server-side suggestions; returns {choices: [{value, label}]}. */
  choicesEndpoint?: string;
  /** Portable record-list/map form, rather than requiring raw JSON entries. */
  itemFields?: ServerSettingsField[];
  itemDefaults?: Record<string, unknown>;
  itemDefaultsFrom?: Record<string, string>;
  itemIdKey?: string;
  itemLabelKey?: string;
}
/** Public, non-secret configuration only. Core owns storage, fencing and access. */
export interface ServerSettingsDefinition {
  namespace: string;
  title: string;
  /** Set by the scoped plugin host, not by clients. */
  plugin?: string;
  description?: string;
  version: number;
  defaults: Record<string, unknown>;
  fields: ServerSettingsField[];
  /** Pure synchronous validation/normalization of the complete public configuration. */
  validate(value: Record<string, unknown>): Record<string, unknown>;
  /** Pure migration of persisted overrides; unknown/newer versions fail closed. */
  migrate?(overrides: Record<string, unknown>, fromVersion: number): Record<string, unknown>;
  /** Optional bounded, side-effect-free availability check before a changed save.
   * Runs in the mutation queue, never on ordinary reads. Persistence stays core-owned. */
  validateChange?(value: Record<string, unknown>, previous: Record<string, unknown>): void | Promise<void>;
}
export interface ServerSettingsRecord {
  namespace: string;
  version: number;
  revision: number;
  overrides: Record<string, unknown>;
}
export interface ServerSettingsDescriptor {
  namespace: string;
  title: string;
  plugin?: string;
  description?: string;
  version: number;
  fields: ServerSettingsField[];
}
export interface ServerSettingsView extends ServerSettingsDescriptor {
  revision: number;
  defaults: Record<string, unknown>;
  values: Record<string, unknown>;
  effective: Record<string, unknown>;
  overridden: string[];
  restartRequired: string[];
}
const key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/).max(128).refine(v => !["__proto__", "constructor", "prototype"].includes(v));
const basicFieldSchema = z.object({
  key, label: z.string().min(1).max(128), description: z.string().max(4096).optional(), deprecated: z.boolean().optional(), optional: z.boolean().optional(),
  editor: z.enum(["text", "number", "boolean", "select", "list", "string-map", "object-map"]),
  effect: z.enum(["immediate", "future-launch", "restart"]),
  choices: z.array(z.string()).min(1).max(1000).optional(), min: z.number().finite().optional(), max: z.number().finite().optional(),
  choicesEndpoint: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128).optional(),
}).strict();
const descriptorSchema = z.object({
  namespace: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128),
  title: z.string().min(1).max(128), plugin: z.string().min(1).max(128).optional(), description: z.string().max(4096).optional(),
  version: z.number().int().positive(),
  fields: z.array(basicFieldSchema.extend({
    itemFields: z.array(basicFieldSchema).min(1).max(128).optional(),
    itemDefaults: z.record(key, z.json()).optional(), itemDefaultsFrom: z.record(key, key).optional(), itemIdKey: key.optional(), itemLabelKey: key.optional(),
  }).strict()).min(1).max(128),
}).strict();
const recordSchema = z.object({ namespace: z.string(), version: z.number().int().positive(), revision: z.number().int().nonnegative(), overrides: z.record(key, z.json()) }).strict();
const changeSchema = z.object({
  namespace: z.string(), expectedRevision: z.number().int().nonnegative(),
  patch: z.record(key, z.json()).default({}), reset: z.array(key).max(128).default([]),
}).strict();

export class ServerSettingsRegistry {
  private groups = new Map<string, { definition: ServerSettingsDefinition; descriptor: ServerSettingsDescriptor; record: ServerSettingsRecord; effective: Record<string, unknown> }>();
  constructor(private store: Store) {}
  register(definition: ServerSettingsDefinition) {
    const descriptor = descriptorSchema.parse({ namespace: definition.namespace, title: definition.title, plugin: definition.plugin, description: definition.description, version: definition.version, fields: definition.fields });
    if (this.groups.has(descriptor.namespace)) throw new Error(`Duplicate server settings namespace ${descriptor.namespace}`);
    if (new Set(descriptor.fields.map(f => f.key)).size !== descriptor.fields.length) throw new Error("Duplicate server settings field");
    for (const field of descriptor.fields) if (!field.itemFields && (field.itemDefaults || field.itemDefaultsFrom || field.itemIdKey || field.itemLabelKey)) throw new Error("Record metadata requires itemFields");
    for (const field of descriptor.fields) if (field.itemFields) {
      if (!["list", "object-map"].includes(field.editor) || !field.itemDefaults || new Set(field.itemFields.map(f => f.key)).size !== field.itemFields.length)
        throw new Error("Invalid record-list/map descriptor");
      if (field.editor === "object-map" && (!field.choicesEndpoint || field.itemIdKey)) throw new Error("Record-map forms require a key choices endpoint and no itemIdKey");
      for (const name of [field.itemIdKey, field.itemLabelKey]) if (name && !field.itemFields.some(f => f.key === name && f.editor === "text")) throw new Error("Invalid record identity/label field");
      for (const [target, source] of Object.entries(field.itemDefaultsFrom ?? {}))
        if (!field.itemFields.some(f => f.key === target) || !descriptor.fields.some(f => f.key === source)) throw new Error("Invalid record default source");
      this.validate({ ...definition, fields: field.itemFields, validate: value => value }, field.itemDefaults);
    }
    const owned = { ...definition, defaults: structuredClone(definition.defaults), fields: descriptor.fields };
    const baseline = this.validate(owned, owned.defaults);
    if (!isDeepStrictEqual(baseline, owned.defaults)) throw new Error("Server settings defaults must be normalized");
    const saved = this.store.serverSettings(descriptor.namespace);
    let record: ServerSettingsRecord = saved ? recordSchema.parse(saved) : { namespace: descriptor.namespace, version: descriptor.version, revision: 0, overrides: {} };
    if (record.namespace !== descriptor.namespace) throw new Error("Server settings namespace mismatch");
    const migrating = record.version !== descriptor.version;
    if (migrating) {
      if (record.version > descriptor.version || !definition.migrate) throw new Error(`Unsupported ${descriptor.namespace} settings version ${record.version}`);
      record = { ...record, version: descriptor.version, revision: record.revision + 1, overrides: definition.migrate(structuredClone(record.overrides), record.version) };
    }
    this.checkKeys(owned, record.overrides);
    const effective = this.validate(owned, { ...owned.defaults, ...record.overrides });
    // Migration completes before hooks/recovery can consume settings.
    if (migrating) {
      for (const name of Object.keys(record.overrides)) record.overrides[name] = effective[name];
      this.store.saveServerSettings(record);
    }
    this.groups.set(descriptor.namespace, { definition: owned, descriptor, record: structuredClone(record), effective });
  }
  private checkKeys(definition: ServerSettingsDefinition, value: Record<string, unknown>) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_PARAMS", "Settings must be an object");
    for (const name of Object.keys(value)) if (!definition.fields.some(f => f.key === name)) throw new ApiError("INVALID_PARAMS", `Unknown server setting ${name}`);
  }
  private validate(definition: ServerSettingsDefinition, value: Record<string, unknown>) {
    this.checkKeys(definition, value);
    const normalized = definition.validate(structuredClone(value));
    this.checkKeys(definition, normalized);
    z.record(key, z.json()).parse(normalized);
    for (const field of definition.fields) {
      const v = normalized[field.key];
      if (v === undefined && field.optional) continue;
      const valid = field.editor === "number" ? typeof v === "number" && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max) :
        field.editor === "boolean" ? typeof v === "boolean" : field.editor === "select" ? typeof v === "string" && !!field.choices?.includes(v) :
        field.editor === "text" ? typeof v === "string" : field.editor === "list" ? Array.isArray(v) :
        !!v && typeof v === "object" && !Array.isArray(v) && (field.editor !== "string-map" || Object.values(v).every(x => typeof x === "string"));
      if (!valid) throw new ApiError("INVALID_PARAMS", `Invalid server setting ${field.key}`);
    }
    return structuredClone(normalized);
  }
  descriptors() { return [...this.groups.values()].map(g => structuredClone(g.descriptor)); }
  private group(namespace: string) {
    const group = this.groups.get(namespace);
    if (!group) throw new ApiError("NOT_FOUND", `Server settings unavailable: ${namespace}`);
    return group;
  }
  values(namespace: string): Record<string, unknown> { return structuredClone(this.group(namespace).effective); }
  get(namespace: string): ServerSettingsView {
    const g = this.group(namespace);
    const values = this.validate(g.definition, { ...g.definition.defaults, ...g.record.overrides });
    return structuredClone({ ...g.descriptor, revision: g.record.revision, defaults: g.definition.defaults, values, effective: g.effective, overridden: Object.keys(g.record.overrides), restartRequired: g.descriptor.fields.filter(f => f.effect === "restart" && !isDeepStrictEqual(values[f.key], g.effective[f.key])).map(f => f.key) });
  }
  async change(input: unknown, persist: (record: ServerSettingsRecord, data: unknown) => ServerEvent): Promise<{ view: ServerSettingsView; event?: ServerEvent }> {
    const p = changeSchema.parse(input), g = this.group(p.namespace);
    if (p.expectedRevision !== g.record.revision) throw new ApiError("CONFLICT", "Stale server settings revision; refresh before saving");
    this.checkKeys(g.definition, p.patch);
    for (const name of p.reset) {
      this.checkKeys(g.definition, { [name]: null });
      if (Object.hasOwn(p.patch, name)) throw new ApiError("INVALID_PARAMS", "Cannot patch and reset the same setting");
    }
    const overrides = { ...g.record.overrides, ...p.patch };
    for (const name of p.reset) delete overrides[name];
    const values = this.validate(g.definition, { ...g.definition.defaults, ...overrides });
    for (const name of Object.keys(overrides)) overrides[name] = values[name];
    if (isDeepStrictEqual(overrides, g.record.overrides)) return { view: this.get(p.namespace) };
    const record = { ...g.record, revision: g.record.revision + 1, overrides };
    const effective = { ...g.effective };
    for (const field of g.descriptor.fields) if (field.effect !== "restart") {
      if (Object.hasOwn(values, field.key)) effective[field.key] = values[field.key];
      else delete effective[field.key];
    }
    if (!isDeepStrictEqual(this.validate(g.definition, effective), effective)) throw new ApiError("INVALID_PARAMS", "Pending restart would leave inconsistent effective settings");
    const changedKeys = g.descriptor.fields.filter(f => !isDeepStrictEqual(overrides[f.key], g.record.overrides[f.key]) || Object.hasOwn(overrides, f.key) !== Object.hasOwn(g.record.overrides, f.key)).map(f => f.key);
    const restartRequired = g.descriptor.fields.filter(f => f.effect === "restart" && !isDeepStrictEqual(values[f.key], effective[f.key])).map(f => f.key);
    if (g.definition.validateChange) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => g.definition.validateChange!(structuredClone(values), this.get(p.namespace).values)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiError("TIMEOUT", "Settings availability validation timed out")), 25_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
    const event = persist(record, { namespace: p.namespace, revision: record.revision, changedKeys, restartRequired });
    g.record = record; g.effective = effective;
    return { view: this.get(p.namespace), event };
  }
}

const descriptions: Record<keyof Limits, string> = {
  maxDepth: "Maximum agent hierarchy depth.", maxChildren: "Maximum direct children per agent.", maxProcesses: "Maximum concurrent agent processes; lowering does not stop existing processes.",
  maxPrompts: "Maximum concurrent prompts; lowering does not cancel active prompts.", maxPromptBytes: "Maximum bytes in a submitted prompt.", maxResponseBytes: "Maximum stored result/event bytes before truncation (minimum 256).",
  maxEvents: "Retained events; pruning happens on subsequent events.", maxOperations: "Retained terminal operations; pruning happens on subsequent operations.", maxQueuedPrompts: "Maximum queued prompts per agent.", maxAgents: "Maximum stored agent records; lowering does not delete records.",
  maxLineBytes: "Maximum transport/ACP message bytes; requires a server restart.", maxClientBufferBytes: "Maximum pending output bytes per client; slow clients disconnect.",
  stopTimeoutMs: "Graceful process shutdown timeout in milliseconds.", killTimeoutMs: "Termination escalation timeout in milliseconds.", startTimeoutMs: "Startup and launch-hook timeout in milliseconds.", cancelTimeoutMs: "Prompt cancellation timeout in milliseconds.", maxWaitMs: "Maximum operation wait duration in milliseconds.",
};
export function coreSettings(limits: Limits): ServerSettingsDefinition {
  return { namespace: "core", title: "Organization / core", version: 1,
    description: "Server-wide runtime limits. Changes affect every client; no agents are automatically restarted.",
    defaults: { ...limits }, fields: Object.keys(defaults).map(name => ({ key: name, label: name, description: descriptions[name as keyof Limits], editor: "number", min: name === "maxResponseBytes" ? 256 : 1, max: Number.MAX_SAFE_INTEGER, effect: name === "maxLineBytes" ? "restart" : "immediate" })),
    validate(value) {
      for (const name of Object.keys(defaults)) if (!Number.isSafeInteger(value[name]) || (value[name] as number) < (name === "maxResponseBytes" ? 256 : 1)) throw new ApiError("INVALID_PARAMS", `Invalid limit ${name}`);
      return value;
    },
  };
}
