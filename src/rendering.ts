import { z } from "zod";
import type { ServerEvent } from "./types.ts";
import type { ServerSettingsDefinition } from "./server-settings.ts";

export interface RenderLevels { summary: string; extended: string; full: string }
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
  examples: Array<{ type: string; summary: string; extended: string; full: string; raw: string }>;
}
const renderingSettingsSchema = z.object({ defaultToolRenderer: z.string().min(1).max(128) }).strict();
const levelsSchema = z.object({ summary: z.string(), extended: z.string(), full: z.string() });
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
  return { summary: lineCap(bound(levels.summary, 8192), 1) || "—", extended: lineCap(bound(levels.extended, 16384), 2), full: bound(levels.full) };
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
  const tool = toolIdentity(event) ?? "Tool";
  const phase = event.type === "tool.call" ? "call" : event.type === "tool.update" ? "partial" : "result";
  const status = String(data.status ?? (phase === "result" ? "unknown" : "pending"));
  const hasOutput = data.rawOutput != null || data.content != null;
  const output = data.rawOutput != null ? outputText(data.rawOutput) : data.content != null ? outputText(data.content) : "";
  const details = record(result.details), structured = record(result.structuredContent);
  const path = typeof (input.path ?? input.file_path) === "string" ? String(input.path ?? input.file_path) : "[path unavailable]";
  let subject = tool, detail = "";
  const sections: string[] = [];
  if (specialized && ["read", "edit", "write"].includes(tool)) subject = `${tool} ${path}`;
  if (specialized && tool === "read") {
    if (input.offset != null || input.limit != null) subject += ` (offset=${input.offset ?? 1}${input.limit != null ? `, limit=${input.limit}` : ""})`;
    if (output) detail = `${output.split("\n").length} lines`;
    if (Array.isArray(result.content) && result.content.some((part: unknown) => record(part).type === "image")) detail = "Image loaded";
  } else if (specialized && tool === "bash") {
    subject = `$ ${typeof input.command === "string" ? input.command : "[command unavailable]"}`;
    if (input.timeout != null) subject += ` (timeout ${input.timeout}s)`;
    const exit = structured.exit_code ?? details.exitCode ?? result.exitCode ?? output.match(/exit (?:code|status):?\s*(\d+)/i)?.[1];
    if (exit !== undefined) detail = `exit ${exit}`;
    if (output) detail += `${detail ? " · " : ""}${output.split("\n").length} lines`;
  } else if (specialized && tool === "edit") {
    const diff = typeof details.patch === "string" ? details.patch : typeof details.diff === "string" ? details.diff : undefined;
    if (diff) {
      const lines = diff.split("\n");
      detail = `+${lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length} / -${lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length}`;
      sections.push(`Diff:\n${fenced(diff, "diff")}`);
    } else {
      const edits = Array.isArray(input.edits) ? input.edits : typeof input.oldText === "string" ? [input] : [];
      if (edits.length) sections.push(`Replacements:\n${edits.map((edit: unknown) => {
        const e = record(edit);
        return `Before:\n${fenced(typeof e.oldText === "string" ? e.oldText : "[unavailable]")}\nAfter:\n${fenced(typeof e.newText === "string" ? e.newText : "[unavailable]")}`;
      }).join("\n\n")}`);
    }
  } else if (specialized && tool === "write" && typeof input.content === "string") {
    detail = `${input.content.split("\n").length} lines · ${Buffer.byteLength(input.content)} bytes`;
    sections.push(`Content:\n${fenced(input.content)}`);
  }
  const incomplete = data.truncated === true || result.truncated === true || details.truncation?.truncated === true || structured.truncated === true;
  if (incomplete) detail += `${detail ? " · " : ""}[TRUNCATED]`;
  if (status === "failed" || result.isError === true) detail = `${oneLine(output).slice(0, 200) || "Tool failed"}${detail ? ` · ${detail}` : ""}`;
  const summary = `${literal(oneLine(subject))} · ${phase} · ${literal(oneLine(status))}${detail ? ` · ${literal(oneLine(detail))}` : ""}`;
  const preview = detail || (output ? oneLine(output).slice(0, 200) : phase === "call" ? "Awaiting result" : hasOutput ? "No output" : "Output unavailable");
  // Preserve unknown argument fields; the write content itself is already a literal block.
  const { content: _writtenContent, ...writeArguments } = input;
  const fullInput = specialized && tool === "write" && typeof input.content === "string" ? writeArguments : data.rawInput;
  sections.unshift(data.rawInput === undefined ? "Arguments unavailable" : `Input:\n${fenced(typeof fullInput === "string" ? fullInput : pretty(fullInput), "json")}`);
  if (output) sections.push(`Output:\n${fenced(output)}`);
  else if (phase !== "call") sections.push(hasOutput ? "No output" : "Output unavailable");
  if (data.truncated === true) sections.push(outputText(data));
  const { diff: _diff, patch: _patch, ...otherDetails } = details;
  const remaining = specialized && tool === "edit" ? otherDetails : details;
  if (Object.keys(remaining).length) sections.push(`Details:\n${fenced(pretty(remaining), "json")}`);
  const { content: _content, details: _details, ...otherResult } = result;
  if (Object.keys(otherResult).length) sections.push(`Result metadata:\n${fenced(pretty(otherResult), "json")}`);
  return { summary, extended: `${literal(oneLine(subject))} · ${phase} · ${literal(oneLine(status))}\n${literal(preview)}`, full: [summary, ...sections].join("\n\n") };
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
