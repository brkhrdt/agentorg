# Agent Organization Server

A single-user Bun/TypeScript service managing a tree of agent processes. Clients use JSONL over a Unix socket; harnesses use **ACP v1** (`@agentclientprotocol/sdk`); agents manage descendants using **MCP** (`@modelcontextprotocol/sdk`). SQLite persists agents, operations, and sequenced history.

The core is harness-neutral and registers **no built-in harnesses**. Load trusted plugins explicitly. The separate [`@agentorg/plugin-pi-agent`](../agentorg-plugin-pi-agent/README.md) provides the Pi RPC-to-ACP adapter and organization MCP extension; other ACP harnesses can run in the same tree.

## Run

Requires Unix and Bun. Pi is optional and required only when using the separate Pi plugin (Pi 1.0.2+, Node 22.19+).

```sh
bun install --frozen-lockfile
bun start                         # .org/server.sock and .org/organization.sqlite; no harnesses
# To enable Pi: install dependencies in ../agentorg-plugin-pi-agent first,
# install/configure Pi separately, and authenticate with pi /login.
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts
# Optional:
bun start --data-dir /tmp/my-org --config limits.json --plugin ./my-plugin.ts
```

Previously active agents restart by default, parent before child. Use `--no-recover` to leave them stopped; `--recover` remains accepted for compatibility, but `--no-recover` takes precedence. Graceful server shutdown uses SIGINT/SIGTERM. A deployment lock prevents multiple servers sharing a database. Only an owned, stale socket inside the data directory is automatically removed. If placing the socket elsewhere, remove a stale socket yourself after verifying no server is running.

### Standalone binary

Build with **Bun 1.4.3+** (Unix):

```sh
bun install --frozen-lockfile
bun run build                     # dist/agentorg
./dist/agentorg --help
./dist/agentorg --data-dir /absolute/path/my-org
# Optional cross-compilation:
bun run build --target=bun-linux-x64
# Other examples: bun-linux-arm64, bun-darwin-arm64, bun-linux-x64-baseline
```

Distribute **only `dist/agentorg`**; the destination does not need Bun, this
repository, or `node_modules`. Build for the destination OS/CPU (use `-baseline`
for older x64 CPUs). Windows is not supported. The binary embeds SQLite, the
generic MCP bridge, re-executing itself for that internal worker. It contains
no Pi code or Pi SDK dependency. For Pi, build the separate plugin and ship
`dist/index.js` plus its adjacent `dist/pi-acp` executable, then pass
`--plugin /path/to/pi-plugin/index.js`. That adapter does not need Bun on PATH.

Install/configure Pi and its Node runtime separately when using the plugin,
or set the agent's `options.executable` to Pi's path.
Provider credentials, workspace files, configuration, and persistent data are
not bundled. Custom `--plugin` modules remain external trusted files. For compiled hosts,
bundle their npm dependencies into the external plugin (`bun build --target=bun`)
instead of relying on runtime package resolution; ship that module separately. Paths and CLI flags work
the same as source mode, with relative paths resolved from the current directory.

`bun run test:binary` tests a relocated generic host, an explicit ACP fixture
plugin and the core MCP bridge, and verifies that Pi is not implicitly registered.
Pi adapter tests live in the separate plugin repo.

### Live demonstration

Start a **fresh organization** with the Pi plugin (only one active root is permitted), then run the demo from the plugin repository:

```sh
cd ../agentorg-plugin-pi-agent
bun demo /absolute/path/to/.org/server.sock /tmp/org-demo-workspace
```

The client creates a Pi root using **`openai-codex/gpt-6-luna`**, subscribes to events, and asks it to create two Pi children: a coder writes `add.ts`; a tester writes `add.test.ts`. The root sends both tasks, waits for their operations, runs the tests, and reports the result. JSONL lifecycle, message, tool, and operation events stream to stdout. Agents and files remain available afterward.

## Client API

The JSONL client contract, request schemas, event payloads, and reconnect behavior are documented here alongside the API implementation.

Every record ends with LF. Literal Unicode line/paragraph separators are supported. IDs correlate responses; events may precede responses and concurrent requests may finish out of order. `settings.model` is optional; with the Pi plugin, omit it to use Pi's configured default model (the literal string `"default"` is not a model ID).

