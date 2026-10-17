import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

test("lightweight snapshots retain active operations without resending terminal prompt bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-snapshot-"));
  const tokens = new Map<string, string>();
  const server = await OrganizationServer.start({
    dataDir: dir, socketPath: join(dir, "server.sock"), limits: { maxClientBufferBytes: 32768 },
    plugins: [{ apiVersion: 1, name: "fixture", setup(host) {
      host.registerHarness({ name: "fixture", launch(context) {
        tokens.set(context.agent.id, context.token);
        return { command: process.execPath, args: [join(import.meta.dir, "fixtures/agent.ts")] };
      } });
    } }],
  });
  const clients: OrganizationClient[] = [];
  const connect = async (token?: string) => {
    const client = await OrganizationClient.connect(join(dir, "server.sock"), token);
    clients.push(client);
    return client;
  };
  try {
    const client = await connect();
    const created = await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture" } }));
    const root = created.result as AgentRecord;
    for (let i = 0; i < 8; i++) {
      const prompt = await client.wait(await client.request<Operation>("agent.prompt", { agentId: root.id, text: "x".repeat(6000) }));
      expect(prompt.status).toBe("completed");
    }
    const full: any = await server.organization.request("organization.snapshot");
    expect(full.operations.filter((op: Operation) => op.status === "completed")).toHaveLength(9);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(32768);
    const pending = await client.request<Operation>("agent.prompt", { agentId: root.id, text: "sleep:300", queue: true });
    const snapshots: any[] = await Promise.all([0, 1].map(() => client.request("organization.snapshot", { includeTerminalOperations: false })));
    for (const snapshot of snapshots) {
      expect(snapshot.agents.map((agent: AgentRecord) => agent.id)).toEqual([root.id]);
      expect(snapshot.operations.map((op: Operation) => op.id)).toEqual([pending.id]);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(32768);
    }
    const agentClient = await connect(tokens.get(root.id));
    const mcp: any = await agentClient.request("mcp.call", { name: "organization_snapshot", arguments: { includeTerminalOperations: false } });
    // Agent callers still cannot manage/read the client's operation on themselves.
    expect(JSON.parse(mcp.content[0].text).operations).toEqual([]);
    await expect(client.request("organization.snapshot", { includeTerminalOperations: "false" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const probe = await connect();
    await expect(probe.request("organization.snapshot")).rejects.toThrow("socket closed");
    expect((await client.wait(pending)).status).toBe("completed");
    expect((await client.request<any>("organization.snapshot", { includeTerminalOperations: false })).operations).toEqual([]);
  } finally {
    clients.forEach(client => client.close());
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
