import { createServer, type Server, type Socket } from "node:net";
import {
  mkdirSync,
  chmodSync,
  lstatSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import { Organization } from "./organization.ts";
import { JsonLines } from "./jsonl.ts";
import {
  ApiError,
  errorShape,
  type Limits,
  type Caller,
  type ServerEvent,
} from "./types.ts";
import type { ServerPlugin } from "./plugin.ts";

const requestSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.string(),
    params: z.unknown().optional(),
    token: z.string().optional(),
  })
  .strict();
const subscriptionSchema = z
  .object({
    types: z.array(z.string()).optional(),
    excludeTypes: z.array(z.string()).default([]),
    agentIds: z.array(z.string()).optional(),
    subtrees: z.boolean().default(false),
    enabled: z.boolean().default(true),
    renderings: z.boolean().default(false),
  })
  .strict();
type Subscription = z.infer<typeof subscriptionSchema>;
export interface ServerOptions {
  socketPath: string;
  dataDir: string;
  limits?: Partial<Limits>;
  plugins: ServerPlugin[];
  /** Restart previously active agents on startup (default true). */
  recover?: boolean;
}

export class OrganizationServer {
  readonly organization: Organization;
  private server: Server;
  private clients = new Set<Socket>();
  private ready = false;
  private lockPath: string;
  private socketPath: string;
  private ownsSocket = false;
  private closePromise?: Promise<void>;
  private constructor(options: ServerOptions, lockPath: string) {
    this.socketPath = resolve(options.socketPath);
    this.lockPath = lockPath;
    this.organization = new Organization(
      this.socketPath,
      resolve(options.dataDir),
      options.limits,
    );
    this.server = createServer((socket) => this.connect(socket));
  }
  static async start(options: ServerOptions): Promise<OrganizationServer> {
    const dir = resolve(options.dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, "server.lock");
    // Exclusive deployment lock prevents two sockets from operating the same database.
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(`Invalid lock ${lock}; inspect it manually`);
      try {
        process.kill(pid, 0);
        throw new Error(`Server already running (pid ${pid})`);
      } catch (probe: any) {
        if (probe.code !== "ESRCH") throw probe;
      }
      unlinkSync(lock);
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
    }
    let instance: OrganizationServer | undefined;
    try {
      instance = new OrganizationServer(options, lock);
      for (const plugin of options.plugins)
        await instance.organization.use(plugin);
      mkdirSync(dirname(instance.socketPath), { recursive: true, mode: 0o700 });
      try {
        const stat = lstatSync(instance.socketPath);
        // Only a stale socket in our own data directory can be removed automatically.
        if (
          !stat.isSocket() ||
          stat.uid !== process.getuid?.() ||
          dirname(instance.socketPath) !== dir
        )
          throw new Error(`Socket path exists: ${instance.socketPath}`);
        const { createConnection } = await import("node:net");
        await new Promise<void>((resolveProbe, reject) => {
          const probe = createConnection(instance!.socketPath);
          probe.setTimeout(1000, () => {
            probe.destroy();
            reject(new Error("Socket liveness probe timed out"));
          });
          probe.on("connect", () => {
            probe.destroy();
            reject(new Error("Socket already in use"));
          });
          probe.on("error", (error: any) => {
            if (error.code === "ECONNREFUSED") resolveProbe();
            else reject(error);
          });
        });
        unlinkSync(instance.socketPath);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise<void>((res, rej) => {
        instance!.server.once("error", rej);
        instance!.server.listen(instance!.socketPath, () => {
          instance!.server.off("error", rej);
          res();
        });
      });
      instance.ownsSocket = true;
      chmodSync(instance.socketPath, 0o600);
      await instance.organization.initialize(options.recover);
      instance.ready = true;
      return instance;
    } catch (error) {
      if (instance) await instance.close();
      else unlinkSync(lock);
      throw error;
    }
  }
  private connect(socket: Socket) {
    this.clients.add(socket);
    let filter: Subscription = {
      excludeTypes: [],
      enabled: true,
      subtrees: false,
      renderings: false,
    };
    let eventCaller: Caller = { kind: "client", id: crypto.randomUUID() };
    let internal = false;
    let inflight = 0;
    const send = (value: unknown) => {
      if (socket.destroyed) return;
      const line = JSON.stringify(value) + "\n";
      if (
        socket.writableLength + Buffer.byteLength(line) >
        this.organization.limits.maxClientBufferBytes
      ) {
        socket.destroy();
        return;
      }
      socket.write(line);
    };
    const matches = (event: ServerEvent) => {
      if (!filter.enabled || internal) return false;
      if (
        eventCaller.kind === "agent" &&
        (!event.agentId ||
          !this.organization.isDescendant(event.agentId, eventCaller.id))
      )
        return false;
      if (filter.types && !filter.types.includes(event.type)) return false;
      if (filter.excludeTypes.includes(event.type)) return false;
      if (
        filter.agentIds &&
        !filter.agentIds.some(
          (id) =>
            event.agentId === id ||
            (filter.subtrees &&
              event.agentId &&
              this.organization.isDescendant(event.agentId, id)),
        )
      )
        return false;
      return true;
    };
    const unsubscribe = this.organization.subscribe((event) => {
      if (matches(event)) {
        if (filter.renderings && eventCaller.kind !== "agent") {
          const rendering = this.organization.renderEvent(event);
          if (rendering) send({ kind: "presentation", seq: event.seq, rendering });
        }
        send(event);
      }
    });
    const handle = async (line: string) => {
      let id: string | number | null = null;
      try {
        if (++inflight > 128)
          throw new ApiError("LIMIT", "Too many in-flight requests");
        const raw = JSON.parse(line);
        if (typeof raw?.id === "string" || typeof raw?.id === "number")
          id = raw.id;
        const request = requestSchema.parse(raw);
        id = request.id;
        if (!this.ready) throw new ApiError("NOT_READY", "Server is starting");
        if (request.token) {
          eventCaller = this.organization.callerForToken(request.token);
          internal = true;
        }
        const caller = request.token
          ? this.organization.callerForToken(request.token)
          : eventCaller;
        if (internal && !request.token)
          throw new ApiError(
            "FORBIDDEN",
            "Agent requests require a current capability",
          );
        let result: unknown;
        if (request.method === "subscribe") {
          filter = subscriptionSchema.parse(request.params ?? {});
          result = { liveOnly: true, seq: this.organization.store.sequence() };
        } else
          result = await this.organization.request(
            request.method,
            request.params ?? {},
            caller,
          );
        send({ kind: "response", id, ok: true, result });
      } catch (error) {
        send({ kind: "response", id, ok: false, error: errorShape(error) });
      } finally {
        inflight--;
      }
    };
    const lines = new JsonLines(
      this.organization.limits.maxLineBytes,
      (line) => {
        void handle(line);
      },
    );
    socket.on("data", (chunk) => {
      try {
        lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        send({
          kind: "response",
          id: null,
          ok: false,
          error: {
            code: "FRAME_TOO_LARGE",
            message: errorShape(error).message,
          },
        });
        socket.end();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      unsubscribe();
      this.clients.delete(socket);
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.ready = false;
    this.closePromise = (async () => {
      const closed = new Promise<void>((resolveClose) => {
        if (this.server.listening) this.server.close(() => resolveClose());
        else resolveClose();
      });
      await this.organization.close();
      for (const socket of this.clients) socket.destroy();
      await closed;
      if (this.ownsSocket) {
        try {
          unlinkSync(this.socketPath);
        } catch {}
      }
      try {
        unlinkSync(this.lockPath);
      } catch {}
    })();
    return this.closePromise;
  }
}
