import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Readable, Writable } from "node:stream";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrganizationClient } from "../../src/client.ts";
import type { AgentRecord, Operation } from "../../src/types.ts";

let sessionId: string = crypto.randomUUID();
let cancelled = false;
let mcpServers: acp.McpServer[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function connectBridge() {
  const bridge = mcpServers[0] as any;
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: bridge.command, args: bridge.args, env: { ...environment, ...Object.fromEntries((bridge.env ?? []).map((entry: { name: string; value: string }) => [entry.name, entry.value])) } });
  const client = new Client({ name: "completion-fixture", version: "1" });
  await client.connect(transport);
  return client;
}
async function inspectCompletionBatch(batchId: string) {
  const client = await connectBridge();
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`MCP ${name}: ${(result.content as any[])[0]?.text ?? "failed"}`);
      return JSON.parse((result.content as any[])[0]!.text as string);
    };
    let after = 0;
    const members: Array<{ operationId: string; status: string; resultAvailable: boolean; result: unknown }> = [];
    for (;;) {
      const page = await call("get_completion", { batchId, after, limit: 2 });
      const items = page.items ?? page.i ?? [];
      for (const item of items) {
        const operationId = item.operationId ?? item.o;
        const query = await call("get_operation", { operationId, resultOnly: true });
        members.push({ operationId, status: query.s, resultAvailable: query.a, result: query.r });
      }
      const next = page.next ?? page.n;
      if (next === null || next === undefined) break;
      after = next;
    }
    const directory = process.env.COMPLETION_QUERY_DIR ?? process.env.COMPLETION_BARRIER_DIR;
    if (directory) writeFileSync(join(directory, `completion-query-${batchId}.json`), JSON.stringify({ batchId, members }));
  } finally { await client.close(); }
}
acp
  .agent({ name: "deterministic-fixture" })
  .onRequest("initialize", async () => {
    await delay(Number(process.env.START_DELAY ?? 0));
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    };
  })
  .onRequest("session/new", (ctx) => {
    mcpServers = ctx.params.mcpServers ?? [];
    return { sessionId };
  })
  .onRequest("session/load", (ctx) => {
    sessionId = ctx.params.sessionId;
    mcpServers = ctx.params.mcpServers ?? [];
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    cancelled = false;
    const incomingText = ctx.params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (process.env.PROMPT_CAPTURE_FILE) appendFileSync(process.env.PROMPT_CAPTURE_FILE, `${JSON.stringify({ sessionId, text: incomingText })}\n`);
    const completion = incomingText.match(/\n(\{.*\})$/s)?.[1];
    if (completion) {
      let batchId: string | undefined;
      try { batchId = JSON.parse(completion).batchId; } catch {}

      if (batchId) {
        if (process.env.COMPLETION_BARRIER_DIR) {
          writeFileSync(join(process.env.COMPLETION_BARRIER_DIR, `continuation-${batchId}.started`), "started");
          while (!existsSync(join(process.env.COMPLETION_BARRIER_DIR, `continuation-${batchId}.release`))) await delay(10);
        }
        if (process.env.COMPLETION_FAIL === "1") throw new Error("fixture continuation failure");
        if (mcpServers[0]) await inspectCompletionBatch(batchId);
      }
    }
    // This fake harness recognizes the fixture's single-token issuer names; production adapters never strip the core cue.
    const text = incomingText.replace(/^@[^ ]+ /, "");
    if (text === "sibling-barrier" && process.env.SIBLING_BARRIER_DIR) {
      writeFileSync(join(process.env.SIBLING_BARRIER_DIR, "sibling.started"), "started");
      while (!existsSync(join(process.env.SIBLING_BARRIER_DIR, "sibling.release"))) await delay(10);
    }
    if (text === "crash") process.exit(2);
    if (text === "permission") {
      const result = await ctx.client.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "permission-tool",
          title: "Confirm fixture",
          kind: "other",
          status: "pending",
        },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      });
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(result) },
        },
      });
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    const ms = Number(text.match(/sleep:(\d+)/)?.[1] ?? 10);
    for (let time = 0; time < ms; time += 10) {
      if (cancelled && !process.env.IGNORE_CANCEL) break;
      await delay(10);
    }
    if (text === "delegate" || text === "delegate-return") {
      const client = await OrganizationClient.connect(
        process.env.ORG_SOCKET!,
        process.env.ORG_TOKEN!,
      );
      try {
        const call = async (name: string, args: unknown) => {
          const result = await client.request<any>("mcp.call", {
            name,
            arguments: args,
          });
          if (result.isError) throw new Error(result.content[0].text);
          return JSON.parse(result.content[0].text);
        };
        const children: string[] = [];
        for (const name of ["code", "tests"]) {
          let op = (await call("create_subagent", {
            name,
            settings: { harness: "fixture", model: "gpt-6-luna" },
          })) as Operation;
          op = await client.wait(op);
          if (op.status !== "completed")
            throw new Error(JSON.stringify(op.error));
          children.push((op.result as AgentRecord).id);
        }
        const issued = await Promise.all(children.map((agentId, i) => call("prompt_subagent", {
          agentId, text: i ? "tests done" : "code done",
        })));
        if (text === "delegate") await Promise.all(issued.map(async (op: Operation) => {
          const done = await client.wait(op);
          if (done.status !== "completed") throw new Error(JSON.stringify(done.error));
        }));
      } finally {
        client.close();
      }
    }
    if (text === "chain-root" || text === "chain-mid") {
      const mcp = await connectBridge();
      const call = async (name: string, args: Record<string, unknown>) => {
        try {
          const result = await mcp.callTool({ name, arguments: args });
          if (result.isError) throw new Error(`MCP ${name}: ${(result.content as any[])[0]?.text}`);
          return JSON.parse((result.content as any[])[0]!.text as string);
        } catch (error) { throw new Error(`SDK stdio MCP ${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
      };
      try {
        const names = text === "chain-root" ? ["middle"] : ["leaf", "failing-leaf"];
        const targetIds: string[] = [];
        for (const name of names) {
          const childOp = await call("create_subagent", { name, settings: { harness: "fixture", env: { COMPLETION_QUERY_DIR: process.env.COMPLETION_QUERY_DIR } } });
          const childDone = await call("wait_operation", { operationId: childOp.id, waitMs: 5000 });
          if (childDone.status !== "completed") throw new Error(JSON.stringify(childDone.error));
          targetIds.push(childDone.result.id);
        }
        for (const [index, targetId] of targetIds.entries()) {
          const promptOp = await call("prompt_subagent", { agentId: targetId, text: text === "chain-root" ? "chain-mid" : index === 0 ? "chain-leaf" : "crash" });
          if (!promptOp.id) throw new Error("prompt_subagent returned no operation id");
        }
      } finally { await mcp.close(); }
    }
    if (text === "usage-notification-fixture") {
      await ctx.client.notify("_agentorg/usage", {
        used: 321,
        size: 4096,
        cost: { amount: 0.0123, currency: "USD" },
      });
    }
    if (text === "tui-parent-render-check") {
      const toolCallId = crypto.randomUUID();
      await ctx.client.notify("session/update", { sessionId, update: {
        sessionUpdate: "tool_call", toolCallId, title: "mcp__agentorg__prompt_parent", toolName: "mcp__agentorg__prompt_parent",
        status: "pending", rawInput: { text: "TUI parent renderer marker" },
      } });
      await ctx.client.notify("session/update", { sessionId, update: {
        sessionUpdate: "tool_call_update", toolCallId, title: "mcp__agentorg__prompt_parent", toolName: "mcp__agentorg__prompt_parent",
        status: "completed", rawOutput: { content: [{ type: "text", text: JSON.stringify({ id: "probe-operation", status: "queued" }) }], isError: false },
      } });
    } else {
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: crypto.randomUUID(),
          title: "fixture tool",
          status: "completed",
          rawOutput: { ok: true },
        },
      });
    }
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Complete fixture",
            priority: "medium",
            status: "completed",
          },
        ],
      },
    });
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: text === "cwd" ? process.cwd() : `done:${text}` },
      },
    });
    return { stopReason: cancelled ? "cancelled" : "end_turn" };
  })
  .onNotification("session/cancel", () => {
    if (!process.env.IGNORE_CANCEL) cancelled = true;
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
