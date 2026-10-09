import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { OrganizationClient } from "../src/client.ts";
import { ApiError, type AgentRecord, type Operation } from "../src/types.ts";

/** All model-backed demonstration/testing uses this exact model, with no fallback. */
export const DEMO_MODEL = "gpt-6-luna";
export async function runDemo(client: OrganizationClient, workspace: string) {
  await mkdir(workspace, { recursive: true });
  const rootOp = await client.wait(
    await client.request<Operation>("agent.create", {
      name: "coordinator",
      settings: {
        harness: "pi",
        model: DEMO_MODEL,
        provider: "openai-codex",
        cwd: resolve(workspace),
        options: { thinking: "low" },
      },
    }),
    90_000,
  );
  if (rootOp.status !== "completed")
    throw new ApiError(
      rootOp.error?.code ?? "DEMO_FAILED",
      rootOp.error?.message ?? "Root creation failed",
    );
  const root = rootOp.result as AgentRecord;
  const prompt = await client.request<Operation>("agent.prompt", {
    agentId: root.id,
    text: `Demonstrate delegation using the organization MCP tools. You MUST create exactly two direct children with child_create: one named coder, one named tester. Both must use harness pi, provider openai-codex, model ${DEMO_MODEL}, cwd ${JSON.stringify(resolve(workspace))}, options {"thinking":"low"}. Wait on the creation operations until completed to get result.id. Give the coder a task to write add.ts exporting function add(a: number, b: number): number that returns a+b. Give the tester a task to write add.test.ts using bun:test with a positive addition and a negative addition test; the tester should not modify add.ts. Submit both tasks using descendant_prompt, then wait for BOTH prompt operations to reach completed (operation_wait can return still running: repeat). If either fails, report the error. Finally run bun test add.test.ts yourself and report the test summary. Do not write the implementation or tests yourself. Only the two children should do that. Keep the implementation minimal, with no dependencies.`,
  });
  const done = await client.wait(prompt, 240_000);
  if (done.status !== "completed")
    throw new ApiError(
      done.error?.code ?? "DEMO_FAILED",
      done.error?.message ?? "Demo prompt stopped",
    );
  const snapshot = await client.request<{
    agents: AgentRecord[];
    operations: Operation[];
  }>("organization.snapshot");
  const children = snapshot.agents.filter(
    (a) => a.parentId === root.id && !a.removedAt,
  );
  const childPrompts = snapshot.operations.filter(
    (op) =>
      children.some((a) => a.id === op.agentId) && op.type === "agent.prompt",
  );
  if (
    children.length !== 2 ||
    childPrompts.length < 2 ||
    childPrompts.some((op) => op.status !== "completed")
  ) {
    throw new ApiError(
      "DEMO_INCOMPLETE",
      `Coordinator did not complete both child tasks: ${JSON.stringify({ result: done.result, childPrompts: childPrompts.map((op) => ({ id: op.id, status: op.status, error: op.error })) })}`,
    );
  }
  return { root, operation: done };
}
if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("bun demo [socket-path] [workspace-path]  # model: gpt-6-luna");
    process.exit(0);
  }
  const socket = resolve(process.argv[2] ?? ".org/server.sock");
  const workspace = resolve(process.argv[3] ?? ".org/demo-workspace");
  const client = await OrganizationClient.connect(socket);
  client.onEvent((event) => console.log(JSON.stringify(event)));
  try {
    await client.request("subscribe", {
      excludeTypes: ["tool.update", "agent.update"],
    });
    const result = await runDemo(client, workspace);
    console.log(JSON.stringify({ kind: "demo.result", ...result }));
  } finally {
    client.close();
  }
}
