import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { OrganizationClient } from "../../src/client.ts";
import type { AgentRecord, Operation } from "../../src/types.ts";

let sessionId: string = crypto.randomUUID();
let cancelled = false;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
acp
  .agent({ name: "deterministic-fixture" })
  .onRequest("initialize", async () => {
    await delay(Number(process.env.START_DELAY ?? 0));
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    };
  })
  .onRequest("session/new", () => ({ sessionId }))
  .onRequest("session/load", (ctx) => {
    sessionId = ctx.params.sessionId;
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    cancelled = false;
    const text = ctx.params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
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
    if (text === "delegate") {
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
          let op = (await call("child_create", {
            name,
            settings: { harness: "fixture", model: "gpt-6-luna" },
          })) as Operation;
          op = await client.wait(op);
          if (op.status !== "completed")
            throw new Error(JSON.stringify(op.error));
          children.push((op.result as AgentRecord).id);
        }
        await Promise.all(
          children.map(async (agentId, i) => {
            const op = await call("descendant_prompt", {
              agentId,
              text: i ? "tests done" : "code done",
            });
            const done = await client.wait(op);
            if (done.status !== "completed")
              throw new Error(JSON.stringify(done.error));
          }),
        );
      } finally {
        client.close();
      }
    }
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
