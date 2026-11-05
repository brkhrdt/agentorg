import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { COMPACTION_METHOD, type CompactionNotification, type LaunchSpec } from "./plugin.ts";
import type { Limits } from "./types.ts";
import { usageNotificationSchema, type UsageNotification } from "./usage.ts";
import {
  STEERING_EXTENSION,
  STEERING_METHOD,
  STEERING_STATUS_METHOD,
  STEERING_VERSION,
  steeringCapability,
  type SteeringResponse,
  type SteeringStatus,
} from "./steering-contract.ts";

export async function deadline<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export class AgentProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: acp.ClientConnection;
  readonly exited: Promise<number | null>;
  sessionId = "";
  stopping = false;
  stderr = "";
  private gracefulStop?: LaunchSpec["gracefulStop"];
  private steeringSupported = false;
  constructor(
    spec: LaunchSpec,
    readonly limits: Limits,
    update: (notification: acp.SessionNotification) => void,
    usage: (notification: UsageNotification | null) => void,
    compaction: (notification: CompactionNotification) => void,
    permission: (
      request: acp.RequestPermissionRequest,
    ) => Promise<acp.RequestPermissionResponse>,
    steeringStatus: (status: SteeringStatus) => void,
    exit: (message: string) => void,
  ) {
    this.gracefulStop = spec.gracefulStop;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "pipe",
      detached: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => {
        resolve(null);
        if (!this.stopping) exit(error.message);
      });
      this.child.once("exit", (code, signal) => {
        resolve(code);
        if (!this.stopping)
          exit(`Process exited (${code ?? signal}) ${this.stderr}`);
      });
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    this.connection = acp
      .client({ name: "agent-organization" })
      .onNotification("session/update", (ctx) => update(ctx.params))
      .onNotification("_agentorg/usage", usageNotificationSchema, (ctx) => usage(ctx.params))
      .onNotification(COMPACTION_METHOD, z.object({
        sessionId: z.string(), compactionId: z.string().min(1), phase: z.enum(["start", "end"]),
        reason: z.enum(["manual", "threshold", "overflow"]),
        aborted: z.boolean().optional(), willRetry: z.boolean().optional(),
        tokensBefore: z.number().nonnegative().optional(), estimatedTokensAfter: z.number().nonnegative().optional(),
        errorMessage: z.string().optional(),
      }).strict(), (ctx) => compaction(ctx.params))
      .onRequest("session/request_permission", (ctx) => permission(ctx.params))
      .onNotification(STEERING_STATUS_METHOD, z.object({ sessionId: z.string(), operationId: z.string().min(1), steeringId: z.string().min(1), status: z.enum(["delivered", "failed"]), error: z.object({ code: z.string().optional(), message: z.string() }).optional() }).strict(), (ctx) => steeringStatus(ctx.params as SteeringStatus))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(this.child.stdin),
          Readable.toWeb(
            this.child.stdout,
          ) as unknown as ReadableStream<Uint8Array>,
          { maxMessageBytes: limits.maxLineBytes },
        ),
      );
    void this.connection.closed.then(() => {
      if (!this.stopping) exit(`ACP connection closed ${this.stderr}`);
    });
  }
  get supportsSteering() {
    return this.steeringSupported;
  }
  async start(
    cwd: string,
    sessionId: string,
    mcpServers: acp.McpServer[],
    resume: boolean,
  ) {
    const init = await this.connection.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    if (init.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error("Unsupported ACP version");
    this.steeringSupported = steeringCapability(
      init.agentCapabilities?._meta?.[STEERING_EXTENSION],
    );
    if (resume && init.agentCapabilities?.loadSession) {
      await this.connection.agent.request("session/load", {
        cwd,
        sessionId,
        mcpServers,
      });
      this.sessionId = sessionId;
    } else {
      const session = await this.connection.agent.request("session/new", {
        cwd,
        mcpServers,
      });
      this.sessionId = session.sessionId;
    }
  }
  prompt(text: string, operationId: string) {
    return this.connection.agent.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
      _meta: { [STEERING_EXTENSION]: { version: STEERING_VERSION, operationId } },
    });
  }
  async steer(operationId: string, steeringId: string, text: string): Promise<SteeringResponse> {
    if (!this.steeringSupported)
      throw new Error("Harness does not advertise in-place steering support");
    return this.connection.agent.request<SteeringResponse>(STEERING_METHOD, {
      sessionId: this.sessionId,
      operationId,
      steeringId,
      text,
    });
  }
  cancel() {
    return this.connection.agent.notify("session/cancel", {
      sessionId: this.sessionId,
    });
  }
  private signal(signal: NodeJS.Signals) {
    try {
      process.kill(-this.child.pid!, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {}
    }
  }
  async stop() {
    if (this.stopping) return this.exited;
    this.stopping = true;
    this.child.stdin.end();
    try {
      await deadline(
        (async () => {
          if (this.gracefulStop && this.child.pid)
            await this.gracefulStop(this.child.pid);
          await this.exited;
        })(),
        this.limits.stopTimeoutMs,
        "Graceful stop timed out",
      );
    } catch {
      this.signal("SIGTERM");
      try {
        await deadline(
          this.exited,
          this.limits.killTimeoutMs,
          "SIGTERM timed out",
        );
      } catch {
        this.signal("SIGKILL");
        await this.exited;
      }
    } finally {
      // Reap any surviving children in the dedicated process group, even after its leader exits.
      this.signal("SIGKILL");
      this.connection.close();
    }
  }
}