```json
{"id":"1","method":"agent.create","params":{"name":"root","settings":{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna","cwd":"/tmp/project","options":{"thinking":"low"}}}}
{"kind":"response","id":"1","ok":true,"result":{"id":"operation-id","type":"agent.create","status":"queued","caller":{"kind":"client","id":"connection-id"},"agentId":null,"createdAt":"...","input":{"...":"..."}}}
{"kind":"event","seq":1,"time":"...","type":"operation.changed","data":{"...":"..."}}
```

Poll/wait for creation to finish, then read `operation.result.id` (or `operation.agentId`):

```json
{"id":"2","method":"operation.wait","params":{"operationId":"operation-id","waitMs":1000}}
{"id":"3","method":"agent.prompt","params":{"agentId":"agent-id","text":"Implement the task","queue":false}}
{"id":"4","method":"subscribe","params":{"excludeTypes":["tool.update"],"agentIds":["agent-id"],"subtrees":true}}
```

Errors: `{"kind":"response","id":"1","ok":false,"error":{"code":"CONFLICT","message":"Stale agent revision"}}`. A malformed request uses its ID when available, otherwise `null`. Long-running failures are recorded on the operation, not a second request response.

| Method                  | Parameters / behavior                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `organization.snapshot` | `{}`; active **and historical** agent records, retained operations, current sequence                                                |
| `agent.create`          | `{parentId?: string                                                                                                                 | null, name?, metadata?, settings}`; omitted parent creates root |
| `agent.get`             | `{agentId}`; includes removed records                                                                                               |
| `agent.modify`          | `{agentId, expectedRevision?, name?, metadata?, settings?}`; partial settings merge, `options`/`env` replace rather than deep-merge |
| `agent.stop`            | `{agentId}`; stops only that agent, not children                                                                                    |
| `organization.providers` | `{harness, cwd?, env?, options?}`; available providers for a discovery-capable harness |
| `organization.models` | `{harness, provider, cwd?, env?, options?}`; available models for the selected provider |
| `organization.paths` | `{input?, base?, kind?: "directory" \| "any", limit?, create?}`; server-side fuzzy path candidates (five by default); client-only; `create: true` recursively creates the requested directory |
| `agent.restart`         | `{agentId}`; restarts only that agent; context retention depends on harness session-loading capability                              |
| `agent.restart_subtree` | `{agentId}`; stops child-first, starts parent-first, continues after individual startup failures                                    |
| `agent.replace_session` | `{agentId}`; new context/session number, descendants unaffected                                                                     |
| `agent.remove`          | `{agentId}`; stops and archives entire subtree; never deletes workspaces/session history                                            |
| `agent.prompt`          | `{agentId, text, queue?: boolean}`; returns prompt operation                                                                        |
| `operation.get`         | `{operationId}`                                                                                                                     |
| `operation.wait`        | `{operationId, waitMs?: number}`; default 1s, capped at configured maximum (30s); waiting never cancels work                        |
| `operation.cancel`      | `{operationId}`; queued operations stop immediately; active prompts request cancellation                                            |
| `subscribe`             | `{enabled?, types?, excludeTypes?, agentIds?, subtrees?}`; replaces this connection's filter; default all live events               |
| `events.history`        | `{after?: number, limit?: number, agentId?}`; retained events after a sequence, max page size 1000, exact agent filter              |
| `permission.respond`    | `{permissionId, optionId? , cancelled?}`; select an offered option or cancel                                                        |

Operations contain caller, target, type, input, status, creation/start/completion timestamps, result/error, and optional `cancelRequested`. Statuses: `queued`, `running`, `completed`, `failed`, `stopped`. Last three are terminal. Prompt results contain bounded `text`, `truncated`, and ACP `stopReason`. Metadata and launch changes increment agent revisions; state changes do not. Metadata-only modifications preserve the generation. Changes to launch settings restart active agents; stopped/failed agents remain stopped/failed until explicitly restarted.

Requests starting lifecycle work return operations promptly. Lifecycle mutations serialize organization-wide; model work never holds that queue. Per-agent prompt queues are FIFO, with a global execution cap. Default prompts cancel queued work and request cancellation of active work before running the replacement. **Cancellation acknowledgment is ACP's completed prompt response, not merely notification delivery**. Active cancellation stays `running` until acknowledgment or process termination. Unresponsive cancellation kills the agent and marks it failed; queued replacements stop too. A running lifecycle mutation cannot be rolled back (`NOT_CANCELLABLE`); queue a subsequent stop if needed.

