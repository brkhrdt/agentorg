import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../src/organization.ts";
import { Store } from "../src/store.ts";
import { defaults, type AgentRecord } from "../src/types.ts";
import { OrganizationServer } from "../src/server.ts";
import { OrganizationClient } from "../src/client.ts";

const record = (agentId: string, data: unknown = { text: "hello" }) => ({ kind: "event" as const, time: new Date().toISOString(), type: "agent.message", agentId, data });

test("event retention defaults to unlimited; zero survives restart and is editable through server settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-history-"));
  let org: Organization | undefined;
  try {
    expect(defaults.maxEvents).toBe(0);
    org = new Organization(join(dir, "sock"), dir, { maxEvents: 0 });
    for (let i = 0; i < 12; i++) org.store.event(record("root"), org.limits.maxEvents);
    const group: any = await org.request("organization.settings.get", { namespace: "core" });
    expect(group.fields.find((field: any) => field.key === "maxEvents").min).toBe(0);
    await org.request("organization.settings.update", { namespace: "core", expectedRevision: group.revision, patch: { maxEvents: 5 } });
    org.store.event(record("root"), org.limits.maxEvents);
    expect(org.store.history(0, 100).events).toHaveLength(5);
    const current: any = await org.request("organization.settings.get", { namespace: "core" });
    await org.request("organization.settings.update", { namespace: "core", expectedRevision: current.revision, patch: { maxEvents: 0 } });
    for (let i = 0; i < 12; i++) org.store.event(record("root"), org.limits.maxEvents);
    const count = org.store.history(0, 100).events.length;
    expect(count).toBeGreaterThan(5);
    await org.close();
    org = new Organization(join(dir, "sock"), dir);
    expect(org.limits.maxEvents).toBe(0);
    expect(org.store.history(0, 100).events).toHaveLength(count + 1); // Graceful close also persists server.stopped.
  } finally { await org?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("backwards history returns the newest matching events in ascending order with exclusive cursors", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-history-"));
  const store = new Store(join(dir, "db"));
  try {
    for (let i = 1; i <= 12; i++) store.event(record(i % 2 ? "root" : "worker"), 100);
    const latest = store.history(0, 3, "root", { before: 13 });
    expect(latest.events.map(e => e.seq)).toEqual([7, 9, 11]);
    expect(latest.hasMore).toBe(true);
    const older = store.history(0, 3, "root", { before: 7 });
    expect(older.events.map(e => e.seq)).toEqual([1, 3, 5]);
    expect(older.hasMore).toBe(false);
    expect(store.history(0, 3, "worker", { before: 2 }).events).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("history pages are byte bounded including renderings, preserve pagination and never truncate the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-history-"));
  const org = new Organization(join(dir, "sock"), dir, { maxClientBufferBytes: 16 * 1024 });
  try {
    org.agents.set("root", { id: "root", settings: { harness: "fixture" } } as AgentRecord);
    org.registerHarness({ name: "fixture", launch() { throw new Error("not launched"); }, renderers: [{
      id: "message", name: "Message", eventTypes: ["agent.message"], examples: [{ type: "agent.message", data: {} }],
      render(event) { return { summary: "message", extended: "message", full: (event.data as any).content.text }; },
    }] });
    let rendered = 0;
    for (let i = 0; i < 10; i++) org.store.event(record("root", { content: { type: "text", text: "x".repeat(6000) } }), 100);
    let after = 0;
    const received: number[] = [];
    while (after < 10) {
      const page: any = await org.request("events.history", { after, limit: 100, renderings: true });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(15 * 1024);
      expect(page.events.length).toBeGreaterThan(0);
      rendered += Object.keys(page.renderings).length;
      received.push(...page.events.map((event: any) => event.seq));
      after = page.events.at(-1).seq;
    }
    expect(received).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(rendered).toBeGreaterThan(0);
    org.store.event(record("root", { content: { type: "text", text: "y".repeat(100_000) } }), 100);
    const huge: any = await org.request("events.history", { before: 12, limit: 1, renderings: true });
    expect(huge.events.map((event: any) => event.seq)).toEqual([11]);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(15 * 1024);
    expect(huge.events[0].data.truncated).toBe(true);
    expect(JSON.parse(org.store.db.query<any, []>("SELECT data FROM events WHERE seq=11").get()!.data).data.content.text).toHaveLength(100_000);
  } finally { await org.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("large backwards history pages do not disconnect a real socket client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "org-history-socket-"));
  const server = await OrganizationServer.start({ dataDir: dir, socketPath: join(dir, "sock"), limits: { maxClientBufferBytes: 16 * 1024 }, plugins: [] });
  const client = await OrganizationClient.connect(join(dir, "sock"));
  try {
    const first = server.organization.store.sequence() + 1;
    for (let i = 0; i < 10; i++) server.organization.store.event(record("root", { text: "x".repeat(6000) }), 0);
    let before = server.organization.store.sequence() + 1;
    const received: number[] = [];
    for (;;) {
      const page: any = await client.request("events.history", { before, limit: 100 });
      received.unshift(...page.events.map((event: any) => event.seq));
      if (!page.hasMore) break;
      expect(page.events.length).toBeGreaterThan(0);
      before = page.events[0].seq;
    }
    expect(received.filter(seq => seq >= first)).toEqual(Array.from({ length: 10 }, (_, i) => first + i));
    expect(await client.request("organization.snapshot", { includeTerminalOperations: false })).toHaveProperty("seq");
  } finally { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
