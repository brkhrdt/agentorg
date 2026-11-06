import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "./runtime.ts";
import { OrganizationClient } from "../src/client.ts";
import { Store } from "../src/store.ts";
import { now, type AgentRecord } from "../src/types.ts";

test.each([
  { flags: [], state: "failed", recover: true },
  { flags: ["--recover"], state: "failed", recover: true },
  { flags: ["--no-recover"], state: "stopped", recover: false },
  { flags: ["--recover", "--no-recover"], state: "stopped", recover: false },
])("CLI recovery policy: $flags", async ({ flags, state, recover }) => {
  const dir = mkdtempSync(join(tmpdir(), "org-cli-"));
  const store = new Store(join(dir, "organization.sqlite"));
  store.saveAgent({
    id: "root", parentId: null, name: "root", metadata: {},
    settings: { harness: "unavailable", options: {} }, state: "running", revision: 1,
    generation: "old", sessionId: "session", sessionNumber: 1,
    removedAt: null, createdAt: now(), updatedAt: now(),
  });
  store.close();
  const child = spawn([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "--data-dir", dir, ...flags], { stdout: "ignore", stderr: "pipe" });
  let client: OrganizationClient | undefined;
  try {
    const deadline = Date.now() + 5000;
    let snapshot: { agents: AgentRecord[] } | undefined;
    while (!snapshot && Date.now() < deadline) {
      try {
        client ??= await OrganizationClient.connect(join(dir, "server.sock"));
        snapshot = await client.request("organization.snapshot");
      } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(snapshot?.agents[0]?.state).toBe(state);
    // An unavailable harness proves that default recovery actually attempts a launch.
    client?.close(); client = undefined;
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const persisted = new Store(join(dir, "organization.sqlite"));
    try {
      const ready = persisted.history(0, 100).events.find(e => e.type === "server.ready");
      expect((ready?.data as any).recover).toBe(recover);
    } finally { persisted.close(); }
  } finally {
    client?.close();
    child.kill(); await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI help advertises recovery opt-out", async () => {
  const child = spawn([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "--help"], { stdout: "pipe" });
  expect(await new Response(child.stdout).text()).toContain("--no-recover");
  expect(await child.exited).toBe(0);
});
