import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import { piPlugin } from "../src/plugins/pi.ts";
import { DEMO_MODEL, runDemo } from "../scripts/demo.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

// Explicit opt-in only; no other model is used by any model-backed test.
const live = process.env.ORG_LIVE_TEST === "1" ? test : test.skip;
live(
  "Pi RPC -> ACP -> organization MCP: root delegates code and tests to two children",
  async () => {
    expect(DEMO_MODEL).toBe("gpt-6-luna");
    const dir = mkdtempSync(join(tmpdir(), "org-pi-live-"));
    const workspace = join(dir, "workspace");
    const server = await OrganizationServer.start({
      dataDir: dir,
      socketPath: join(dir, "server.sock"),
      plugins: [piPlugin],
    });
    const client = await OrganizationClient.connect(join(dir, "server.sock"));
    try {
      const { root, operation } = await runDemo(client, workspace);
      expect(operation.status).toBe("completed");
      const snapshot = await client.request<{
        agents: AgentRecord[];
        operations: Operation[];
      }>("organization.snapshot");
      const children = snapshot.agents.filter((a) => a.parentId === root.id);
      expect(children).toHaveLength(2);
      expect(children.every((a) => a.settings.model === DEMO_MODEL)).toBe(true);
      expect(await Bun.file(join(workspace, "add.ts")).exists()).toBe(true);
      const testsExist = await Bun.file(
        join(workspace, "add.test.ts"),
      ).exists();
      if (!testsExist)
        console.error(
          JSON.stringify(
            {
              rootResult: operation.result,
              operations: snapshot.operations.map((op) => ({
                id: op.id,
                status: op.status,
                result: op.result,
                error: op.error,
              })),
            },
            null,
            2,
          ),
        );
      expect(testsExist).toBe(true);
      const check = Bun.spawn([process.execPath, "test", "add.test.ts"], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output] = await Promise.all([
        check.exited,
        new Response(check.stderr).text(),
      ]);
      expect(code, output).toBe(0);
      const history = server.organization.store.history(0, 1000).events;
      expect(
        history.some(
          (e) =>
            e.type === "tool.call" &&
            JSON.stringify(e.data).includes("child_create"),
        ),
      ).toBe(true);
      // Restart retains context; replacement isolates it and preserves old session files/history.
      const before = root.sessionId;
      const restarted = await client.wait(
        await client.request<Operation>("agent.restart", { agentId: root.id }),
      );
      expect((restarted.result as AgentRecord).sessionId).toBe(before);
      const replaced = await client.wait(
        await client.request<Operation>("agent.replace_session", {
          agentId: root.id,
        }),
      );
      expect((replaced.result as AgentRecord).sessionId).not.toBe(before);
    } finally {
      client.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