A TypeScript client is exported from `src/client.ts`:

```ts
import { OrganizationClient } from "./src/client.ts";
import type { Operation, AgentRecord } from "./src/types.ts";
const client = await OrganizationClient.connect("/absolute/path/server.sock");
client.onEvent((event) => console.log(event));
const creation = await client.wait(
  await client.request<Operation>("agent.create", {
    settings: { harness: "pi", model: "gpt-6-luna", provider: "openai-codex" },
  }),
);
const root = creation.result as AgentRecord;
const work = await client.wait(
  await client.request<Operation>("agent.prompt", {
    agentId: root.id,
    text: "Inspect this workspace",
  }),
);
console.log(work.result);
client.close();
```

### Events and reconnects

Categories: `server.ready/stopped`, `agent.created/state/modified/removed/session_replaced`, `agent.message/update/plan/error`, `tool.call/update/result`, `prompt.queued/started/cancelling/finished`, `operation.changed`, `permission.requested/resolved`, `plugin.error`. `agent.message` contains ACP message/thought chunks; tool results are ACP tool-call updates. All events have a durable monotonically increasing `seq`, including across server restarts. Agent events carry a process generation; replaced generations cannot update current state or complete newer work.

Subscriptions are **live-only**, not replay streams. A new connection subscribes to all events by default. For resynchronization, attach your listener first, query `organization.snapshot`, and discard buffered events at/before its sequence. `events.history` provides historical pages, `{events, oldestSeq, latestSeq, expired}`. `expired=true` means the cursor precedes retained history: obtain a snapshot instead of assuming complete replay. Empty `types`/`agentIds` selects nothing. Exact and subtree live filters are supported. Slow clients exceeding their output-buffer limit are disconnected, never allowed to stall agent execution.

## MCP and hierarchy

The server issues a fresh per-generation capability to each harness. `src/mcp-bridge.ts` uses the MCP SDK's stdio transport and forwards tools to the socket; the caller identity comes from that capability, never model-supplied arguments. Capabilities expire when the generation stops/restarts.

Tools: `child_create`, `descendant_prompt`, `agent_get`, `organization_snapshot`, `descendant_modify`, `descendant_stop`, `descendant_restart`, `descendant_restart_subtree`, `descendant_replace_session`, `descendant_remove`, `operation_get/wait/cancel`. Pi exposes them as `mcp__organization__<name>`.

Agents create children **only under themselves**. Mutations/prompts target strict descendants, never ancestors, siblings, or themselves. Queries include self and descendants; operation queries/cancellation include operations initiated by the caller or targeting its descendants. Each tool returns an operation or query result as MCP text content; errors set `isError: true`. Creation operations must complete before using their resulting child IDs.

Waiting inside a tool retains the parent prompt's global slot. Configure enough prompt slots for coordinators and workers (default 8); a saturated organization where every running agent waits on queued descendants can deadlock. Operation waits are bounded so agents can revise their coordination strategy.

Pi confirm/select dialogs become ACP permission requests. Clients choose with `permission.respond`; timeout/cancellation denies permission. Input/editor dialogs are cancelled because ACP permission options cannot represent arbitrary editor text. Pi built-in file/bash tools otherwise have Pi's normal trusted local access.

## Plugins

Trusted TypeScript modules export `ServerPlugin` with `apiVersion: 1`, `name`, and `setup(host)`; load explicit paths with repeatable `--plugin`. API types live in `src/plugin.ts`; incompatible versions and duplicate names fail startup. The generic extension APIs are additive within v1; plugins using the removed pre-1.0 feature-manager API must upgrade in this coordinated contract replacement. See [extension contract and commit boundaries](EXTENSIONS.md).

Snapshots advertise `capabilities.cwd` (server startup directory) and `capabilities.pathCompletion` for the client-only `organization.paths` query. Path discovery supports relative/absolute paths, `~/`, hidden entries when typing `.`, and directory symlinks; it returns absolute paths without bypassing workspace-policy validation. Queries are read-only unless `create: true` is explicitly supplied to recursively create the requested directory.

