# Agent Organization Server

A single-user Node.js/TypeScript service managing a tree of agent processes. Clients use JSONL over a Unix socket; harnesses use **ACP v1** (`@agentclientprotocol/sdk`); agents manage descendants using **MCP** (`@modelcontextprotocol/sdk`). SQLite persists agents, operations, and sequenced history.

The core is harness-neutral and registers **no built-in harnesses**. Load trusted plugins explicitly. The separate [`@agentorg/plugin-pi-agent`](../agentorg-plugin-pi-agent/README.md) provides the Pi RPC-to-ACP adapter and organization MCP extension; other ACP harnesses can run in the same tree.

## Run

Requires Unix and Node.js 22.14 or newer. Pi is optional and required only when using the separate Pi plugin (Pi 1.0.2+, Node 22.19+).

```sh
npm ci
npm start --                         # .org/server.sock and .org/organization.sqlite; no harnesses
# To enable Pi: install dependencies in ../agentorg-plugin-pi-agent first,
# install/configure Pi separately, and authenticate with pi /login.
npm start -- --plugin ../agentorg-plugin-pi-agent/src/index.ts
# Optional:
npm start -- --data-dir /tmp/my-org --config limits.json --plugin ./my-plugin.ts
```

Previously active agents restart by default, parent before child. Use `--no-recover` to leave them stopped; `--recover` remains accepted for compatibility, but `--no-recover` takes precedence. Graceful server shutdown uses SIGINT/SIGTERM. A deployment lock prevents multiple servers sharing a database. Only an owned, stale socket inside the data directory is automatically removed. If placing the socket elsewhere, remove a stale socket yourself after verifying no server is running.

### Standalone binary

Build with **Node.js 22.14+** (Unix), using an executable that includes the SEA fuse sentinel. Node.js 22.14 is the tested builder; some distributions of newer Node versions omit the sentinel.

```sh
npm ci
npm run build                     # dist/agentorg (standalone SEA executable)
./dist/agentorg --help
./dist/agentorg --data-dir /absolute/path/my-org
# The build uses the current Node.js executable; build separately on each target OS/CPU.
```

If the build Node executable lacks the SEA fuse sentinel, the build fails with guidance instead of producing a launcher or non-standalone fallback. Build on the target OS/CPU; cross-compilation is not supported. Windows is not supported. The application and generic MCP bridge are bundled, and the executable re-runs itself for that internal worker. It contains no Pi code or Pi SDK dependency. For Pi, build the separate plugin and ship
`dist/index.js` plus its adjacent `dist/pi-acp` executable, then pass
`--plugin /path/to/pi-plugin/index.js`. That adapter's runtime requirements are documented in its own repository.

Install/configure Pi and its Node runtime separately when using the plugin,
or set the agent's `options.executable` to Pi's path.
Provider credentials, workspace files, configuration, and persistent data are
not bundled. Custom `--plugin` modules remain external trusted files. For compiled hosts,
bundle their npm dependencies into the external plugin
instead of relying on runtime package resolution; ship that module separately. Paths and CLI flags work
the same as source mode, with relative paths resolved from the current directory.

`npm run test:binary` tests a relocated generic host, an explicit ACP fixture
plugin and the core MCP bridge, and verifies that Pi is not implicitly registered.
Pi adapter tests live in the separate plugin repo.

### Live demonstration

Start a **fresh organization** with the Pi plugin (only one active root is permitted), then run the demo from the plugin repository:

