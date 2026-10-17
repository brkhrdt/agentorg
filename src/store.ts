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
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, agent_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_tool_context ON events (
        agent_id, json_extract(data, '$.generation'), json_extract(data, '$.data.toolCallId'), seq
      ) WHERE json_extract(data, '$.type') IN ('tool.call', 'tool.update', 'tool.result')
        AND (json_extract(data, '$.type')='tool.call' OR json_type(data, '$.data.title')='text'
          OR json_type(data, '$.data.toolName')='text' OR json_type(data, '$.data.rawInput') NOT IN ('null'));
      CREATE INDEX IF NOT EXISTS events_tool_boundary ON events (agent_id, seq)
        WHERE json_extract(data, '$.type') IN ('prompt.started', 'agent.session_replaced');`);
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
  /** Recover presentation-only call identity/arguments for sparse ACP updates and retained history.
   * Never merge status/output, cross generations/prompts, or write into the raw event. */
  presentationEvent(event: ServerEvent): ServerEvent {
    if (!["tool.update", "tool.result"].includes(event.type) || !event.agentId) return event;
    const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const current = object(event.data);
    if (typeof current.toolCallId !== "string") return event;
    // A complete adapter-supplied context is authoritative and needs no history lookup.
    const identified = [current.toolName, current.title].some(value => typeof value === "string" && value.length > 0);
    if (identified && current.rawInput != null) return event;
    const boundary = this.db.query<{ seq: number | null }, [string, number]>(`
      SELECT MAX(seq) AS seq FROM events WHERE agent_id=? AND seq<?
      AND json_extract(data, '$.type') IN ('prompt.started', 'agent.session_replaced')
    `).get(event.agentId, event.seq)?.seq ?? 0;
    const prior = this.db.query<{ seq: number; type: string; context: string }, [string, string | null, string, number, number]>(`
      SELECT seq, json_extract(data, '$.type') AS type,
        json_object('title', json_extract(data, '$.data.title'), 'toolName', json_extract(data, '$.data.toolName'),
          'kind', json_extract(data, '$.data.kind'), 'rawInput', json_extract(data, '$.data.rawInput')) AS context
      FROM events WHERE agent_id=? AND json_extract(data, '$.generation') IS ?
        AND json_extract(data, '$.data.toolCallId')=? AND seq>? AND seq<?
        AND json_extract(data, '$.type') IN ('tool.call', 'tool.update', 'tool.result')
        AND (json_extract(data, '$.type')='tool.call' OR json_type(data, '$.data.title')='text'
          OR json_type(data, '$.data.toolName')='text' OR json_type(data, '$.data.rawInput') NOT IN ('null'))
      ORDER BY seq DESC LIMIT 1
    `);
    const context: Record<string, unknown> = {};
    let cursor = event.seq;
    for (;;) {
      const row = prior.get(event.agentId, event.generation ?? null, current.toolCallId, boundary, cursor);
      if (!row) break;
      cursor = row.seq;
      const previous = JSON.parse(row.context) as Record<string, unknown>;
      for (const key of ["title", "toolName", "kind"]) {
        if (!context[key] && typeof previous[key] === "string" && previous[key]) context[key] = previous[key];
      }
      if (previous.rawInput != null) {
        context.rawInput = context.rawInput == null ? previous.rawInput :
          typeof context.rawInput === "object" && !Array.isArray(context.rawInput) && typeof previous.rawInput === "object" && !Array.isArray(previous.rawInput) ?
            { ...object(previous.rawInput), ...object(context.rawInput) } : context.rawInput;
      }
      if (row.type === "tool.call" || ((context.toolName || context.title) && context.rawInput != null)) break;
    }
    if (!Object.keys(context).length) return event;
    const data = { ...current };
    for (const [key, value] of Object.entries(context)) {
      if (data[key] == null || data[key] === "") data[key] = value;
      else if (key === "rawInput" && typeof data[key] === "object" && !Array.isArray(data[key]) && typeof value === "object" && !Array.isArray(value))
        data[key] = { ...object(value), ...object(data[key]) };
    }
    return { ...event, data };
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
