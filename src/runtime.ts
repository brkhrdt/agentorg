import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** Core owns only the generic organization MCP bridge, not harness adapters. */
export function workerArgs(worker: "mcp-bridge"): string[] {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  if (sea?.isSea?.()) return [`--internal-${worker}`];
  return ["--import", createRequire(import.meta.url).resolve("tsx"), join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.ts")];
}