Harnesses may implement optional `listModels(context)` returning `{provider, id, name?}` entries. The host advertises those harnesses in `snapshot.capabilities.modelDiscovery` and exposes read-only `organization.providers`/`organization.models` queries (select a provider first). Discovery receives draft `cwd`, `env`, and `options`, is timeout-bounded, and returns only public model identifiers/display names. No harness is launched by core for discovery; legacy harnesses remain valid and clients can use manual entry.

Hooks register ACP harnesses, namespaced client endpoints/settings/capabilities, MCP tools, event observers, lifecycle transaction participants, settings/launch transformations, and shutdown handlers. `settings.extensions` round-trips plugin-owned JSON; supplied namespace values replace only that namespace, while omitted namespaces remain unchanged. `beforeMutation` may request atomic multi-record settings updates with compensation/finalization. `prepareLaunch` supplies env/MCP configuration before harness launch, and `validateLaunch` checks the final resolved spec. Unknown persisted extension/legacy data is retained but blocks launch/modification until its owning plugin is loaded. Discover optional features through `snapshot.capabilities.plugins`. `transformTool` augments an existing tool's schema/execution; `beforeSettings` validates/transforms create/modify settings inside the lifecycle queue before persistence or stopping a running agent. Launch specs default to the server cwd/environment (plus agent settings). Launch hooks can customize command/arguments, env, cwd, wrappers/containers, and bounded `gracefulStop`. `LaunchSpec.inheritEnv: false` opts out of ambient host/agent environment merging for isolated wrappers; plugin context env and core capability variables still apply. Container plugins can set `LaunchContext.executionEnvironment: "container"` before harness launch so commands resolve inside the image. A stop still closes stdin, escalates to SIGTERM/SIGKILL, and kills remaining members of the process group. See `examples/acp-plugin.ts`.

Observers run without blocking the transport; errors become `plugin.error`, and events emitted by observers are not re-observed recursively. Endpoint/tool failures are isolated per request. Launch failures fail only the affected agent/operation. Plugin setup failures fail startup; shutdown hooks have deadlines. **Plugins are trusted in-process code**, not fault/security sandboxes: a plugin that blocks the event loop, exits the process, or tampers with server state cannot be isolated.

### Pi plugin (separate repository)

Load `--plugin ../agentorg-plugin-pi-agent/src/index.ts` in source mode, or its built `dist/index.js` with the adjacent compiled `pi-acp` adapter in binary deployments. It uses the public `LaunchContext.mcpServers` specs, not core worker paths, and has no runtime imports from core. Existing `harness: "pi"` records and session directories are unchanged; load this plugin to restart/recover them. Without it, Pi is an unknown/unavailable harness (`INVALID_HARNESS` on creation, `START_FAILED` for restart operations), without deleting persisted data. See [installation and runtime overrides](../agentorg-plugin-pi-agent/README.md).

Harness-specific options, resource loading, credentials and session details belong to the separate harness plugin's documentation. Feature plugins own their policy, external storage, migration and readiness checks; core never interprets their namespaces.

### cwd plugin (separate repository)

Enable strict workspace nesting with the optional **`cwd`** plugin from [agentorg-plugin-unique-cwd](../agentorg-plugin-unique-cwd/README.md):

```sh
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-unique-cwd/src/index.ts
```

For compiled servers, build that repository and load `../agentorg-plugin-unique-cwd/dist/index.js`. The runtime plugin name (`cwd`) and persisted `settings.cwd` remain unchanged; replace the old `./src/plugins/cwd.ts` load path. Core does not enforce nesting without the plugin.

MCP `child_create` gains a **required top-level `cwd`** argument (use this instead of `settings.cwd`):

```json
{"name":"coder","cwd":"workers/coder","settings":{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna"}}
```

Directories must already exist. Relative child paths resolve from the **direct parent's cwd**; root paths resolve from the server cwd (omitting root cwd uses the server cwd). Real paths are resolved through symlinks: a child's cwd must be strictly inside its parent's, never equal or outside. The plugin sets the harness process/ACP session cwd and rechecks containment at every launch, including restart/recovery.

