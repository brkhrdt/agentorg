import { z } from "zod";
import type { ServerPlugin } from "../src/plugin.ts";

/** Example: replace this argv mapping with your Claude/Codex/etc. ACP wrapper's CLI. */
const plugin: ServerPlugin = {
  apiVersion: 1,
  name: "external-acp",
  setup(host) {
    host.registerHarness({
      name: "external-acp",
      launch({ agent }) {
        const options = z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
          })
          .strict()
          .parse(agent.settings.options);
        return {
          command: options.command,
          args: [...options.args, "--model", agent.settings.model],
          // cwd/env omitted: organization launch defaults apply.
          // The wrapper must implement ACP v1 on stdin/stdout and honor
          // MCP servers passed by ACP session/new or session/load.
        };
      },
    });
    host.registerEndpoint("external.health", () => ({ available: true }));
    host.registerTool({
      name: "external_health",
      description: "Check the external harness plugin",
      inputSchema: { type: "object", additionalProperties: false },
      execute: (_args, caller) => host.request("external.health", {}, caller),
    });
    host.onEvent((event) => {
      if (event.type === "agent.error")
        console.error("External plugin observed an agent error", event.agentId);
    });
    // host.beforeLaunch can wrap command/args in an isolation/container policy.
    // spec.gracefulStop can stop a container before normal signal escalation.
  },
};
export default plugin;
