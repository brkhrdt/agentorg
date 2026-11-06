import { dirname, join, resolve } from "node:path";

/** Core owns only the generic organization MCP bridge, not harness adapters. */
export function workerArgs(worker: "mcp-bridge"): string[] {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  if (sea?.isSea?.()) return [`--internal-${worker}`];
  if (process.argv[1]?.endsWith("agentorg.cjs")) return [process.argv[1], `--internal-${worker}`];
  return ["--import", "tsx", join(dirname(resolve(process.argv[1]!)), "mcp-bridge.ts")];
}
