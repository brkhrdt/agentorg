import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrganizationClient } from "../src/client.ts";
import { OrganizationServer } from "../src/server.ts";
import { cwdPlugin } from "../src/plugins/cwd.ts";
import type { ServerPlugin } from "../src/plugin.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

const harness: ServerPlugin = {
  apiVersion: 1,
  name: "fixture",
  setup(host) {
    host.registerHarness({
      name: "fixture",
      launch: () => ({
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures", "agent.ts")],
        // The cwd plugin must override even a harness-provided working directory.
        cwd: process.cwd(),
      }),
    });
  },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "org-cwd-"));
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "child", "leaf"), { recursive: true });
  mkdirSync(join(dir, "workspace-other"));
  symlinkSync(workspace, join(dir, "root-link"));
  symlinkSync(join(workspace, "child"), join(workspace, "inside-link"));
  symlinkSync(join(dir, "workspace-other"), join(workspace, "escape"));
  symlinkSync(workspace, join(workspace, "self"));
  const server = await OrganizationServer.start({
    dataDir: join(dir, "data"),
    socketPath: join(dir, "data", "server.sock"),
    plugins: [harness, cwdPlugin],
    limits: { stopTimeoutMs: 100, killTimeoutMs: 50 },
  });
  const client = await OrganizationClient.connect(server.organization.socketPath);
  cleanup.push(async () => {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const create = (parentId: string | null, cwd?: string) => client.request<Operation>("agent.create", {
    parentId,
    settings: { harness: "fixture", model: "test", ...(cwd === undefined ? {} : { cwd }) },
  }).then(op => client.wait(op));
  const rootOp = await create(null, join(dir, "root-link"));
  expect(rootOp.status).toBe("completed");
  const root = rootOp.result as AgentRecord;
  expect(root.settings.cwd).toBe(workspace);
  return { dir, workspace, server, client, create, root };
}

test("cwd plugin augments the real MCP create tool and reports canonical cwd to clients", async () => {
  const { root, workspace, server, client } = await setup();
  const rt = (server.organization as any).runtimes.get(root.id);
  const mcp = new Client({ name: "cwd-test", version: "1" });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "src", "mcp-bridge.ts")],
    env: { ...(process.env as Record<string, string>), ORG_SOCKET: server.organization.socketPath, ORG_TOKEN: rt.token },
  }));
  try {
    const tool = (await mcp.listTools()).tools.find(t => t.name === "child_create")!;
    expect(tool.inputSchema.required).toContain("cwd");
    expect(tool.inputSchema.properties?.cwd).toMatchObject({ type: "string" });
    const settings = { harness: "fixture", model: "test" };
    for (const args of [{ settings }, { settings, cwd: "" }, { settings: { ...settings, cwd: "child" }, cwd: "child" }]) {
      expect((await mcp.callTool({ name: "child_create", arguments: args })).isError).toBe(true);
    }
    const result = await mcp.callTool({ name: "child_create", arguments: { settings, cwd: "inside-link" } });
    expect(result.isError).not.toBe(true);
    const operation = await client.wait(JSON.parse((result.content as any)[0].text));
    expect(operation.status).toBe("completed");
    const child = operation.result as AgentRecord;
    const cwd = join(workspace, "child");
    expect(child.settings.cwd).toBe(cwd);
    expect((await client.request<AgentRecord>("agent.get", { agentId: child.id })).settings.cwd).toBe(cwd);
    const snapshot = await client.request<{ agents: AgentRecord[] }>("organization.snapshot");
    expect(snapshot.agents.find(a => a.id === child.id)?.settings.cwd).toBe(cwd);
    const prompt = await client.wait(await client.request<Operation>("agent.prompt", { agentId: child.id, text: "cwd" }));
    expect(prompt.result).toMatchObject({ text: cwd });
  } finally {
    await mcp.close();
  }
});

test("cwd containment rejects missing, equal, traversal, prefix, symlink escapes and non-directories", async () => {
  const { root, dir, workspace, create, server } = await setup();
  writeFileSync(join(workspace, "file"), "not a directory");
  for (const cwd of [undefined, ".", workspace, "self", "child/..", "../workspace-other", join(dir, "workspace-other"), "escape", "missing", "file"]) {
    const op = await create(root.id, cwd);
    expect(op.status).toBe("failed");
    expect(op.error?.code).toBe("INVALID_PARAMS");
  }
  expect(server.organization.agents.size).toBe(1);
  const child = (await create(root.id, "child")).result as AgentRecord;
  expect(child.settings.cwd).toBe(join(workspace, "child"));
  const leaf = await create(child.id, "leaf");
  expect(leaf.status).toBe("completed");
  expect((leaf.result as AgentRecord).settings.cwd).toBe(join(workspace, "child", "leaf"));
  // Inside the root, but not inside this direct parent's cwd.
  expect((await create(child.id, workspace)).status).toBe("failed");
});

test("cwd changes cannot violate parent or existing child containment; rejected edits preserve running agents", async () => {
  const { root, workspace, client, create } = await setup();
  const child = (await create(root.id, "child")).result as AgentRecord;
  const modify = (agentId: string, cwd: string) => client.request<Operation>("agent.modify", {
    agentId, settings: { cwd },
  }).then(op => client.wait(op));
  for (const [agentId, cwd] of [[child.id, workspace], [root.id, join(workspace, "child")]]) {
    const before = await client.request<AgentRecord>("agent.get", { agentId });
    expect((await modify(agentId!, cwd!)).status).toBe("failed");
    const after = await client.request<AgentRecord>("agent.get", { agentId });
    expect(after.revision).toBe(before.revision);
    expect(after.generation).toBe(before.generation);
    expect(after.settings.cwd).toBe(before.settings.cwd);
  }
  mkdirSync(join(workspace, "other"));
  const changed = await modify(child.id, "other");
  expect(changed.status).toBe("completed");
  expect((changed.result as AgentRecord).settings.cwd).toBe(join(workspace, "other"));
});

test("cwd containment is rechecked on restart after a directory is replaced by a symlink", async () => {
  const { root, dir, workspace, client, create } = await setup();
  const child = (await create(root.id, "child")).result as AgentRecord;
  await client.wait(await client.request<Operation>("agent.stop", { agentId: child.id }));
  rmSync(join(workspace, "child"), { recursive: true });
  symlinkSync(join(dir, "workspace-other"), join(workspace, "child"));
  const restart = await client.wait(await client.request<Operation>("agent.restart", { agentId: child.id }));
  expect(restart.status).toBe("failed");
  expect(restart.error?.code).toBe("START_FAILED");
  expect(restart.error?.message).toContain("strict subdirectory");
  expect((await client.request<AgentRecord>("agent.get", { agentId: child.id })).state).toBe("failed");
  // A child's invalid workspace must not stop its parent from restarting.
  const parentRestart = await client.wait(await client.request<Operation>("agent.restart", { agentId: root.id }));
  expect(parentRestart.status).toBe("completed");
});
