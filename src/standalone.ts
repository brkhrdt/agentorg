// One executable also serves as the subprocesses used by harnesses.
// Literal dynamic imports keep all entrypoints bundled without starting them together.
async function main() {
  switch (process.argv[2]) {
    case "--internal-mcp-bridge":
      await import("./mcp-bridge.ts");
      break;
    default:
      await import("./cli.ts");
  }
}
void main();
export {};
