import { createConnection, type Socket } from "node:net";
import { CLIENT_MAX_RESPONSE_LINE_BYTES, JsonLines } from "./jsonl.ts";
import type { EventRendering } from "./rendering.ts";
import {
  ApiError,
  type ServerEvent,
  type Operation,
  terminal,
} from "./types.ts";

export class OrganizationClient {
  private socket: Socket;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: ServerEvent) => void>();
  private presentationListeners = new Set<(seq: number, rendering: EventRendering) => void>();
  private constructor(
    socketPath: string,
    private token?: string,
  ) {
    this.socket = createConnection(socketPath);
    const lines = new JsonLines(CLIENT_MAX_RESPONSE_LINE_BYTES, (line) => {
      const record = JSON.parse(line);
      if (record.kind === "event") {
        for (const listener of this.listeners) {
          try {
            listener(record);
          } catch {}
        }
        return;
      }
      if (record.kind === "presentation") {
        for (const listener of this.presentationListeners) {
          try { listener(record.seq, record.rendering); } catch {}
        }
        return;
      }
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.ok) pending.resolve(record.result);
      else
        pending.reject(new ApiError(record.error.code, record.error.message));
    });
    this.socket.on("data", (chunk) => {
      try {
        lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        this.socket.destroy(error as Error);
      }
    });
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () =>
      this.rejectAll(new Error("Organization socket closed")),
    );
  }
  static async connect(path: string, token?: string) {
    const client = new OrganizationClient(path, token);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("connect", resolve);
      client.socket.once("error", reject);
    });
    return client;
  }
  onEvent(listener: (event: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Opt in with subscribe({renderings: true}) after negotiating capability version 1. */
  onPresentation(listener: (seq: number, rendering: EventRendering) => void) {
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  }
  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.socket.destroyed)
      return Promise.reject(new Error("Organization socket closed"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Request ${method} timed out (server work is not cancelled)`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(this.token ? { token: this.token } : {}),
        }) + "\n",
        (error) => {
          if (error) {
            const p = this.pending.get(id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(id);
              p.reject(error);
            }
          }
        },
      );
    });
  }
  async wait(operation: Operation, timeoutMs = 120_000): Promise<Operation> {
    const end = Date.now() + timeoutMs;
    while (!terminal(operation)) {
      const left = end - Date.now();
      if (left <= 0)
        throw new Error(`Operation ${operation.id} wait timed out`);
      operation = await this.request<Operation>("operation.wait", {
        operationId: operation.id,
        waitMs: Math.min(30_000, left),
      });
    }
    return operation;
  }
  private rejectAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.socket.destroy();
  }
}
