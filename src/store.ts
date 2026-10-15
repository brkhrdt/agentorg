import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRecord, Operation, ServerEvent } from "./types.ts";
import type { ServerSettingsRecord } from "./server-settings.ts";

/** Records are durable; only bounded event and terminal-operation history is pruned. */
export class Store {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('schema', 1), ('sequence', 0);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_settings (namespace TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, agent_id TEXT, data TEXT NOT NULL);`);
    const version = this.db
      .query<{ value: number }, []>("SELECT value FROM meta WHERE key='schema'")
      .get()!.value;
    if (version !== 1)
      throw new Error(`Unsupported database schema ${version}`);
  }
  serverSettings(namespace: string): ServerSettingsRecord | undefined {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM server_settings WHERE namespace=?").get(namespace);
    return row ? JSON.parse(row.data) : undefined;
  }
  saveServerSettings(record: ServerSettingsRecord) {
    this.db.query("INSERT OR REPLACE INTO server_settings VALUES (?, ?)").run(record.namespace, JSON.stringify(record));
  }
  agents(): AgentRecord[] {
    return this.rows("agents");
  }
  operations(): Operation[] {
    return this.rows("operations");
  }
  private rows<T>(table: string): T[] {
    return this.db
      .query<{ data: string }, []>(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((r) => JSON.parse(r.data));
  }
  saveAgent(agent: AgentRecord) {
    this.db
      .query("INSERT OR REPLACE INTO agents VALUES (?, ?)")
      .run(agent.id, JSON.stringify(agent));
  }
  saveAgents(agents: AgentRecord[]) {
    this.db.transaction(() => {
      for (const agent of agents) this.saveAgent(agent);
    })();
  }
  saveOperation(op: Operation) {
    this.db
      .query("INSERT OR REPLACE INTO operations VALUES (?, ?)")
      .run(op.id, JSON.stringify(op));
  }
  deleteOperation(id: string) {
    this.db.query("DELETE FROM operations WHERE id=?").run(id);
  }
  event(event: Omit<ServerEvent, "seq">, maxEvents: number): ServerEvent {
    return this.db.transaction(() => {
      this.db.exec("UPDATE meta SET value=value+1 WHERE key='sequence'");
      const seq = this.sequence();
      const full = { ...event, seq };
      this.db
        .query("INSERT INTO events VALUES (?, ?, ?)")
        .run(seq, event.agentId ?? null, JSON.stringify(full));
      this.db.query("DELETE FROM events WHERE seq <= ?").run(seq - maxEvents);
      return full;
    })();
  }
  sequence(): number {
    return this.db
      .query<
        { value: number },
        []
      >("SELECT value FROM meta WHERE key='sequence'")
      .get()!.value;
  }
  history(
    after: number,
    limit: number,
    agentId?: string,
  ): {
    events: ServerEvent[];
    oldestSeq: number;
    latestSeq: number;
    expired: boolean;
  } {
    const oldestSeq =
      this.db
        .query<{ seq: number | null }, []>("SELECT MIN(seq) AS seq FROM events")
        .get()!.seq ?? this.sequence() + 1;
    const rows = agentId
      ? this.db
          .query<
            { data: string },
            [number, string, number]
          >("SELECT data FROM events WHERE seq>? AND agent_id=? ORDER BY seq LIMIT ?")
          .all(after, agentId, limit)
      : this.db
          .query<
            { data: string },
            [number, number]
          >("SELECT data FROM events WHERE seq>? ORDER BY seq LIMIT ?")
          .all(after, limit);
    return {
      events: rows.map((r) => JSON.parse(r.data)),
      oldestSeq,
      latestSeq: this.sequence(),
      expired: after < oldestSeq - 1,
    };
  }
  close() {
    this.db.close();
  }
}
