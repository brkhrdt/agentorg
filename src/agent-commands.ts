import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { AgentCommand } from "./types.ts";
export type { AgentCommand } from "./types.ts";
export const MAX_COMMANDS = 128;
export const MAX_COMMAND_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
function cleanLine(value: string, max: number): string {
  const clean = value.replace(/[\r\n\u2028\u2029\p{Cc}\p{Cf}\u001b]/gu, " ").replace(/\s+/gu, " ").trim();
  let out = "";
  for (const char of clean) { if (bytes(out + char) > max) break; out += char; }
  return out;
}
const validName = (name: string) => !!name && bytes(name) <= 128 && !name.startsWith("/") && !/[\s\p{Cc}\p{Cf}\u2028\u2029]/u.test(name);

/** Normalize a complete ACP replacement list. Invalid lists deliberately clear prior state. */
export function normalizeAgentCommands(value: unknown): AgentCommand[] {
  if (!Array.isArray(value) || value.length > 512) return [];
  const result: AgentCommand[] = [], seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || !validName(item.name) || typeof item.description !== "string" || seen.has(item.name)) continue;
    if (item.input != null && (typeof item.input !== "object" || Array.isArray(item.input) || typeof (item.input as any).hint !== "string")) continue;
    const command: AgentCommand = { name: item.name, description: cleanLine(item.description, 512) };
    if (item.input != null) command.input = { hint: cleanLine((item.input as any).hint, 256) };
    const next = [...result, command];
    if (result.length >= MAX_COMMANDS || bytes(JSON.stringify(next)) > MAX_COMMAND_BYTES) break;
    result.push(command); seen.add(item.name);
  }
  return result;
}
export function agentCommandsEqual(a: readonly AgentCommand[] | undefined, b: readonly AgentCommand[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}
export type AcpAvailableCommand = AvailableCommand;
