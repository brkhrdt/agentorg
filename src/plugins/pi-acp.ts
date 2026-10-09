import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { once } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import { JsonLines } from "../jsonl.ts";
import { deadline } from "../process.ts";
import { settingsSchema } from "../types.ts";
import { piOptionsSchema } from "./pi.ts";

const config = JSON.parse(process.env.ORG_PI_CONFIG ?? "{}");
const settings = settingsSchema.parse(config.settings);
const options = piOptionsSchema.parse(config.options);
let child: ChildProcessWithoutNullStreams | undefined;
let client: acp.AgentContext;
let sessionId: string = config.sessionId;
interface Run {
  resolve: (result: acp.PromptResponse) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
  error?: string;
  reason?: string;
}
let active: Run | undefined;
let notificationTail: Promise<void> = Promise.resolve();
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let closing = false;

async function write(record: unknown) {
  if (!child || child.stdin.destroyed)
    throw new Error("Pi RPC is not connected");
  if (!child.stdin.write(JSON.stringify(record) + "\n"))
    await once(child.stdin, "drain");
}
async function rpc(type: string, fields: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const result = new Promise<any>((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
  try {
    await write({ id, type, ...fields });
    return await deadline(result, 30_000, `Pi RPC ${type} timed out`);
  } finally {
    pending.delete(id);
  }
}
function fail(error: Error) {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
  active?.reject(error);
  active = undefined;
}
function update(update: acp.SessionUpdate) {
  notificationTail = notificationTail.then(() =>
    client.notify("session/update", { sessionId, update }),
  );
  // Keep consuming RPC records even if the ACP client disconnected.
  notificationTail = notificationTail.catch((error) => {
    if (active) active.reject(error);
  });
}
async function ui(record: any) {
  if (!["confirm", "select", "input", "editor"].includes(record.method)) return;
  if (record.method === "input" || record.method === "editor") {
    await write({
      type: "extension_ui_response",
      id: record.id,
      cancelled: true,
    });
    return;
  }
  const values: string[] =
    record.method === "select" ? record.options : ["Allow", "Reject"];
  try {
    const response = await client.request<acp.RequestPermissionResponse>(
      "session/request_permission",
      {
        sessionId,
        toolCall: {
          toolCallId: record.id,
          title: record.title ?? record.message ?? "Pi permission",
          status: "pending",
          kind: "other",
        },
        options: values.map((name, index) => ({
          optionId: String(index),
          name,
          kind: index === 0 ? "allow_once" : "reject_once",
        })),
      },
    );
    if (response.outcome.outcome === "cancelled")
      await write({
        type: "extension_ui_response",
        id: record.id,
        cancelled: true,
      });
    else {
      const index = Number(response.outcome.optionId);
      await write({
        type: "extension_ui_response",
        id: record.id,
        ...(record.method === "confirm"
          ? { confirmed: index === 0 }
          : { value: values[index] }),
      });
    }
  } catch {
    await write({
      type: "extension_ui_response",
      id: record.id,
      cancelled: true,
    }).catch(() => {});
  }
}
function record(record: any) {
  if (record.type === "response") {
    const p = pending.get(record.id);
    if (!p) return;
    record.success
      ? p.resolve(record.data)
      : p.reject(new Error(record.error ?? "Pi RPC command failed"));
    return;
  }
  if (record.type === "extension_ui_request") {
    void ui(record);
    return;
  }
  if (!active) return;
  if (record.type === "message_update") {
    const e = record.assistantMessageEvent;
    if (e?.type === "text_delta" || e?.type === "thinking_delta")
      update({
        sessionUpdate:
          e.type === "text_delta"
            ? "agent_message_chunk"
            : "agent_thought_chunk",
        content: { type: "text", text: e.delta },
      });
  } else if (
    record.type === "message_end" &&
    record.message?.role === "assistant"
  ) {
    active.error =
      record.message.stopReason === "error"
        ? (record.message.errorMessage ?? "Pi provider failed")
        : undefined;
    active.reason = record.message.stopReason;
  } else if (record.type === "tool_execution_start")
    update({
      sessionUpdate: "tool_call",
      toolCallId: record.toolCallId,
      title: record.toolName,
      kind:
        record.toolName === "read"
          ? "read"
          : record.toolName === "bash"
            ? "execute"
            : record.toolName === "write" || record.toolName === "edit"
              ? "edit"
              : "other",
      status: "in_progress",
      rawInput: record.args,
    });
  else if (
    record.type === "tool_execution_update" ||
    record.type === "tool_execution_end"
  )
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: record.toolCallId,
      status:
        record.type === "tool_execution_update"
          ? "in_progress"
          : record.isError
            ? "failed"
            : "completed",
      rawOutput: record.result ?? record.partialResult,
      content: (record.result ?? record.partialResult)?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => ({
          type: "content",
          content: { type: "text", text: c.text },
        })),
    });
  else if (record.type === "agent_settled") {
    const run = active;
    active = undefined;
    void notificationTail.then(() => {
      if (run.cancelled || run.reason === "aborted")
        run.resolve({ stopReason: "cancelled" });
      else if (run.error) run.reject(new Error(run.error));
      else
        run.resolve({
          stopReason: run.reason === "length" ? "max_tokens" : "end_turn",
        });
    });
  }
}
async function launch(cwd: string) {
  if (child) throw new Error("The Pi adapter supports one session per process");
  if (cwd !== process.cwd())
    throw new Error("Session cwd must match the launch working directory");
  const args = [
    "--mode",
    "rpc",
    "--model",
    settings.model,
    "--session-dir",
    config.sessionDir,
    "--session-id",
    sessionId,
    "--no-extensions",
    "--extension",
    "builtin:mcp",
    "--extension",
    join(import.meta.dir, "pi-extension.ts"),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
  ];
  if (settings.provider) args.push("--provider", settings.provider);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.appendSystemPrompt)
    args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.tools) args.push("--tools", options.tools.join(","));
  child = spawn(options.executable, args, {
    cwd,
    env: process.env,
    stdio: "pipe",
  });
  child.stderr.pipe(process.stderr);
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`Pi RPC exited (${code ?? signal})`));
    if (!closing) process.exit(1);
  });
  const lines = new JsonLines(16 * 1024 * 1024, (line) =>
    record(JSON.parse(line)),
  );
  child.stdout.on("data", (chunk) => {
    try {
      lines.push(chunk);
    } catch (error) {
      fail(error as Error);
      child?.kill("SIGTERM");
    }
  });
  const state = await rpc("get_state");
  // Fail closed rather than falling back to a default/fuzzy-match model.
  if (
    !state.model ||
    state.model.id !== settings.model ||
    (settings.provider && state.model.provider !== settings.provider)
  )
    throw new Error(
      `Pi selected unexpected model ${state.model?.provider}/${state.model?.id}`,
    );
  sessionId = state.sessionId;
  return { sessionId };
}
const app = acp
  .agent({ name: "pi-rpc-adapter" })
  .onConnect((connection) => {
    client = connection.client;
  })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
    agentInfo: { name: "pi-rpc-adapter", version: "0.1.0" },
  }))
  .onRequest("session/new", (ctx) => launch(ctx.params.cwd))
  .onRequest("session/load", async (ctx) => {
    sessionId = ctx.params.sessionId;
    await launch(ctx.params.cwd);
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    if (ctx.params.sessionId !== sessionId) throw new Error("Unknown session");
    if (active) throw new Error("Prompt already active");
    if (ctx.params.prompt.some((block) => block.type !== "text"))
      throw new Error("Pi adapter currently supports text prompts only");
    const text = ctx.params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    let run: Run;
    const result = new Promise<acp.PromptResponse>((resolve, reject) => {
      run = { resolve, reject, cancelled: false };
      active = run;
    });
    // Install completion/error handlers before sending: very short runs may settle before acceptance.
    void rpc("prompt", { message: text }).then(
      (data) => {
        if (data?.disposition === "handled" && active === run) {
          active = undefined;
          run.resolve({ stopReason: "end_turn" });
        }
      },
      (error) => {
        if (active === run) active = undefined;
        run.reject(error);
      },
    );
    return result;
  })
  .onNotification("session/cancel", async (ctx) => {
    if (ctx.params.sessionId !== sessionId || !active) return;
    active.cancelled = true;
    await rpc("clear_queue");
    await rpc("abort");
  });
const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
async function shutdown() {
  if (closing) return;
  closing = true;
  if (child) {
    const exited = once(child, "exit");
    child.stdin.end();
    try {
      await deadline(exited, 4000, "Pi shutdown timed out");
    } catch {
      child.kill("SIGTERM");
    }
  }
  connection.close();
}
void connection.closed.then(shutdown);
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