```sh
cd ../agentorg-plugin-pi-agent
npm run demo -- /absolute/path/to/.org/server.sock /tmp/org-demo-workspace
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
| `organization.snapshot` (agent RPC) | `{path?: string, includeTerminalOperations?: boolean}`; caller’s non-removed parent and direct children (self excluded), compact `{parent: AgentSummary | null, subagents: AgentSummary[]}` response, where each summary has `agentId` and `name`. Optional path writes a metadata report. Trusted client snapshots retain their full operator contract. |
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
| `agent.steer`           | `{agentId, operationId, text}`; client/trusted-server-only guidance for that exact active prompt; creates no operation              |
| `operation.get`         | `{operationId}`                                                                                                                     |
| `operation.wait`        | `{operationId, waitMs?: number}`; default 1s, capped at configured maximum (30s); waiting never cancels work                        |
| `operation.cancel`      | `{operationId}`; queued operations stop immediately; active prompts request cancellation                                            |
| `subscribe`             | `{enabled?, types?, excludeTypes?, agentIds?, subtrees?}`; replaces this connection's filter; default all live events               |
| `events.history`        | `{after?: number, before?: number, limit?: number, agentId?}`; paged retained events, max 1000, exact agent filter              |
| `permission.respond`    | `{permissionId, optionId? , cancelled?}`; select an offered option or cancel                                                        |

Trusted client snapshots retain `includeTerminalOperations` filtering and their full synchronization contract. On agent RPC/tool calls the flag is deprecated and a no-op: agent snapshots contain no operations.

Operations contain caller, target, type, input, status, timestamps, result/error, and optional `cancelRequested`. Statuses: `queued`, `running`, `completed`, `failed`, `stopped`, `interrupted`; the last four are terminal. `interrupted` means ACP work was ended by restart/recovery before a normal terminal response; it does not mean the logical notification was delivered. Prompt result shapes are harness/ACP-dependent (do not assume a `.text` property) and bounded by server limits. `agent.steer` requires the existing running prompt's `operationId`; it never creates/replaces an operation or cancels the prompt. It is supported only by harnesses advertising steering capability version 2. AgentOrg validates the exact active run, records `prompt.steer_submitted`, returns a `steeringId` immediately, and tracks the harness asynchronously. `prompt.steer_pending` means the harness accepted/queued guidance; only an explicit harness confirmation of delivery emits `prompt.steer_delivered`, while rejection, loss, or prompt settlement emits `prompt.steer_failed`. A tool batch may delay delivery. Validation failures (such as a stale operation) fail closed and emit a failure event without a submitted event. A client timeout/disconnect does not cancel an accepted steer; its outcome remains available through the event history, so do not automatically resend it. Generic ACP adapters must report pending acceptance and a terminal delivered/failed status keyed to the same steering ID and operation. Metadata and launch changes increment agent revisions; state changes do not. Metadata-only modifications preserve the generation. Changes to launch settings restart active agents; stopped/failed agents remain stopped/failed until explicitly restarted.

Requests starting lifecycle work return operations promptly. Lifecycle mutations serialize organization-wide; model work never holds that queue. Per-agent prompt queues are FIFO, with a global execution cap. `agent.prompt` with `queue: true` appends without interrupting active work; the default `queue: false` supersedes waiting work and requests cancellation of active work before running its replacement. The replacement cannot start until the original ACP prompt settles. **Cancellation acknowledgment is ACP's completed prompt response, not merely notification delivery**. Active cancellation stays `running` until acknowledgment or process termination. Unresponsive cancellation kills the agent and marks it failed; queued replacements stop too. A running lifecycle mutation cannot be rolled back (`NOT_CANCELLABLE`); queue a subsequent stop if needed.

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

Categories: `server.ready/stopped`, `agent.created/state/modified/removed/session_replaced`, `agent.message/update/plan/compaction/error`, `tool.call/update/result`, `prompt.queued/started/cancelling/finished`, `prompt.steer_submitted/steer_pending/steer_delivered/steer_failed`, `operation.changed`, `permission.requested/resolved`, `plugin.error`. Steering lifecycle events share a `steeringId` and retain the prompt text; they represent distinct durable transitions. `agent.message` contains ACP message/thought chunks; tool results are ACP tool-call updates. All events have a durable monotonically increasing `seq`, including across server restarts. Agent events carry a process generation; replaced generations cannot update current state or complete newer work.

Subscriptions are **live-only**, not replay streams. A new connection subscribes to all events by default. For resynchronization, attach your listener first, query `organization.snapshot`, and discard buffered events at/before its sequence. `events.history` provides historical pages, `{events, oldestSeq, latestSeq, expired, hasMore}`. By default it returns the oldest events strictly after `after` (default 0). Supplying `before` selects the newest events strictly below that sequence, also respecting `after`; events are always returned in ascending sequence order. For a recent tail, use `before: snapshot.seq + 1`; for older pages, use the first returned sequence as the next `before`. `hasMore` indicates more matching events in the requested direction. Pages are also byte-bounded (at most 512 KiB, reduced for small client-output limits), including optional renderings, so a page can contain fewer than `limit` events. A single oversized record is sent as an explicitly truncated preview without changing the database; oversized renderings may be omitted. `expired=true` means the cursor precedes retained history: obtain a snapshot instead of assuming complete replay. Empty `types`/`agentIds` selects nothing. Exact and subtree live filters are supported. Slow clients exceeding their output-buffer limit are disconnected, never allowed to stall agent execution.

## MCP and hierarchy

The server issues a fresh per-generation capability to each harness. `src/mcp-bridge.ts` uses the MCP SDK's stdio transport and forwards tools to the socket; the caller identity comes from that capability, never model-supplied arguments. Capabilities expire when the generation stops/restarts.

Tools: `create_subagent`, `prompt_subagent`, `get_subagent`, `snapshot_organization`, `modify_subagent`, `stop_subagent`, `restart_subagent`, `restart_subagent_subtree`, `replace_subagent_session`, `remove_subagent`, `get_completion`, `get_operation`, `wait_operation`, `cancel_operation`. Pi exposes them as `mcp__agentorg__<name>`.

Agents create children **only under themselves**. `prompt_subagent` targets an immediate child; deeper work must relay root → child → grandchild. Neither direction permits skipping a level. Accepted downward work may enroll in the active caller turn's completion batch; only accepted work actually enrolled in the batch is considered for automatic result delivery, and unbatched work has no such guarantee. `prompt_subagent` callers normally need not wait for or poll the returned operation ID. Completion batches remain identified by `(parentAgentId, parentSessionId, rootOperationId)`. Agent snapshots expose only the caller's non-removed parent (if any) and direct non-removed children, excluding self; the response separates the optional `parent` summary from direct `subagents`, avoiding repeated relationship tags. Stopped/failed agents remain eligible. No parentId or operations are returned, and visibility does not grant parent inspection or lifecycle/operation authority. Lifecycle management continues to allow authorized descendants. Every authenticated agent-origin prompt is delivered as `@{issuer display name} {original prompt}`: core snapshots the issuer's display name and inserts one space before the byte-for-byte original body. This applies to direct `agent.prompt` and `prompt_subagent`. Send the intended body normally; do not manually add the mention. Client prompts stay unprefixed. The convention is descriptive text (ACP still uses user-role input), not system/developer authority or an authentication signal; capabilities remain authoritative. Prefer fire-and-return while waiting on child work to avoid prompt-slot dependency cycles. Local tokenless socket access remains trusted operator control.

This supports **fire-and-return** coordination: `prompt_subagent` returns an operation ID immediately, and callers normally need not wait for or poll that operation. Return from the current ACP turn instead of waiting; only accepted child work enrolled in that caller turn's completion batch is considered for automatic delivery. When the enrolled relevant work and nested batches settle, the server may enqueue one bounded continuation to the parent when it is idle and otherwise eligible. There is no automatic completion-batch delivery guarantee for unbatched work. Polling is optional, not the delivery mechanism. Use `get_completion` for recipient-only, budget-safe pages of batch/member metadata; metadata reports whether each original operation result remains available but does not contain result bodies. Use `get_operation` (optionally `resultOnly`) for authorized original operation results. Result shape is harness-dependent and may not contain `.text`. Trusted clients retain their organization-wide APIs; agents cannot inspect siblings' batches/results. Query responses and event/prompt data are bounded; retention can prune unpinned operations, and no automatic ledger-expiry promise is made.

Enrolled original operations are pinned against terminal-operation pruning while the logical batch is pending. Pinned completed operations consume the global `maxPendingCompletionOperations` cap (default 1024); lowering it does not cancel existing obligations. Pins release when delivery completes, is explicitly cancelled/superseded, or is suppressed/undeliverable. Explicit stop/removal, recipient failure, session replacement, or a prompt-budget impossibility can suppress delivery. Same-session restart and graceful shutdown can terminalize an in-flight ACP continuation as `interrupted`, preserve the logical batch ID/pins, then retry after recovery with a **new operation ID**. Completed delivery is not replayed; cancellation/supersession is not retried. A retry may repeat model-side effects after uncertain interruption; stable notification identity is not exactly-once model execution. Shutdown preserves eligible work; `--no-recover` suspends it until an explicit same-session restart.

Each tool returns an operation or query result as MCP text content; errors set `isError: true`. Creation operations must complete before using their resulting child IDs. Waiting inside a tool retains the parent prompt's global slot. Configure enough prompt slots for coordinators and workers (default 8); a saturated organization where every running agent waits on queued descendants can deadlock. Operation waits are bounded so agents can revise their coordination strategy.

Pi confirm/select dialogs become ACP permission requests. Clients choose with `permission.respond`; timeout/cancellation denies permission. Input/editor dialogs are cancelled because ACP permission options cannot represent arbitrary editor text. Pi built-in file/bash tools otherwise have Pi's normal trusted local access.

## Plugins

Trusted TypeScript modules export `ServerPlugin` with `apiVersion: 1`, `name`, and `setup(host)`; load explicit paths with repeatable `--plugin`. API types live in `src/plugin.ts`; incompatible versions and duplicate names fail startup. The generic extension APIs are additive within v1; plugins using the removed pre-1.0 feature-manager API must upgrade in this coordinated contract replacement. See [extension contract and commit boundaries](EXTENSIONS.md).

Snapshots advertise `capabilities.cwd` (server startup directory) and `capabilities.pathCompletion` for the client-only `organization.paths` query. Path discovery supports relative/absolute paths, `~/`, hidden entries when typing `.`, and directory symlinks; it returns absolute paths without bypassing workspace-policy validation. Queries are read-only unless `create: true` is explicitly supplied to recursively create the requested directory.

Harnesses may implement optional `listModels(context)` returning `{provider, id, name?}` entries. The host advertises those harnesses in `snapshot.capabilities.modelDiscovery` and exposes read-only `organization.providers`/`organization.models` queries (select a provider first). Discovery receives draft `cwd`, `env`, and `options`, is timeout-bounded, and returns only public model identifiers/display names. No harness is launched by core for discovery; legacy harnesses remain valid and clients can use manual entry.

Harnesses can report usage over ACP custom notification `_agentorg/usage` with `{version:1, sessionId, reportId, metrics}`. Accepted reports are durable for the organization database lifetime, deduplicated by `(agent, sessionId, reportId)`, and retained independently of bounded event history. Deduplication records accumulate; there is currently no report-pruning policy. Metric IDs are arbitrary namespaced IDs (for example `tokens.input` or `cost.usd`), with finite nonnegative numeric values; token metrics must be safe integers. Zero and unknown metrics are retained, while invalid/missing metric fields are omitted and empty reports ignored. Optional `HarnessPlugin.usageMetrics` and `PluginHost.registerUsageMetric` publish validated catalog descriptions; conflicting definitions fail registration. `usage.get` and MCP `usage_get` provide authorized `self` or `subtree` aggregates (including removed descendants), sparse raw metric totals, reporting counts, per-metric observation/contributor coverage, catalog entries, and optional bounded `metricIds` filtering. These are reported values only: core does not estimate missing usage or infer a model's cost/coverage. Client organization snapshots include per-agent `{usage:{self,subtree,reporting}}`; agent-scoped adjacent snapshots retain their existing shape. Plugins can use the same authorization-aware query through `PluginHost.queryUsage(query, caller)`. The Pi plugin and TUI may add harness-specific reporting and presentation separately.

Hooks register ACP harnesses, namespaced client endpoints/settings/capabilities, MCP tools, event observers, lifecycle transaction participants, settings/launch transformations, and shutdown handlers. Extension settings may expose an optional synchronous `snapshotMetadata` projector; it receives detached per-agent extension settings and must return only bounded, explicitly public JSON metadata (never credentials or raw opaque settings). `settings.extensions` round-trips plugin-owned JSON; supplied namespace values replace only that namespace, while omitted namespaces remain unchanged. `beforeMutation` may request atomic multi-record settings updates with compensation/finalization. `prepareLaunch` supplies env/MCP configuration before harness launch, and `validateLaunch` checks the final resolved spec. Unknown persisted extension/legacy data is retained but blocks launch/modification until its owning plugin is loaded. Discover optional features through `snapshot.capabilities.plugins`. `transformTool` augments an existing tool's schema/execution; `beforeSettings` validates/transforms create/modify settings inside the lifecycle queue before persistence or stopping a running agent. Launch specs default to the server cwd/environment (plus agent settings). Launch hooks can customize command/arguments, env, cwd, wrappers/containers, and bounded `gracefulStop`. `LaunchSpec.inheritEnv: false` opts out of ambient host/agent environment merging for isolated wrappers; plugin context env and core capability variables still apply. Container plugins can set `LaunchContext.executionEnvironment: "container"` before harness launch so commands resolve inside the image. A stop still closes stdin, escalates to SIGTERM/SIGKILL, and kills remaining members of the process group. See `examples/acp-plugin.ts`.

Observers run without blocking the transport; errors become `plugin.error`, and events emitted by observers are not re-observed recursively. Endpoint/tool failures are isolated per request. Launch failures fail only the affected agent/operation. Plugin setup failures fail startup; shutdown hooks have deadlines. **Plugins are trusted in-process code**, not fault/security sandboxes: a plugin that blocks the event loop, exits the process, or tampers with server state cannot be isolated.

### Pi plugin (separate repository)

Load `--plugin ../agentorg-plugin-pi-agent/src/index.ts` in source mode, or its built `dist/index.js` with the adjacent compiled `pi-acp` adapter in binary deployments. It uses the public `LaunchContext.mcpServers` specs, not core worker paths, and has no runtime imports from core. Existing `harness: "pi"` records and session directories are unchanged; load this plugin to restart/recover them. Without it, Pi is an unknown/unavailable harness (`INVALID_HARNESS` on creation, `START_FAILED` for restart operations), without deleting persisted data. See [installation and runtime overrides](../agentorg-plugin-pi-agent/README.md).

Harness-specific options, resource loading, credentials and session details belong to the separate harness plugin's documentation. Feature plugins own their policy, external storage, migration and readiness checks; core never interprets their namespaces.

### cwd plugin (separate repository)

Enable strict workspace nesting with the optional **`cwd`** plugin from [agentorg-plugin-unique-cwd](../agentorg-plugin-unique-cwd/README.md):

```sh
npm start -- --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-unique-cwd/src/index.ts
```

For compiled servers, build that repository and load `../agentorg-plugin-unique-cwd/dist/index.js`. The runtime plugin name (`cwd`) and persisted `settings.cwd` remain unchanged; replace the old `./src/plugins/cwd.ts` load path. Core does not enforce nesting without the plugin.

MCP `create_subagent` gains a **required top-level `cwd`** argument (use this instead of `settings.cwd`):

```json
{"name":"coder","cwd":"workers/coder","settings":{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna"}}
```

Directories must already exist. Relative child paths resolve from the **direct parent's cwd**; root paths resolve from the server cwd (omitting root cwd uses the server cwd). Real paths are resolved through symlinks: a child's cwd must be strictly inside its parent's, never equal or outside. The plugin sets the harness process/ACP session cwd and rechecks containment at every launch, including restart/recovery.

Agent `snapshot_organization` optionally accepts `path` to export a UTF-8 metadata report under the caller's explicit configured cwd; absolute destinations must also remain within that cwd. `~` and shell/environment syntax are not expanded. Existing regular files are atomically overwritten; parent directories must exist. Core rejects symlink components and protected data/socket destinations and writes a restrictive sibling temporary file before replacement. This baseline relies on a non-adversarial local filesystem: realpath/lstat checks are not race-safe against a hostile concurrent filesystem actor. Ordinary host-executed agents may export within this cwd; if a launch plugin marks execution as a container, core refuses a host-side write with `UNSUPPORTED` because no confined writer is integrated. This does not imply host agents are filesystem-isolated. The report uses the same `parent`/`subagents` grouping and selected records, with core identity/state/settings metadata and no events or operations. Its independent `core.maxSnapshotReportBytes` limit defaults to 16 MiB; inline response sizing remains separately bounded. Environment, arbitrary options/user metadata, and unprojected extension settings are omitted. Extension owners may register a synchronous `snapshotMetadata` projector to return explicitly public extension fields (for example configured directory grants or selected skill IDs); without one the extension is marked unavailable. UI `sensitive` hints are not export policy, and core cannot claim grants are effective. `includeTerminalOperations` is deprecated/no-op for agent snapshots. Client `agent.create`/`agent.modify` continue using **`settings.cwd`**; child creation requires it too. Modifications cannot move an agent outside its parent or invalidate existing, nonremoved children's containment. Canonical absolute cwd is persisted and included in agent info as **`settings.cwd`** (`agent.get`, `organization.snapshot`, creation/modification results), including for stopped agents.

This is launch-time workspace validation, **not a filesystem sandbox**. Agents still have ordinary shell/file access; filesystem changes after validation and other trusted plugins can undermine containment.

### Podman plugin (separate repository)

The optional [`@agentorg/plugin-podman`](../agentorg-plugin-podman/README.md) runs every agent in a separate rootless container, using inherited images and explicit `settings.extensions.podman.readOnlyDirs` / `readWriteDirs` grants. `cwd` must be explicitly mounted. Agent grants cannot exceed caller/direct-parent permissions; trusted clients can add external directories. MCP create/modify tools gain directory grant arrays, and the TUI offers image-change scopes (node only, inheriting descendants, all descendants).

Load Podman after other launch-transforming plugins. Images contain the harness and startup/MCP helpers; see its example Pi Containerfile/build script. The plugin mounts only explicit grants, the agent's private session directory, and a capability-scoped MCP relay—not the public organization socket or database. No host credentials/environment are implicitly copied. See its README for isolation boundaries and real-Podman tests.

### Synthetic harness benchmark (separate repository)

[`@agentorg/plugin-harness-bench`](../agentorg-plugin-harness-bench/README.md) provides a fake ACP harness and unattended experiment runner. It grows a real agent tree over MCP up to configured server capacity, then repeats seeded thought/text/tool activity through normal ACP and SQLite persistence. Runs retain data for resume, collect raw-client/latency/resource metrics, and allow the TUI to attach. No model credentials or automatic server-limit changes are required; larger limits are explicit startup configuration. Optional MCP subtree removal/regrowth varies parent agents, branching and depth under activity, with a headless TUI tree-render probe; leaf-only replacement remains available. See its README for workload controls and [reproducible SQLite recovery measurements](../agentorg-plugin-harness-bench/RECOVERY.md), including fresh-process versus OS-cache-cold caveats.

## Server-wide settings

Trusted clients can discover and edit public server configuration through
`organization.settings.list/get/update`. Core owns persistence, revisions,
authorization, reset-to-default behavior, and `organization.settings.changed`
events. Agents cannot call these endpoints, and no settings MCP tool exists.
Snapshots advertise portable descriptors under `capabilities.serverSettings`.
The initial `core` group exposes runtime limits; facts remain read-only. Plugins
can opt in later using `registerServerSettings` and `serverSettings`, independently
of per-agent `registerSettings`. Secrets are excluded.

Saved overrides beat startup/operator defaults and survive restart. Saves require
`expectedRevision`; resetting fields removes their overrides. Lists are replaced
as whole fields, so clients can explicitly delete entries. `maxLineBytes` requires
a server restart; other core limits apply at subsequent checks. Changes never
automatically restart agents. See [server settings API and plugin contract](SERVER_SETTINGS.md).

## Persistence, limits, and recovery

`limits.json` is a flat object of startup defaults (unknown keys/nonpositive values are rejected, except `maxEvents: 0` means unlimited). Persisted server-settings overrides take precedence; resetting a field restores its current startup default. Built-in defaults:

| Limit                                           |          Default |
| ----------------------------------------------- | ---------------: |
| `maxDepth` (root depth 0) / `maxChildren`       |           8 / 16 |
| `maxProcesses` / `maxPrompts`                   |           32 / 8 |
| `maxQueuedPrompts` per agent                    |              100 |
| `maxPendingCompletionOperations` (server-wide pinned completion members) | 1,024 |
| `maxPromptBytes` / `maxResponseBytes`           |  128 KiB / 1 MiB |
| `maxEvents` / retained terminal `maxOperations` | 0 (unlimited) / 10,000 |
| `maxAgents` (including historical records)      |           10,000 |
| `maxLineBytes` / `maxClientBufferBytes`         |    2 MiB / 4 MiB |
| `startTimeoutMs` / `cancelTimeoutMs`            |   30,000 / 5,000 |
| `stopTimeoutMs` / `killTimeoutMs`               |    5,000 / 1,000 |
| `maxWaitMs`                                     |           30,000 |

Oversized prompts/queues/trees/process counts are rejected. Oversized stored results/event data use `{truncated, originalBytes, preview}`; prompt text is additionally bounded during streaming. Large snapshots should use conservative record limits; output beyond a client's buffer cap disconnects that client. Events are retained indefinitely by default. `maxEvents` is a server setting editable under TUI **v → s → Organization / core**: 0 means unlimited, while a positive limit permanently prunes older events on subsequent writes. Existing explicit overrides remain in effect; reset or set `maxEvents` to 0 to disable them. Previously pruned history cannot be restored.

ACP `available_commands_update` notifications are optional and session-scoped. Client snapshots advertise `capabilities.agentCommands: { version: 1 }` and include current live lists in `agentCommands[agentId]`; each full replacement is also published as the sequenced `agent.commands` event. Lists are bounded, exclude opaque metadata, and disappear when that process/session ends. They are runtime state only: not stored in SQLite, agent records/settings, or agent-facing snapshot exports. Harnesses without ACP command updates continue to work normally. Terminal operations remain bounded independently; pruning never removes active operations or agent records. Pruned operations return `NOT_FOUND`. Pi session files and workspaces are retained indefinitely; external archival/deletion is an operator decision.

SQLite uses WAL and synchronous FULL writes; history is not erased by removal or session replacement. At startup, pending ordinary operations become stopped with `INTERRUPTED`; an in-flight completion continuation becomes terminal `interrupted` unless cancellation was already requested. Eligible same-session completion obligations retain pins and retry after recovery settles; graceful shutdown preserves them without launching new prompts. `--no-recover` suspends eligible obligations rather than suppressing them; an explicit same-session restart can reconsider them. Effective session replacement, explicit stop/removal, or permanent recipient failure marks work undeliverable and releases pins. Previously active agents restart parent-first by default. Recovery failures mark that agent failed and continue with descendants; already stopped/failed or removed agents are not automatically restarted. Abrupt process failure is contained to its agent, not descendants.

No authentication, multi-user protection, remote networking, default workspace-subdirectory enforcement, or filesystem sandbox is provided. Agents may read or modify files under the server `dataDir` (including `.org`) and the skills store/metadata through ordinary host filesystem access, even when these paths overlap or lie outside the workspace. Host path validation is not containment; these paths are not automatically granted or mounted. When isolation is required, the trusted container plugin's mount/grant enforcement is the filesystem boundary. The optional `cwd` plugin adds workspace-subdirectory validation, not sandboxing; the separate Podman plugin provides OS container filesystem isolation. Socket/database files are private to the OS user. Hierarchy permissions govern MCP calls; agents with ordinary shell access share that user's privileges and are not adversarially isolated from the public client socket. Workspace containment/isolation belongs in a trusted plugin.

## Tests

```sh
npm run check
npm test                     # deterministic ACP subprocess + MCP integration tests; no model calls
npm run test:binary
# Pi extension, adapter, offline loading and opt-in live tests:
# cd ../agentorg-plugin-pi-agent && npm test
```

The separate Pi plugin's `npm run test:live` needs working `openai-codex` credentials and uses only `gpt-6-luna`. It validates two child processes, their code/tests, ACP events, retained restart context, and session replacement. Model-backed demos/tests have no model fallback. Live agent behavior is inherently nondeterministic; failures include coordination diagnostics rather than silently switching models.
