import { join } from "node:path";

/** Core owns only the generic organization MCP bridge, not harness adapters. */
export function workerArgs(worker: "mcp-bridge"): string[] {
  return [join(import.meta.dirname, "mcp-bridge.js")];
}
