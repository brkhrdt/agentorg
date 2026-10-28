import { z } from "zod";
import type { ServerEvent } from "./types.ts";
import type { ServerSettingsDefinition } from "./server-settings.ts";
import { coreMcpRenderers } from "./mcp-tool-rendering.ts";

export interface ExtendedDiff { prefix: string; before: string; after: string }
export interface RenderLevels {
  summary: string; extended: string; full: string; extendedDiff?: ExtendedDiff;
  updateMode?: "semantic" | "streaming"; extendedLayout?: "header-detail";
  toolSymbol?: string; toolTarget?: string; toolTargets?: string[]; toolPrompt?: string; toolSender?: string; invocationError?: boolean;
}
/** Presentation-only facts. Received event fields are never rewritten. */
export interface RenderContext { targetName?: string; parentTargetName?: string; senderName?: string }
/** Pure synchronous server-side Markdown; clients own all terminal styling. */
export interface EventRenderer {
  id: string; name: string; eventTypes: string[]; tool?: string;
  updateMode?: "semantic" | "streaming"; extendedLayout?: "header-detail";
  /** Public synthetic data only, never credentials or real session history. */
  examples: Array<{ type: string; data: unknown }>;
  render(event: Readonly<ServerEvent>, context?: Readonly<RenderContext>): RenderLevels;
}
export interface EventRendering extends RenderLevels { rendererId: string; subtype?: string; canonicalTool?: string }
export type RendererExample = RenderLevels & { type: string; raw: string; subtype?: string };
export interface RendererMetadata {
  id: string; name: string; eventTypes: string[]; tool?: string; harness?: string;
  aliases?: string[]; aliasHarnesses?: Record<string, string[]>; aliasExamples?: Record<string, RendererExample[]>;
  updateMode?: "semantic" | "streaming"; extendedLayout?: "header-detail";
  examples: RendererExample[];
}
const renderingSettingsSchema = z.object({ defaultToolRenderer: z.string().min(1).max(128) }).strict();
const hints = {
  updateMode: z.enum(["semantic", "streaming"]).optional(),
  extendedLayout: z.literal("header-detail").optional(),
};
const levelsSchema = z.object({
  summary: z.string(), extended: z.string(), full: z.string(), ...hints,
  toolSymbol: z.string().min(1).max(8).regex(/^[^\s\p{C}]+$/u).optional(),
  toolTarget: z.string().min(1).max(256).optional(), toolTargets: z.array(z.string().min(1).max(256)).max(8).optional(), toolPrompt: z.string().max(2 * 1024 * 1024).optional(), toolSender: z.string().min(1).max(256).optional(), invocationError: z.boolean().optional(),
  extendedDiff: z.object({ prefix: z.string().max(8192), before: z.string().max(8192), after: z.string().max(8192) }).optional(),
});
const descriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128), name: z.string().min(1).max(128),
  eventTypes: z.array(z.string().min(1).max(128)).min(1).max(64), tool: z.string().min(1).max(128).optional(), ...hints,
  examples: z.array(z.object({ type: z.string().min(1), data: z.json() })).min(1).max(8),
});
export const TOOL_EVENT_TYPES = ["tool.call", "tool.update", "tool.result"];
export const record = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function toolIdentity(event: ServerEvent): string | undefined {
  if (!TOOL_EVENT_TYPES.includes(event.type)) return;
  const data = record(event.data);
  return typeof data.toolName === "string" && data.toolName.length ? data.toolName : typeof data.title === "string" && data.title.length ? data.title : undefined;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export const literalMarkdown = (text: string) => text.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
export function fenced(text: string, language = ""): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).join("\n");
  const data = record(value);
  if (data.truncated === true) return `[TRUNCATED · ${data.originalBytes ?? "unknown"} bytes]\n${data.preview ?? ""}`;
  if (typeof data.text === "string") return data.text;
  if (data.content !== undefined) return outputText(data.content);
  if (data.type === "image") return "[Image content]";
  return pretty(value);
}
function lineCap(text: string, count: number): string {
  const lines = text.replace(/\r\n?|\u2028|\u2029/g, "\n").trim().split("\n");
  return lines.slice(0, count).join("\n") + (lines.length > count ? " …" : "");
}
function bound(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const warning = " [RENDERING TRUNCATED; see raw event]";
  return Buffer.from(text).subarray(0, bytes - Buffer.byteLength(warning)).toString("utf8").replace(/\uFFFD$/, "") + warning;
}
function normalized(value: unknown): RenderLevels {
  const levels = levelsSchema.parse(value);
  const extended = levels.extendedLayout === "header-detail"
    ? lineCap(levels.extended, 2).split("\n").map(line => bound(line, 8190)).join("\n") : lineCap(levels.extended, 2);
  return { ...levels, summary: bound(lineCap(levels.summary, 1), 8192) || "—", extended: bound(extended, 16384), full: bound(levels.full, 2 * 1024 * 1024),
    ...(levels.extendedDiff && { extendedDiff: { prefix: oneLine(levels.extendedDiff.prefix), before: oneLine(levels.extendedDiff.before), after: oneLine(levels.extendedDiff.after) } }),
  };
}
function invoke(renderer: EventRenderer, event: ServerEvent, context: RenderContext = {}): RenderLevels {
  const result = renderer.render(structuredClone(event), structuredClone(context));
  if (result && typeof (result as any).then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Render callbacks must be synchronous");
  }
  const fields = record(result);
  return normalized({ ...fields, updateMode: fields.updateMode === undefined ? renderer.updateMode : fields.updateMode, extendedLayout: fields.extendedLayout === undefined ? renderer.extendedLayout : fields.extendedLayout });
}
export function renderGenericTool(event: Readonly<ServerEvent>): RenderLevels {
  const data = record(event.data), identity = toolIdentity(event) ?? "unknown", output = Object.hasOwn(data, "rawOutput") ? data.rawOutput : data.content;
  const summary = literalMarkdown(`• ${identity}`);
  const failure = ["failed", "cancelled", "canceled"].includes(data.status) || record(output).isError === true;
  const detail = [data.status && `Invocation: ${String(data.status).replace(/_/g, " ")}`, (failure || !data.status) && output !== undefined && oneLine(outputText(output)).slice(0, 180)].filter(Boolean).join(" · ");
  const body = [data.rawInput !== undefined ? `Input:\n${fenced(pretty(data.rawInput), "json")}` : "Arguments unavailable", output !== undefined ? `Output:\n${fenced(pretty(output), "json")}` : "Output unavailable"];
  return { summary, extended: `${summary}${detail ? `\n${literalMarkdown(detail)}` : ""}`, full: [summary, ...(detail ? [literalMarkdown(detail)] : []), ...body].join("\n\n") };
}
/** @deprecated Generic compatibility entry point. Native styles belong to harness plugins. */
export function renderTool(event: Readonly<ServerEvent>, _specialized: boolean | Readonly<RenderContext> = true, _canonicalTool?: string): RenderLevels { return renderGenericTool(event); }
/** Generic synthetic examples; native harness examples belong to their plugin. */
export function toolExamples(tool: string): EventRenderer["examples"] {
  return TOOL_EVENT_TYPES.map(type => ({ type, data: { title: tool, status: type === "tool.result" ? "completed" : "in_progress", rawInput: { pattern: "hello" }, ...(type !== "tool.call" && { rawOutput: { content: [{ type: "text", text: "Example output" }] } }) } }));
}
type ToolAliases = Record<string, string> | ((canonicalTools: readonly string[]) => Record<string, string>);
export class RendererRegistry {
  private defaults = new Map<string, EventRenderer>();
  private harnesses = new Map<string, EventRenderer[]>();
  private aliases = new Map<string, ToolAliases>();
  private automatic = new Map<string, EventRenderer[]>();
  private knownTools = new Set<string>();
  private resolvedAliases = new Map<string, Record<string, string>>();
  private metadata?: RendererMetadata[];
  constructor() {
    for (const [id, name] of [["core.tools", "Core generic tool fallback"], ["generic", "Generic tools"]])
      this.register({ id, name, eventTypes: TOOL_EVENT_TYPES, examples: toolExamples("unknown"), render: renderGenericTool });
    for (const renderer of coreMcpRenderers()) this.registerToolRenderer(renderer);
  }
  private invalidate() { this.resolvedAliases.clear(); this.metadata = undefined; }
  private validate(renderer: EventRenderer): EventRenderer {
    const descriptor = descriptorSchema.parse(renderer);
    if (typeof renderer.render !== "function") throw new Error("Renderer requires render callback");
    if (descriptor.examples.some(example => !descriptor.eventTypes.includes(example.type))) throw new Error("Renderer example type must match eventTypes");
    return { ...descriptor, render: renderer.render.bind(renderer) };
  }
  private hasRendererId(id: string): boolean { return this.defaults.has(id) || [...this.automatic.values()].flat().some(r => r.id === id); }
  register(renderer: EventRenderer) {
    const owned = this.validate(renderer);
    if (this.hasRendererId(owned.id)) throw new Error(`Duplicate renderer ${owned.id}`);
    this.defaults.set(owned.id, owned); this.metadata = undefined;
  }
  registerHarness(name: string, renderers: EventRenderer[], aliases: ToolAliases = {}) {
    if (this.harnesses.has(name)) throw new Error(`Duplicate harness ${name}`);
    const owned = renderers.map(renderer => this.validate(renderer));
    if (new Set(owned.map(r => r.id)).size !== owned.length) throw new Error("Duplicate harness renderer ID");
    this.harnesses.set(name, owned);
    this.aliases.set(name, typeof aliases === "function" ? aliases : structuredClone(aliases));
    this.invalidate();
  }
  private matches(renderer: EventRenderer, event: ServerEvent, identity = toolIdentity(event)) {
    return renderer.eventTypes.includes(event.type) && (renderer.tool === undefined || renderer.tool === identity);
  }
  private aliasesFor(harness: string | undefined): Record<string, string> {
    const name = harness ?? "";
    if (this.resolvedAliases.has(name)) return this.resolvedAliases.get(name)!;
    const source = this.aliases.get(name);
    const aliases = typeof source === "function" ? source(this.canonicalTools()) : source ?? {};
    if (aliases && typeof (aliases as any).then === "function") {
      void Promise.resolve(aliases).catch(() => {});
      throw new Error(`Tool aliases for harness ${name} must be synchronous`);
    }
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases) || Object.keys(aliases).length > 256 || ![Object.prototype, null].includes(Object.getPrototypeOf(aliases))) throw new Error(`Invalid tool aliases for harness ${name}`);
    const known = new Set(this.canonicalTools()), owned: Record<string, string> = Object.create(null);
    for (const [emitted, canonical] of Object.entries(aliases)) {
      if (!emitted || emitted.length > 128 || typeof canonical !== "string" || !known.has(canonical)) throw new Error(`Invalid tool alias ${emitted} for harness ${name}`);
      if (known.has(emitted) && emitted !== canonical) throw new Error(`Cannot alias canonical tool identity ${emitted}`);
      owned[emitted] = canonical;
    }
    this.resolvedAliases.set(name, owned);
    return owned;
  }
  canonicalTools(): string[] { return [...new Set([...this.knownTools, ...this.automatic.keys()])].sort(); }
  canonicalTool(harness: string | undefined, identity: string | undefined): string | undefined { return identity ? this.aliasesFor(harness)[identity] ?? identity : undefined; }
  toolRegistered(name: string) { this.knownTools.add(name); this.invalidate(); }
  validateRegistrations(toolNames: Iterable<string>) {
    this.knownTools = new Set(toolNames); this.invalidate();
    for (const tool of this.automatic.keys()) if (!this.knownTools.has(tool)) throw new Error(`Tool renderer targets unregistered MCP tool ${tool}`);
    for (const harness of this.aliases.keys()) this.aliasesFor(harness);
  }
  registerToolRenderer(renderer: EventRenderer) {
    if (!renderer.tool) throw new Error("Automatic tool renderers require a canonical tool name");
    const owned = this.validate(renderer);
    if (owned.eventTypes.some(type => !TOOL_EVENT_TYPES.includes(type))) throw new Error("Automatic tool renderers require tool event phases");
    if (this.hasRendererId(owned.id)) throw new Error(`Duplicate renderer ${owned.id}`);
    const registrations = this.automatic.get(owned.tool!) ?? [];
    if (registrations.some(r => r.eventTypes.some(type => owned.eventTypes.includes(type)))) throw new Error(`Overlapping renderer for tool ${owned.tool}`);
    registrations.push(owned); this.automatic.set(owned.tool!, registrations); this.invalidate();
  }
  render(event: ServerEvent, harness: string | undefined, defaultId: string, context: RenderContext = {}): EventRendering | undefined {
    const identity = toolIdentity(event);
    let canonicalTool = identity;
    try { if (identity) canonicalTool = this.aliasesFor(harness)[identity] ?? identity; }
    catch { /* Invalid late registrations must not break raw event delivery. Setup validates eagerly. */ }
    const harnessRenderers = this.harnesses.get(harness ?? "") ?? [];
    const candidates: Array<{ renderer?: EventRenderer; owner?: string; canonical?: boolean }> = [];
    if (TOOL_EVENT_TYPES.includes(event.type)) {
      if (identity) candidates.push(...harnessRenderers.filter(r => r.tool === identity).map(renderer => ({ renderer, owner: harness })));
      candidates.push(...(canonicalTool ? this.automatic.get(canonicalTool) ?? [] : []).map(renderer => ({ renderer, canonical: true })));
      candidates.push({ renderer: this.defaults.get(defaultId) }, { renderer: this.defaults.get("generic") });
    } else candidates.push(...harnessRenderers.filter(r => this.matches(r, event)).sort((a, b) => Number(b.tool !== undefined) - Number(a.tool !== undefined)).map(renderer => ({ renderer, owner: harness })));
    for (const candidate of candidates) {
      const renderer = candidate.renderer;
      if (!renderer || !this.matches(renderer, event, candidate.canonical ? canonicalTool : identity)) continue;
      try {
        return { ...invoke(renderer, event, context), rendererId: `${candidate.owner ? `${candidate.owner}/` : ""}${renderer.id}`, ...(identity && { subtype: identity }), ...(canonicalTool && { canonicalTool }) };
      } catch { /* Throwing, asynchronous or malformed renderers fall through. */ }
    }
  }
  catalog(): RendererMetadata[] {
    if (this.metadata) return structuredClone(this.metadata);
    const examples = (renderer: EventRenderer, identity?: string): RendererExample[] => renderer.examples.flatMap(example => {
      const data = structuredClone(example.data);
      if (identity && data && typeof data === "object" && !Array.isArray(data)) {
        const fields = data as Record<string, unknown>;
        if (typeof fields.toolName === "string") fields.toolName = identity;
        if (typeof fields.title === "string") fields.title = identity;
      }
      const event: ServerEvent = { kind: "event", seq: 0, time: "2026-01-01T00:00:00.000Z", type: example.type, data };
      try { return [{ type: event.type, ...invoke(renderer, event), raw: pretty(event), ...(identity && { subtype: identity }) }]; }
      catch { return []; }
    });
    const metadata = (renderer: EventRenderer, harness?: string, aliasHarnesses: Record<string, string[]> = {}): RendererMetadata => {
      const aliases = Object.keys(aliasHarnesses);
      return {
        id: `${harness ? `${harness}/` : ""}${renderer.id}`, name: renderer.name, eventTypes: [...renderer.eventTypes],
        ...(renderer.tool && { tool: renderer.tool }), ...(renderer.updateMode && { updateMode: renderer.updateMode }), ...(renderer.extendedLayout && { extendedLayout: renderer.extendedLayout }), ...(harness && { harness }),
        ...(aliases.length && { aliases, aliasHarnesses, aliasExamples: Object.fromEntries(aliases.map(identity => [identity, examples(renderer, identity)])) }), examples: examples(renderer),
      };
    };
    this.metadata = [...this.defaults.values()].map(r => metadata(r)).concat([...this.automatic.values()].flat().map(r => {
      const scopes: Record<string, string[]> = Object.create(null);
      for (const harness of this.aliases.keys()) for (const [emitted, canonical] of Object.entries(this.aliasesFor(harness))) if (canonical === r.tool) (scopes[emitted] ??= []).push(harness);
      return metadata(r, undefined, scopes);
    }), [...this.harnesses].flatMap(([harness, renderers]) => renderers.map(r => metadata(r, harness))));
    return structuredClone(this.metadata);
  }
  choices() { return [...this.defaults.values()].map(renderer => ({ value: renderer.id, label: renderer.name })); }
  settings(): ServerSettingsDefinition {
    return { namespace: "rendering", title: "Event rendering", version: 1, defaults: { defaultToolRenderer: "core.tools" },
      fields: [{ key: "defaultToolRenderer", label: "Default tool renderer", editor: "text", choicesEndpoint: "events.renderer-choices", effect: "immediate", description: "Server renderer ID, used after harness and canonical tool renderers. Unknown/unavailable IDs fall back to generic." }],
      validate: value => renderingSettingsSchema.parse(value),
    };
  }
}
