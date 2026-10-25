import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ServerPlugin } from "../../src/plugin.ts";
import { coreMcpRenderers } from "../../src/mcp-tool-rendering.ts";

/** Deterministic ACP fixture for adjacent-communication validation. */
const communicationPlugin: ServerPlugin = {
  apiVersion: 1,
  name: "communication-fixture",
  setup(host) {
    host.registerHarness({
      name: "communication-fixture",
      toolAliases: names => Object.fromEntries(names.map(name => [`mcp__agentorg__${name}`, name])),
      renderers: coreMcpRenderers().filter(renderer => renderer.tool === "prompt_parent").map(renderer => ({ ...renderer, tool: "mcp__agentorg__prompt_parent" })),
      launch(context) {
        const capabilityDirectory = process.env.AGENTORG_COMMUNICATION_CAP_DIR;
        if (capabilityDirectory) {
          mkdirSync(capabilityDirectory, { recursive: true, mode: 0o700 });
          writeFileSync(join(capabilityDirectory, `${context.agent.id}.token`), context.token, { mode: 0o600 });
        }
        return {
          command: process.execPath,
          args: [join(import.meta.dir, "agent.ts")],
          cwd: context.agent.settings.cwd ?? process.cwd(),
          env: { ...process.env, ...context.agent.settings.env, ORG_SOCKET: context.socketPath, ORG_TOKEN: context.token },
        };
      },
    });
  },
};
export default communicationPlugin;
