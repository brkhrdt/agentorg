// One executable also serves as the subprocesses used by harnesses.
// Literal dynamic imports keep all entrypoints bundled without starting them together.
switch (process.argv[2]) {
  case "--internal-mcp-bridge":
    await import("./mcp-bridge.ts");
    break;
  default:
    await import("./cli.ts");
}
export {};
