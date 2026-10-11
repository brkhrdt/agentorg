import { expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrganizationClient } from "../src/client.ts";
import type { AgentRecord, Operation } from "../src/types.ts";

// Core binary requires no Pi runtime/dependencies or built-in harness.
test.skipIf(!process.env.ORG_BINARY)("standalone generic host, explicit ACP plugin and MCP subprocess", async () => {
  const dir = await mkdtemp(join(tmpdir(), "org-binary-"));
  const binary = join(dir, "agentorg");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let client: OrganizationClient | undefined;
  let mcp: Client | undefined;
  try {
    await copyFile(resolve(process.env.ORG_BINARY!), binary);
    await chmod(binary, 0o755);
    const help = Bun.spawn([binary, "--help"], { cwd: dir, env: { PATH: dir }, stdout: "pipe" });
    expect(await new Response(help.stdout).text()).toContain("agentorg [");
    expect(await help.exited).toBe(0);
    const plugin = join(dir, "fixture-plugin.js");
    const bridgeFile = join(dir, 'bridge.json');
    const launchFile = join(dir, 'launch.json');
    await writeFile(plugin, `import {writeFileSync} from 'node:fs';
export default {apiVersion:1,name:'fixture',setup(host){host.registerHarness({name:'fixture',launch(ctx){
writeFileSync(${JSON.stringify(bridgeFile)},JSON.stringify(ctx.mcpServers[0]));
return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(join(import.meta.dir, 'fixtures/agent.ts'))}],env:{...process.env,ORG_FIXTURE:'{}'}};
}});
host.registerSettings({namespace:'demo',validate(value){if(typeof value!=='object')throw new Error('demo object required');return value;}});
host.registerCapability('demo',{settingsNamespace:'demo'});
host.prepareLaunch(ctx=>{ctx.env.DEMO_RESOURCE='explicit';});
host.beforeLaunch(spec=>({...spec,env:{...spec.env,DEMO_TRANSFORM:'applied'}}));
host.validateLaunch(spec=>{writeFileSync(${JSON.stringify(launchFile)},JSON.stringify(spec));});
}};`);
    const dataDir = join(dir, "data");
    const socket = join(dataDir, "server.sock");
    server = Bun.spawn([binary, "--data-dir", dataDir, '--plugin', plugin], { cwd: dir, env: { PATH: dir }, stdout: "ignore", stderr: "pipe" });
    const deadline = Date.now() + 5000;
    while (!client) {
      try { client = await OrganizationClient.connect(socket); }
      catch { if (Date.now() > deadline) throw new Error("Binary server did not start"); await Bun.sleep(20); }
    }
    const snapshot = await client.request<{ capabilities: { cwd: string; pathCompletion: boolean } }>('organization.snapshot');
    expect(snapshot.capabilities.cwd).toBe(dir);
    expect(snapshot.capabilities.pathCompletion).toBe(true);
    expect(await client.request('organization.paths', { input: './' })).toMatchObject({
      path: dir, isDirectory: true, entries: [{ name: 'data', path: dataDir, kind: 'directory' }],
    });
    const unknown = await client.wait(await client.request<Operation>('agent.create', { settings: { harness: 'pi', model: 'test-model' } }));
    expect(unknown.status).toBe('failed');
    expect(unknown.error?.code).toBe('INVALID_HARNESS');
    const creation = await client.wait(await client.request<Operation>("agent.create", {
      settings: { harness: "fixture", model: "test-model", extensions: { demo: { selected: true } } },
    }));
    expect(creation.status).toBe("completed");
    const agent = creation.result as AgentRecord;
    const transformed = JSON.parse(await readFile(launchFile, 'utf8'));
    expect(transformed.env.DEMO_RESOURCE).toBe('explicit');
    expect(transformed.env.DEMO_TRANSFORM).toBe('applied');
    expect(agent.settings.extensions).toEqual({ demo: { selected: true } });
    const prompt = await client.wait(await client.request<Operation>("agent.prompt", { agentId: agent.id, text: "hello" }));
    expect(prompt.status).toBe("completed");
    const bridge = JSON.parse(await readFile(bridgeFile, 'utf8'));
    expect(bridge.command).toBe(binary);
    expect(bridge.args).toEqual(['--internal-mcp-bridge']);
    mcp = new Client({ name: "binary-test", version: "1" });
    await mcp.connect(new StdioClientTransport({ command: bridge.command, args: bridge.args, cwd: dir,
      env: { PATH: dir, ...Object.fromEntries(bridge.env.map((entry: {name:string;value:string}) => [entry.name, entry.value])) } }));
    expect((await mcp.listTools()).tools.some(tool => tool.name === "child_create")).toBe(true);
    expect((await mcp.callTool({ name: "organization_snapshot", arguments: {} })).isError).not.toBe(true);
    await mcp.close(); mcp = undefined;
    client.close(); client = undefined;
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
  } finally {
    await mcp?.close(); client?.close();
    if (server && server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
