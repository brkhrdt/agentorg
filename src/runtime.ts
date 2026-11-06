import { join } from "node:path";

/** Core owns only the generic organization MCP bridge, not harness adapters. */
export function workerArgs(worker: "mcp-bridge"): string[] {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  if (sea?.isSea?.()) return [`--internal-${worker}`];
  return [join(import.meta.dirname, "mcp-bridge.js")];
}