Client `agent.create`/`agent.modify` continue using **`settings.cwd`**; child creation requires it too. Modifications cannot move an agent outside its parent or invalidate existing, nonremoved children's containment. Canonical absolute cwd is persisted and included in agent info as **`settings.cwd`** (`agent.get`, `organization.snapshot`, creation/modification results), including for stopped agents.

This is launch-time workspace validation, **not a filesystem sandbox**. Agents still have ordinary shell/file access; filesystem changes after validation and other trusted plugins can undermine containment.

### Podman plugin (separate repository)

The optional [`@agentorg/plugin-podman`](../agentorg-plugin-podman/README.md) runs every agent in a separate rootless container, using inherited images and explicit `settings.extensions.podman.readOnlyDirs` / `readWriteDirs` grants. `cwd` must be explicitly mounted. Agent grants cannot exceed caller/direct-parent permissions; trusted clients can add external directories. MCP create/modify tools gain directory grant arrays, and the TUI offers image-change scopes (node only, inheriting descendants, all descendants).

Load Podman after other launch-transforming plugins. Images contain the harness and startup/MCP helpers; see its example Pi Containerfile/build script. The plugin mounts only explicit grants, the agent's private session directory, and a capability-scoped MCP relay—not the public organization socket or database. No host credentials/environment are implicitly copied. See its README for isolation boundaries and real-Podman tests.

## Persistence, limits, and recovery

`limits.json` is a flat object of overrides (unknown keys/nonpositive values are rejected). Defaults:

| Limit                                           |          Default |
| ----------------------------------------------- | ---------------: |
| `maxDepth` (root depth 0) / `maxChildren`       |           8 / 16 |
| `maxProcesses` / `maxPrompts`                   |           32 / 8 |
| `maxQueuedPrompts` per agent                    |              100 |
| `maxPromptBytes` / `maxResponseBytes`           |  128 KiB / 1 MiB |
| `maxEvents` / retained terminal `maxOperations` | 100,000 / 10,000 |
| `maxAgents` (including historical records)      |           10,000 |
| `maxLineBytes` / `maxClientBufferBytes`         |    2 MiB / 4 MiB |
| `startTimeoutMs` / `cancelTimeoutMs`            |   30,000 / 5,000 |
| `stopTimeoutMs` / `killTimeoutMs`               |    5,000 / 1,000 |
| `maxWaitMs`                                     |           30,000 |

Oversized prompts/queues/trees/process counts are rejected. Oversized stored results/event data use `{truncated, originalBytes, preview}`; prompt text is additionally bounded during streaming. Large snapshots should use conservative record limits; output beyond a client's buffer cap disconnects that client. History prunes oldest events and terminal operations only, never active operations or agent records. Pruned operations return `NOT_FOUND`. Pi session files and workspaces are retained indefinitely; external archival/deletion is an operator decision.

SQLite uses WAL and synchronous FULL writes; history is not erased by removal or session replacement. At startup, all pending operations become `stopped` with `INTERRUPTED`, never resumed. Previously active agents restart parent-first by default, unless `--no-recover` is selected to leave them stopped. Recovery failures mark that agent failed and continue with descendants; already stopped/failed or removed agents are not automatically restarted. Abrupt process failure is contained to its agent, not descendants.

No authentication, multi-user protection, remote networking, default workspace-subdirectory enforcement, or filesystem sandbox is provided. The optional `cwd` plugin adds workspace-subdirectory validation, not sandboxing; the separate Podman plugin provides OS container filesystem isolation. Socket/database files are private to the OS user. Hierarchy permissions govern MCP calls; agents with ordinary shell access share that user's privileges and are not adversarially isolated from the public client socket. Workspace containment/isolation belongs in a trusted plugin.

## Tests

```sh
bun run check
bun test                     # deterministic ACP subprocess + MCP integration tests; no model calls
bun run test:binary
# Pi extension, adapter, offline loading and opt-in live tests:
# cd ../agentorg-plugin-pi-agent && bun test
```

The separate Pi plugin's `bun run test:live` needs working `openai-codex` credentials and uses only `gpt-6-luna`. It validates two child processes, their code/tests, ACP events, retained restart context, and session replacement. Model-backed demos/tests have no model fallback. Live agent behavior is inherently nondeterministic; failures include coordination diagnostics rather than silently switching models.
