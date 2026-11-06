import { tsxImport } from "./runtime.ts";
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";
import { normalizeAgentCommands } from "../src/agent-commands.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

const fixture = join(import.meta.dirname, "fixtures/agent.ts");
test("normalizes complete ACP command lists with bounded unstructured metadata", () => {
  expect(normalizeAgentCommands([
    { name: "skill:review", description: "Review\nchange", input: { hint: "Free text" }, _meta: { secret: true } },
    { name: "skill:review", description: "duplicate" }, { name: "/bad", description: "bad" },
    { name: "bad name", description: "bad" }, { name: "json", description: "schema", input: { type: "object" } },
  ])).toEqual([{ name: "skill:review", description: "Review change", input: { hint: "Free text" } }]);
  expect(normalizeAgentCommands({ commands: [] })).toEqual([]);
  expect(normalizeAgentCommands(Array(513).fill({ name: "x", description: "x" }))).toEqual([]);
});

test("ACP startup command update survives session/new response and appears in snapshot and sequenced event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-agent-commands-")); mkdirSync(join(dir, "work"));
  const commands = [{ name: "skill:review", description: "Review a change", input: { hint: "Arguments" } }];
  const events: any[] = [];
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"), plugins: [{ apiVersion: 1, name: "commands-test", setup(host) {
    host.registerHarness({ name: "fixture", launch() { return { command: process.execPath, args: ["--import", tsxImport, fixture], env: { COMMANDS_FIXTURE: JSON.stringify(commands) } }; } });
  } }] });
  const client = await OrganizationClient.connect(join(dir, "server.sock"));
  const off = client.onEvent(event => { if (event.type === "agent.commands") events.push(event); });
  try {
    const result = await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "fixture", cwd: join(dir, "work") } }));
    const agent = result.result as AgentRecord;
    const snapshot: any = await client.request("organization.snapshot", {});
    expect(snapshot.capabilities.agentCommands).toEqual({ version: 1 });
    expect(snapshot.agentCommands[agent.id]).toMatchObject({ version: 1, generation: agent.generation, sessionId: agent.sessionId, commands });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "agent.commands", agentId: agent.id, generation: agent.generation, data: { version: 1, generation: agent.generation, sessionId: agent.sessionId, commands } });
    expect(snapshot.operations.find((op: any) => op.id === result.id)?.result).not.toHaveProperty("commands");
  } finally { off(); client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
