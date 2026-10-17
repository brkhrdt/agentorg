import { z } from "zod";
import { editDiff } from "./tool-diff.ts";
import type { ServerEvent } from "./types.ts";
import type { ServerSettingsDefinition } from "./server-settings.ts";

/** Optional semantic spans for an edit's two-line preview; clients choose all colors. */
export interface ExtendedDiff { prefix: string; before: string; after: string }
export interface RenderLevels { summary: string; extended: string; full: string; extendedDiff?: ExtendedDiff }
/** Pure, synchronous, server-side Markdown formatter. Never return ANSI/terminal commands. */
export interface EventRenderer {
  id: string;
  name: string;
  eventTypes: string[];
  /** Exact tool identity (toolName, then title), not ACP's broad tool kind. */
  tool?: string;
  /** Public synthetic data only: never credentials or real session history. */
  examples: Array<{ type: string; data: unknown }>;
  render(event: Readonly<ServerEvent>): RenderLevels;
}
export interface EventRendering extends RenderLevels { rendererId: string; subtype?: string }
export interface RendererMetadata {
  id: string; name: string; eventTypes: string[]; tool?: string; harness?: string;
  examples: Array<RenderLevels & { type: string; raw: string }>;
}
const renderingSettingsSchema = z.object({ defaultToolRenderer: z.string().min(1).max(128) }).strict();
const levelsSchema = z.object({ summary: z.string(), extended: z.string(), full: z.string(), extendedDiff: z.object({
  prefix: z.string().max(8192), before: z.string().max(8192), after: z.string().max(8192),
}).optional() });
const descriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128), name: z.string().min(1).max(128),
  eventTypes: z.array(z.string().min(1).max(128)).min(1).max(64), tool: z.string().min(1).max(128).optional(),
  examples: z.array(z.object({ type: z.string().min(1), data: z.json() })).min(1).max(8),
});
export const TOOL_EVENT_TYPES = ["tool.call", "tool.update", "tool.result"];
export const record = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function toolIdentity(event: ServerEvent): string | undefined {
  if (!TOOL_EVENT_TYPES.includes(event.type)) return;
  const data = record(event.data);
  return typeof data.toolName === "string" ? data.toolName : typeof data.title === "string" ? data.title : undefined;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
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
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const literal = (text: string) => text.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
function lineCap(text: string, count: number): string {
  const lines = text.replace(/\r\n?|\u2028|\u2029/g, "\n").trim().split("\n");
  return lines.slice(0, count).join("\n") + (lines.length > count ? " …" : "");
}
function normalized(value: unknown): RenderLevels {
  const levels = levelsSchema.parse(value);
  // Bound expansion by a trusted callback too; raw events are never shortened here.
  const bound = (text: string, max = 2 * 1024 * 1024) => Buffer.byteLength(text) <= max ? text : Buffer.from(text).subarray(0, max).toString("utf8") + " [RENDERING TRUNCATED; see raw event]";
  return { summary: lineCap(bound(levels.summary, 8192), 1) || "—", extended: lineCap(bound(levels.extended, 16384), 2), full: bound(levels.full),
    ...(levels.extendedDiff && { extendedDiff: { prefix: oneLine(levels.extendedDiff.prefix), before: oneLine(levels.extendedDiff.before), after: oneLine(levels.extendedDiff.after) } }),
  };
}
function invoke(renderer: EventRenderer, event: ServerEvent): RenderLevels {
  const result = renderer.render(structuredClone(event));
  if (result && typeof (result as any).then === "function") {
    // Invalid async callbacks must not leave an unhandled rejected promise.
    void Promise.resolve(result).catch(() => {});
    throw new Error("Render callbacks must be synchronous");
  }
  return normalized(result);
}
/** Portable Pi/ACP-style tool formatting, shared by the core default and harness adapters. */
export function renderTool(event: Readonly<ServerEvent>, specialized = true): RenderLevels {
  const data = record(event.data), input = record(data.rawInput), result = record(data.rawOutput);
  const tool = toolIdentity(event) ?? "Tool", details = record(result.details), structured = record(result.structuredContent);
  const hasOutput = data.rawOutput != null || data.content != null;
  const output = data.rawOutput != null ? outputText(data.rawOutput) : data.content != null ? outputText(data.content) : "";
  const exit = structured.exit_code ?? details.exitCode ?? result.exitCode ?? output.match(/\bexit(?:ed)?(?: with)? (?:code|status):?\s*(-?\d+)/i)?.[1];
  const failed = ["failed", "cancelled", "canceled"].includes(data.status) || result.isError === true || (tool === "bash" && exit !== undefined && Number(exit) !== 0);
  const path = typeof (input.path ?? input.file_path) === "string" ? String(input.path ?? input.file_path) : "[path unavailable]";
  const known = ["read", "bash", "edit", "write"].includes(tool), styled = specialized && known;
  let subject = !known ? `• ${tool}` : tool === "bash" ? `$ ${typeof input.command === "string" ? input.command : "[command unavailable]"}` : `${tool === "read" ? "<" : tool === "write" ? ">" : "Δ"} ${path}`;
  let detail = "";
  const sections: string[] = [], consumed = new Set<string>();
  const diff = styled && tool === "edit" ? editDiff(input, details) : undefined;
  if (!known && data.rawInput !== undefined) {
    const hint = typeof data.rawInput === "string" ? data.rawInput : Object.keys(input).length ? pretty(input) : "";
    if (hint) subject += ` ${oneLine(hint).slice(0, 160)}`;
  }
  if (styled && tool !== "bash") {
    subject = `${tool === "read" ? "<" : tool === "write" ? ">" : "Δ"} ${path}`;
    consumed.add("path"); consumed.add("file_path");
  }
  if (styled && tool === "read") {
    if (input.offset != null || input.limit != null) subject += ` (offset=${input.offset ?? 1}${input.limit != null ? `, limit=${input.limit}` : ""})`;
    consumed.add("offset"); consumed.add("limit");
    if (output) detail = `${output.split("\n").length} lines`;
    if (Array.isArray(result.content) && result.content.some((part: unknown) => record(part).type === "image")) detail = "image";
  } else if (styled && tool === "bash") {
    subject = `$ ${typeof input.command === "string" ? input.command : "[command unavailable]"}`;
    if (input.timeout != null) subject += ` (timeout ${input.timeout}s)`;
    consumed.add("command"); consumed.add("timeout");
    if (exit !== undefined && Number(exit) !== 0) detail = `exit ${exit}`;
    if (output) detail += `${detail ? " · " : ""}${output.split("\n").length} lines`;
    if (typeof input.command === "string" && /[\r\n]/.test(input.command)) sections.push(fenced(input.command, "sh"));
  } else if (diff) {
    detail = `+${diff.after.length} / -${diff.before.length}`;
    if (diff.regions > 1) detail += ` · ${diff.regions} regions`;
    const title = failed ? "Changes (tool failed; may be incomplete)" : event.type === "tool.result" && data.status === "completed" ? "Diff" : "Proposed changes";
    sections.push(`${title}${diff.relative ? " · replacement-relative line numbers" : ""}:\n${fenced(diff.text, "diff")}`);
    if (!diff.incomplete) { consumed.add("edits"); consumed.add("oldText"); consumed.add("newText"); }
  } else if (styled && tool === "write" && typeof input.content === "string") {
    detail = `${input.content.split("\n").length} lines · ${Buffer.byteLength(input.content)} bytes`;
    sections.push(fenced(input.content)); consumed.add("content");
  }
  const incomplete = data.truncated === true || result.truncated === true || details.truncation?.truncated === true || structured.truncated === true || diff?.incomplete;
  if (incomplete) detail += `${detail ? " · " : ""}[TRUNCATED]`;
  if (failed) detail = `${oneLine(output).slice(0, 200) || (data.status === "cancelled" || data.status === "canceled" ? "cancelled" : "Tool failed")}${detail ? ` · ${detail}` : ""}`;
  // The tree identifies one call throughout its lifecycle: keep the command/path stable.
  // Edit counts are semantic diff facts, not phase/status text.
  const summary = `${literal(oneLine(subject))}${diff ? ` · +${diff.after.length} / -${diff.before.length}` : ""}`;
  const extraInput = Object.fromEntries(Object.entries(input).filter(([key]) => !consumed.has(key)));
  if (data.rawInput === undefined) sections.unshift("Arguments unavailable");
  else if (!styled || typeof data.rawInput === "string" || Array.isArray(data.rawInput) || Object.keys(extraInput).length || (typeof data.rawInput !== "object" || data.rawInput === null))
    sections.unshift(`Input:\n${fenced(typeof data.rawInput === "string" ? data.rawInput : pretty(styled && Object.keys(input).length ? extraInput : data.rawInput), "json")}`);
  const routineOutput = !failed && styled && (tool === "edit" || tool === "write") && /^(?:Done|Applied|Written|Successfully (?:replaced|wrote|written))\b/i.test(output);
  if (output && !routineOutput) sections.push(fenced(output));
  else if (!hasOutput && event.type !== "tool.call" && !diff && !(tool === "write" && data.status === "completed")) sections.push("Output unavailable");
  if (data.truncated === true) sections.push(outputText(data));
  const { diff: _diff, patch: _patch, firstChangedLine: _line, exitCode: _exit, ...otherDetails } = details;
  const remaining = styled && tool === "edit" && diff ? otherDetails : details;
  if (Object.keys(remaining).length) sections.push(`Details:\n${fenced(pretty(remaining), "json")}`);
  const { content: _content, details: _details, isError: _error, ...otherResult } = result;
  if (Object.keys(otherResult).length) sections.push(`Result metadata:\n${fenced(pretty(otherResult), "json")}`);
  let extended = summary;
  let extendedDiff: ExtendedDiff | undefined;
  if (diff && !failed && (diff.before.length || diff.after.length)) {
    const compact = (text: string[]) => {
      const joined = text.length ? text.map(line => oneLine(line) || "(blank)").join(" ↵ ") : "∅";
      return joined.length > 240 ? joined.slice(0, 239) + "…" : joined;
    };
    extendedDiff = { prefix: `${oneLine(subject)}${diff.regions > 1 ? ` (${diff.regions} regions)` : ""}${incomplete ? " [TRUNCATED]" : ""}`, before: compact(diff.before), after: compact(diff.after) };
    extended = `${literal(extendedDiff.prefix)} ${literal(extendedDiff.before)}\n  ${literal(extendedDiff.after)}`;
  } else {
    const preview = [detail, output && !routineOutput && !failed ? oneLine(output).slice(0, 240) : ""].filter(Boolean).join(" · ");
    if (preview) extended += `\n${literal(oneLine(preview))}`;
    else if (!hasOutput && event.type !== "tool.call" && !diff && !(tool === "write" && data.status === "completed")) extended += "\nOutput unavailable";
  }
  return { summary, extended, full: [summary, ...(detail ? [literal(oneLine(detail))] : []), ...sections].join("\n\n"), ...(extendedDiff && { extendedDiff }) };
}
export function toolExamples(tool: string): EventRenderer["examples"] {
  const inputs: Record<string, unknown> = {
    read: { path: "src/main.ts", offset: 10, limit: 2 }, bash: { command: "printf 'hello\\n'" },
    edit: { path: "src/main.ts", edits: [{ oldText: "const n = 1;", newText: "const n = 2;" }] },
    write: { path: "hello.txt", content: "Hello\nworld" },
  };
  const rawInput = inputs[tool] ?? { pattern: "hello" };
  return [
    { type: "tool.call", data: { title: tool, status: "in_progress", rawInput } },
    { type: "tool.update", data: { title: tool, status: "in_progress", rawInput, rawOutput: { content: [{ type: "text", text: "Working…" }] } } },
    { type: "tool.result", data: { title: tool, status: "completed", rawInput, rawOutput: { content: [{ type: "text", text: tool === "read" ? "const n = 2;\nexport { n };" : "Done" }], ...(tool === "edit" && { details: { diff: "-const n = 1;\n+const n = 2;" } }) } } },
  ];
}
export class RendererRegistry {
  private defaults = new Map<string, EventRenderer>();
  private harnesses = new Map<string, EventRenderer[]>();
  private metadata?: RendererMetadata[];
  constructor() {
    this.register({ id: "core.tools", name: "Core tool styles", eventTypes: TOOL_EVENT_TYPES, examples: toolExamples("read"), render: event => renderTool(event) });
    this.register({ id: "generic", name: "Generic tools", eventTypes: TOOL_EVENT_TYPES, examples: toolExamples("unknown"), render: event => renderTool(event, false) });
  }
  private validate(renderer: EventRenderer): EventRenderer {
    const descriptor = descriptorSchema.parse(renderer);
    if (typeof renderer.render !== "function") throw new Error("Renderer requires render callback");
    if (descriptor.examples.some(example => !descriptor.eventTypes.includes(example.type))) throw new Error("Renderer example type must match eventTypes");
    return { ...descriptor, render: renderer.render.bind(renderer) };
  }
  register(renderer: EventRenderer) {
    const owned = this.validate(renderer);
    if (this.defaults.has(owned.id)) throw new Error(`Duplicate renderer ${owned.id}`);
    this.defaults.set(owned.id, owned);
    this.metadata = undefined;
  }
  registerHarness(name: string, renderers: EventRenderer[]) {
    const owned = renderers.map(renderer => this.validate(renderer));
    if (new Set(owned.map(r => r.id)).size !== owned.length) throw new Error("Duplicate harness renderer ID");
    this.harnesses.set(name, owned);
    this.metadata = undefined;
  }
  private matches(renderer: EventRenderer, event: ServerEvent) {
    return renderer.eventTypes.includes(event.type) && (renderer.tool === undefined || renderer.tool === toolIdentity(event));
  }
  render(event: ServerEvent, harness: string | undefined, defaultId: string): EventRendering | undefined {
    const harnessRenderers = this.harnesses.get(harness ?? "") ?? [];
    const matching = harnessRenderers.filter(r => this.matches(r, event)).sort((a, b) => Number(b.tool !== undefined) - Number(a.tool !== undefined));
    const candidates = [...matching, ...(TOOL_EVENT_TYPES.includes(event.type) ? [this.defaults.get(defaultId), this.defaults.get("generic")] : [])];
    for (const renderer of candidates) {
      if (!renderer || !this.matches(renderer, event)) continue;
      try {
        const levels = invoke(renderer, event);
        return { ...levels, rendererId: `${matching.includes(renderer) ? `${harness}/` : ""}${renderer.id}`, ...(toolIdentity(event) && { subtype: toolIdentity(event) }) };
      } catch { /* Malformed or throwing renderers cannot break event delivery. */ }
    }
  }
  catalog(): RendererMetadata[] {
    if (this.metadata) return structuredClone(this.metadata);
    const metadata = (renderer: EventRenderer, harness?: string): RendererMetadata => ({
      id: `${harness ? `${harness}/` : ""}${renderer.id}`, name: renderer.name, eventTypes: [...renderer.eventTypes],
      ...(renderer.tool && { tool: renderer.tool }), ...(harness && { harness }),
      examples: renderer.examples.flatMap(example => {
        const event: ServerEvent = { kind: "event", seq: 0, time: "2026-01-01T00:00:00.000Z", type: example.type, data: structuredClone(example.data) };
        try { return [{ type: event.type, ...invoke(renderer, event), raw: pretty(event) }]; }
        catch { return []; }
      }),
    });
    this.metadata = [...this.defaults.values()].map(r => metadata(r)).concat([...this.harnesses].flatMap(([harness, renderers]) => renderers.map(r => metadata(r, harness))));
    return structuredClone(this.metadata);
  }
  choices() { return [...this.defaults.values()].map(renderer => ({ value: renderer.id, label: renderer.name })); }
  settings(): ServerSettingsDefinition {
    return { namespace: "rendering", title: "Event rendering", version: 1,
      defaults: { defaultToolRenderer: "core.tools" },
      fields: [{ key: "defaultToolRenderer", label: "Default tool renderer", editor: "text", choicesEndpoint: "events.renderer-choices", effect: "immediate", description: "Server renderer ID, used after harness renderers. Unknown/unavailable IDs fall back to generic." }],
      validate: value => renderingSettingsSchema.parse(value),
    };
  }
}
