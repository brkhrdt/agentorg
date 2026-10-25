import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

const socketPath = process.argv[2], capDir = process.argv[3];
if (!socketPath || !capDir) throw new Error("usage: bun scripts/validate-parent-child-comms.ts SOCKET CAPABILITY_DIR");
const operator = await OrganizationClient.connect(socketPath);
const clients: OrganizationClient[] = [];
const check: (ok: unknown, message: string) => void = (ok, message) => { if (!ok) throw new Error(message); };
const waitCreate = async (parentId: string | null, name: string) => {
  const operation = await operator.request<Operation>("agent.create", { ...(parentId ? { parentId } : {}), name, settings: { harness: "communication-fixture" } });
  const result = await operator.wait(operation, 30_000);
  check(result.status === "completed", `agent creation failed: ${result.error?.message}`);
  const record = result.result as AgentRecord;
  check(typeof record?.id === "string", "agent creation omitted the new record");
  return record;
};
const capability = async (id: string) => {
  const token = (await readFile(resolve(capDir, `${id}.token`), "utf8")).trim();
  const client = await OrganizationClient.connect(socketPath, token); clients.push(client); return client;
};
const call = async (client: OrganizationClient, name: string, args: Record<string, unknown>) => client.request<any>("mcp.call", { name, arguments: args });
const operation = (response: any, context: string) => {
  check(response.isError !== true, `${context} unexpectedly denied: ${response.content?.[0]?.text}`);
  return JSON.parse(response.content[0].text) as Operation;
};
try {
  const root = await waitCreate(null, "R"), child = await waitCreate(root.id, "C"), grandchild = await waitCreate(child.id, "G"), sibling = await waitCreate(root.id, "S");
  const [r, c, g] = await Promise.all([root, child, grandchild].map(agent => capability(agent.id)));
  const direct = operation(await call(r, "prompt_subagent", { agentId: child.id, text: "direct-child-marker" }), "R→C");
  check(direct.agentId === child.id && direct.caller?.id === root.id, "R→C operation identity mismatch");
  const denied = await call(r, "prompt_subagent", { agentId: grandchild.id, text: "forbidden-skip" });
  check(denied.isError === true && denied.content?.[0]?.text.includes("FORBIDDEN"), "R→G MCP prompt was not denied");
  const rawDenied = await r.request<any>("agent.prompt", { agentId: grandchild.id, text: "raw-forbidden-skip" }).then(() => false, (error: any) => error.code === "FORBIDDEN");
  check(rawDenied, "R→G raw API prompt was not denied");
  const snapC = await c.request<any>("organization.snapshot", {}), snapG = await g.request<any>("organization.snapshot", {});
  for (const snapshot of [snapC, snapG]) check([root.id, child.id, grandchild.id, sibling.id].every(id => snapshot.agents.some((agent: AgentRecord) => agent.id === id)), "agent snapshot did not expose full tree");
  const relay = operation(await call(c, "prompt_subagent", { agentId: grandchild.id, text: "relay-unique-marker", queue: true }), "C→G");
  check(relay.agentId === grandchild.id && relay.caller?.id === child.id, "relay caller/target mismatch");
  const gUp = operation(await call(g, "prompt_parent", { text: "grandchild-up-marker" }), "G→C");
  check(gUp.agentId === child.id && gUp.caller?.id === grandchild.id && (gUp.input as any)?.queue === true, "G→C resolution/attribution/default mismatch");
  const cUp = operation(await call(c, "prompt_parent", { text: "child-up-marker" }), "C→R");
  check(cUp.agentId === root.id && cUp.caller?.id === child.id, "C→R resolution/attribution mismatch");
  const spoof = await call(g, "prompt_parent", { text: "spoof", agentId: root.id });
  check(spoof.isError === true && spoof.content?.[0]?.text.includes("INVALID_PARAMS"), "prompt_parent accepted a caller-selected target");
  const operatorPrompt = await operator.request<Operation>("agent.prompt", { agentId: grandchild.id, text: "trusted-operator-grandchild", queue: true });
  check(operatorPrompt.agentId === grandchild.id && operatorPrompt.caller.kind === "client", "trusted operator lost unrestricted target control");
  const receipts = [
    [r, direct, child.id, "direct-child-marker"], [c, relay, grandchild.id, "relay-unique-marker"],
    [g, gUp, child.id, "grandchild-up-marker"], [c, cUp, root.id, "child-up-marker"],
  ] as const;
  for (const [issuer, op, recipientId, marker] of receipts) {
    const settled = await issuer.wait(op, 15_000);
    check(settled.status === "completed", `prompt ${marker} did not complete`);
    const recipient = recipientId === child.id ? c : recipientId === root.id ? r : g;
    const history = await recipient.request<any>("events.history", {});
    check(history.events.some((event: any) => JSON.stringify(event).includes(marker)), `recipient did not receive exact marker ${marker}`);
  }
  const operatorSettled = await operator.wait(operatorPrompt, 15_000);
  check(operatorSettled.status === "completed", "operator grandchild prompt did not complete");
  const grandchildHistory = await g.request<any>("events.history", {});
  check(grandchildHistory.events.some((event: any) => JSON.stringify(event).includes("trusted-operator-grandchild")), "grandchild did not receive operator marker");
  const tuiParentPrompt = await operator.request<Operation>("agent.prompt", { agentId: child.id, text: "tui-parent-render-check", queue: true });
  check((await operator.wait(tuiParentPrompt, 15_000)).status === "completed", "TUI parent-render fixture prompt did not complete");
  const childHistory = await operator.request<any>("events.history", { agentId: child.id });
  check(childHistory.events.some((event: any) => event.type === "tool.call" && (event.data?.toolName === "mcp__agentorg__prompt_parent" || event.data?.title === "mcp__agentorg__prompt_parent") && event.data?.rawInput?.text === "TUI parent renderer marker"), `parent-render fixture event missing from child history: ${JSON.stringify(childHistory.events)}`);
  console.log(JSON.stringify({ ok: true, agents: { root: root.id, child: child.id, grandchild: grandchild.id, sibling: sibling.id }, operations: [direct, relay, gUp, cUp, operatorPrompt].map(op => ({ id: op.id, target: op.agentId, caller: op.caller.id, type: op.type })), denied: { mcpGrandchild: true, rawGrandchild: true }, fullTreeSnapshots: true, upwardDefaultQueue: true, operatorGrandchild: true }));
} finally { for (const client of clients) client.close(); operator.close(); }
