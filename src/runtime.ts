import { join } from "node:path";

/** Core owns only the generic organization MCP bridge, not harness adapters. */
export function workerArgs(worker: "mcp-bridge"): string[] {
  if (Bun.isStandaloneExecutable) return [`--internal-${worker}`];
  return [join(import.meta.dir, "mcp-bridge.ts")];
}
