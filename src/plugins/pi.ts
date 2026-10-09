import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { ServerPlugin } from "../plugin.ts";

export const piOptionsSchema = z
  .object({
    thinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    appendSystemPrompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    executable: z.string().min(1).default("pi"),
  })
  .strict();

export const piPlugin: ServerPlugin = {
  apiVersion: 1,
  name: "pi",
  setup(host) {
    host.registerHarness({
      name: "pi",
      launch(context) {
        const options = piOptionsSchema.parse(context.agent.settings.options);
        const sessionDir = join(
          context.dataDir,
          "sessions",
          context.agent.id,
          String(context.agent.sessionNumber),
        );
        mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        return {
          command: process.execPath,
          args: [join(import.meta.dir, "pi-acp.ts")],
          cwd: context.agent.settings.cwd ?? process.cwd(),
          env: {
            ...process.env,
            ...context.agent.settings.env,
            ORG_PI_CONFIG: JSON.stringify({
              settings: context.agent.settings,
              options,
              sessionDir,
              sessionId: context.agent.sessionId,
            }),
            ORG_SOCKET: context.socketPath,
            ORG_TOKEN: context.token,
            ORG_AGENT_ID: context.agent.id,
            ORG_MCP_BRIDGE: join(import.meta.dir, "..", "mcp-bridge.ts"),
            ORG_BUN: process.execPath,
          },
        };
      },
    });
  },
};
export default piPlugin;
