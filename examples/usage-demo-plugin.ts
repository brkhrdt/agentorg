import { join } from "node:path";
import type { ServerPlugin } from "../src/plugin.ts";

/**
 * Isolated no-credential demo harness. It deliberately reports fixture counters,
 * not measured model usage or billed cost.
 */
const plugin: ServerPlugin = {
  apiVersion: 1,
  name: "usage-demo",
  setup(host) {
    host.registerHarness({
      name: "usage-demo",
      usageMetrics: [
        { id: "tokens.input", title: "Input tokens", unit: "tokens" },
        { id: "tokens.output", title: "Output tokens", unit: "tokens" },
        { id: "tokens.cache_read", title: "Cache read tokens", unit: "tokens" },
        { id: "tokens.cache_write", title: "Cache write tokens", unit: "tokens" },
        { id: "tokens.total", title: "Total tokens", unit: "tokens" },
        { id: "cost.usd", title: "Pi-reported USD", unit: "USD" },
        { id: "custom.fixture", title: "Fixture metric", unit: "count" },
      ],
      launch(context) {
        return {
          command: process.execPath,
          args: [join(import.meta.dirname, "../tests/fixtures/agent.ts")],
          cwd: context.agent.settings.cwd ?? process.cwd(),
          env: {
            ...process.env,
            ...context.agent.settings.env,
            ORG_SOCKET: context.socketPath,
            ORG_TOKEN: context.token,
          },
        };
      },
    });
  },
};

export default plugin;
