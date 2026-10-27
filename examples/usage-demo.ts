import { resolve } from "node:path";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

const socket = resolve(process.env.ORG_SOCKET ?? ".usage-demo.sock");
const client = await OrganizationClient.connect(socket);
async function wait(operation: Operation): Promise<Operation> {
  const result = await client.wait(operation, 15_000);
  if (result.status !== "completed") throw new Error(JSON.stringify(result.error));
  return result;
}
async function create(parentId: string | null): Promise<AgentRecord> {
  const operation = await wait(await client.request<Operation>("agent.create", {
    parentId,
    settings: { harness: "usage-demo", cwd: process.cwd() },
  }));
  return await client.request<AgentRecord>("agent.get", { agentId: operation.agentId });
}
try {
  const root = await create(null);
  const child = await create(root.id);
  const grandchild = await create(child.id);
  for (const [agent, prompt] of [
    [root, "usage-notification-fixture"],
    [child, "usage-notification-fixture"],
    [grandchild, "usage-notification-no-cost-fixture"],
  ] as const) {
    await wait(await client.request<Operation>("agent.prompt", { agentId: agent.id, text: prompt }));
  }
  const subtree = await client.request<any>("usage.get", { agentId: root.id, scope: "subtree" });
  console.log("FIXTURE DATA ONLY (not live model usage or billed cost)");
  console.log(JSON.stringify({ root: root.id, child: child.id, grandchild: grandchild.id, subtree }, null, 2));
  console.log("The grandchild report intentionally omits cost.usd; its cost column is unknown (-).");
  if (process.argv.includes("--remove-child")) {
    await wait(await client.request<Operation>("agent.remove", { agentId: child.id }));
    const after = await client.request<any>("usage.get", { agentId: root.id, scope: "subtree" });
    console.log("After removing child and grandchild; lifetime subtree totals remain:");
    console.log(JSON.stringify(after, null, 2));
  }
} finally {
  client.close();
}
