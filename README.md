# Agent Organization Server

A single-user Bun/TypeScript service managing a tree of agent processes. Clients use JSONL over a Unix socket; harnesses use **ACP v1** (`@agentclientprotocol/sdk`); agents manage descendants using **MCP** (`@modelcontextprotocol/sdk`). SQLite persists agents, operations, and sequenced history.

The first harness is **Pi**. A server plugin starts an ACP adapter, which launches **`pi --mode rpc`**. A Pi extension registers the organization's real MCP stdio server. The core never speaks Pi RPC and can run other ACP harness plugins in the same tree.

## Run

Requires Unix, Bun, and Pi **1.0.2+** with MCP registration and `agent_settled` RPC support. Node 22.19+ is required by Pi. Tested with Bun 1.4.2 and Pi 1.0.2.

```sh
bun install --frozen-lockfile
# Install/configure pi separately if it is not already on PATH.
# Authenticate with your model provider using pi /login.
bun start                         # .org/server.sock and .org/organization.sqlite
# Optional:
bun start --data-dir /tmp/my-org --recover --config limits.json --plugin ./my-plugin.ts
```

`--recover` restarts previously active agents, parent before child; default recovery stops them. Graceful server shutdown uses SIGINT/SIGTERM. A deployment lock prevents multiple servers sharing a database. Only an owned, stale socket inside the data directory is automatically removed. If placing the socket elsewhere, remove a stale socket yourself after verifying no server is running.

### Live demonstration

Start a **fresh organization** (only one active root is permitted), then:

```sh
bun demo .org/server.sock /tmp/org-demo-workspace
```

The client creates a Pi root using **`openai-codex/gpt-6-luna`**, subscribes to events, and asks it to create two Pi children: a coder writes `add.ts`; a tester writes `add.test.ts`. The root sends both tasks, waits for their operations, runs the tests, and reports the result. JSONL lifecycle, message, tool, and operation events stream to stdout. Agents and files remain available afterward.

## Client API

See [`client_spec.md`](client_spec.md) for the complete client implementation contract, schemas, event payloads, reconnect procedure, and current limitations.

Every record ends with LF. Literal Unicode line/paragraph separators are supported. IDs correlate responses; events may precede responses and concurrent requests may finish out of order.

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

Trusted TypeScript modules export `ServerPlugin` with `apiVersion: 1`, `name`, and `setup(host)`; load explicit paths with repeatable `--plugin`. API types live in `src/plugin.ts`; incompatible versions and duplicate names fail startup. v1 changes will be additive; breaking changes require a new version.

Hooks register ACP harnesses, namespaced client endpoints, MCP tools, event observers, settings/launch transformations, and shutdown handlers. `transformTool` augments an existing tool's schema/execution; `beforeSettings` validates/transforms create/modify settings inside the lifecycle queue before persistence or stopping a running agent. Launch specs default to the server cwd/environment (plus agent settings). Launch hooks can customize command/arguments, env, cwd, wrappers/containers, and bounded `gracefulStop`. A stop still closes stdin, escalates to SIGTERM/SIGKILL, and kills remaining members of the process group. See `examples/acp-plugin.ts`.

Observers run without blocking the transport; errors become `plugin.error`, and events emitted by observers are not re-observed recursively. Endpoint/tool failures are isolated per request. Launch failures fail only the affected agent/operation. Plugin setup failures fail startup; shutdown hooks have deadlines. **Plugins are trusted in-process code**, not fault/security sandboxes: a plugin that blocks the event loop, exits the process, or tampers with server state cannot be isolated.

Pi launch options: `thinking`, `appendSystemPrompt`, `tools` (built-in allowlist), `executable` (default `pi`). Models must be exact Pi model IDs, not fuzzy patterns; the adapter verifies the selected model/provider and refuses fallback. Pi sessions are stored in `.org/sessions/<agentId>/<sessionNumber>/`; restart reopens the session, replacement writes a separate session directory. The extension loads explicitly alongside Pi's built-in MCP extension. Discovered extensions/skills/templates/themes and project-local configuration are disabled; user-level MCP settings and credentials remain Pi-managed. Reserve the MCP server name `organization` for this extension.

### cwd plugin

Enable strict workspace nesting with the optional **`cwd`** plugin:

```sh
bun start --plugin ./src/plugins/cwd.ts
```

MCP `child_create` gains a **required top-level `cwd`** argument (use this instead of `settings.cwd`):

```json
{"name":"coder","cwd":"workers/coder","settings":{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna"}}
```

Directories must already exist. Relative child paths resolve from the **direct parent's cwd**; root paths resolve from the server cwd (omitting root cwd uses the server cwd). Real paths are resolved through symlinks: a child's cwd must be strictly inside its parent's, never equal or outside. The plugin sets the harness process/ACP session cwd and rechecks containment at every launch, including restart/recovery.

Client `agent.create`/`agent.modify` continue using **`settings.cwd`**; child creation requires it too. Modifications cannot move an agent outside its parent or invalidate existing, nonremoved children's containment. Canonical absolute cwd is persisted and included in agent info as **`settings.cwd`** (`agent.get`, `organization.snapshot`, creation/modification results), including for stopped agents.

This is launch-time workspace validation, **not a filesystem sandbox**. Agents still have ordinary shell/file access; filesystem changes after validation and other trusted plugins can undermine containment.

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

SQLite uses WAL and synchronous FULL writes; history is not erased by removal or session replacement. At startup, all pending operations become `stopped` with `INTERRUPTED`, never resumed. Previously active agents become stopped unless `--recover` is selected. Recovery failures mark that agent failed and continue with descendants; already stopped/failed or removed agents are not automatically restarted. Abrupt process failure is contained to its agent, not descendants.

No authentication, multi-user protection, remote networking, default workspace-subdirectory enforcement, or filesystem sandbox is provided. The optional `cwd` plugin adds workspace-subdirectory validation, not sandboxing. Socket/database files are private to the OS user. Hierarchy permissions govern MCP calls; agents with ordinary shell access share that user's privileges and are not adversarially isolated from the public client socket. Workspace containment/isolation belongs in a trusted plugin.

## Tests

```sh
bun run check                # includes the Pi extension's types
bun test                     # deterministic ACP subprocess + MCP integration tests; no model calls
bun run test:live            # opt-in real Pi/MCP delegation; uses ONLY gpt-6-luna
```

Live testing needs working `openai-codex` credentials. It validates two child processes, their code/tests, ACP events, retained restart context, and session replacement. Model-backed demos/tests have no model fallback. Live agent behavior is inherently nondeterministic; failures include coordination diagnostics rather than silently switching models.
