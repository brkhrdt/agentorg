# Client Integration Specification

## 1. Scope and compatibility

This document specifies the **currently implemented** public client API for the Agent Organization Server (project version `0.1.0`). It is intended to let a client be implemented in any language without importing the server's code.

The client talks to the organization server, **not directly to Pi, ACP, or MCP**. ACP is the server-to-harness protocol; MCP is the agent-to-organization tool interface. Some public events carry ACP `SessionUpdate` payloads, described below.

There is currently no protocol-version handshake, standalone capability-discovery endpoint, model-list endpoint, or harness-list endpoint. Current snapshots include optional `capabilities.skills`; older servers omit it. Configure the socket path and available harness/model choices through deployment configuration. There are no built-in harnesses. The separate `@agentorg/plugin-pi-agent` registers `pi` when explicitly loaded; other names depend on loaded plugins. Missing harness plugins fail creation with `INVALID_HARNESS` and restart operations with `START_FAILED` (unknown harness), without deleting records/sessions. Plugin API version `1` is not a client wire-protocol version.

Source references:

- [`src/server.ts`](src/server.ts): socket transport, envelopes, subscriptions.
- [`src/organization.ts`](src/organization.ts): endpoints, operations, lifecycle, event emission.
- [`src/types.ts`](src/types.ts): records, errors, limits, truncation.
- [`src/store.ts`](src/store.ts): history and retention.
- [`src/client.ts`](src/client.ts): existing TypeScript reference client.

Where this document identifies a limitation, clients must accommodate it rather than assume an unimplemented endpoint or guarantee.

## 2. Transport

### 2.1 Connection

Connect to a Unix domain **stream** socket. The default is `.org/server.sock`, relative to the directory in which the server was launched. The deployment can override it. Clients should resolve/configure an absolute path rather than assume their working directory matches the server's.

The socket is created with mode `0600`. Ordinary clients need access as the server's OS user. There is no public-client authentication handshake, TLS, TCP listener, HTTP endpoint, or WebSocket endpoint. A browser client needs a separately implemented local proxy; the server does not supply one.

A connection is immediately subscribed to all live events. There is no welcome record. The socket can become connectable before startup/recovery finishes: requests then fail with `NOT_READY`. Retry a safe readiness probe such as `organization.snapshot` with backoff; do not depend on receiving `server.ready`, which may have occurred before connection.

Disconnecting a client **does not stop agents or cancel accepted work**. Closing a connection just discards that connection's subscriptions and pending responses.

### 2.2 JSONL framing

Each request, response, or event is one UTF-8 JSON object terminated by byte `0x0A` (LF).

Client requirements:

1. Serialize a complete JSON object and append LF. Embedded newlines in strings must be JSON-escaped.
2. Treat the socket as a byte stream: one read can contain part of a record, many records, or both.
3. Buffer until LF; strip a single preceding CR to accept CRLF.
4. Decode UTF-8 without corrupting multibyte characters split across reads. Splitting bytes on LF before decoding each complete line is suitable.
5. Do **not** split on Unicode U+2028/U+2029; they are legal inside JSON strings. Avoid general-purpose line readers that recognize these separators.
6. Read continuously, including while waiting for a response or operation. Dispatch responses and events independently.
7. Serialize concurrent writes so bytes from separate JSON records cannot interleave. Honor socket write backpressure.

Empty lines are ignored. Whitespace-only lines are not empty and fail JSON parsing. A final record without LF is not processed before EOF.

The default incoming-record limit is **2 MiB** (`maxLineBytes`). Exceeding it produces a best-effort `FRAME_TOO_LARGE` response with `id: null`, followed by connection closure. Do not rely on receiving that error before EOF.

The server disconnects clients whose pending outgoing bytes, including the next record, exceed `maxClientBufferBytes` (default **4 MiB**). This also applies to a single oversized response. The incoming-request limit is not an outgoing-response-size guarantee. Set a separate defensive receive limit; the reference client uses 16 MiB.

## 3. Wire envelopes

### 3.1 Request

```ts
type RequestId = string | number;

interface Request {
  id: RequestId;
  method: string;
  params?: unknown; // Usually an object; omission/null is treated as {}.
}
```

Example:

```json
{"id":"req-1","method":"organization.snapshot","params":{}}
```

Use unique string IDs, preferably UUIDs or connection-local counters encoded as strings. Numeric IDs are accepted, but string IDs avoid cross-language number precision issues. IDs are echoed with their original JSON type.

- Requests without IDs are unsupported; these are not JSON-RPC notifications.
- The envelope is **not JSON-RPC 2.0**: do not send `jsonrpc` or other undeclared envelope fields.
- Unknown envelope fields are rejected.
- IDs correlate responses only. They are **not idempotency keys** and are not stored on operations.
- The server processes requests concurrently. Responses need not follow request order.
- At most **128 requests per connection** may be in flight. An excess request receives `LIMIT`; its response may have `id: null` because this check occurs before parsing its ID.

An internal optional `token` envelope field exists for server-issued agent capabilities. **Public clients must omit it.** It is not a user-authentication token. Using one changes the connection into agent-internal mode, applies hierarchy restrictions, and suppresses its event stream. The server does not expose a public method to obtain these capabilities.

### 3.2 Success response

```ts
interface SuccessResponse {
  kind: "response";
  id: RequestId;
  ok: true;
  result?: unknown;
}
```

```json
{"kind":"response","id":"req-1","ok":true,"result":{"seq":42,"agents":[],"operations":[]}}
```

Built-in successful endpoints return the documented `result`. A plugin returning `undefined` can cause the field to be omitted.

### 3.3 Error response

```ts
interface ApiError {
  code: string;
  message: string;
}

interface ErrorResponse {
  kind: "response";
  id: RequestId | null;
  ok: false;
  error: ApiError;
}
```

```json
{"kind":"response","id":"req-2","ok":false,"error":{"code":"NOT_FOUND","message":"Operation not found"}}
```

`id: null` means the request could not be correlated. Preserve it as a connection/protocol diagnostic, not as a response to an arbitrary pending request.

### 3.4 Event

```ts
interface ServerEvent {
  kind: "event";
  seq: number;
  time: string;       // ISO 8601 UTC timestamp.
  type: string;
  agentId?: string;
  generation?: string;
  data: unknown;
}
```

```json
{"kind":"event","seq":43,"time":"2026-10-08T06:00:00.000Z","type":"prompt.started","agentId":"agent-1","generation":"generation-1","data":{"operationId":"op-1"}}
```

Events have no request ID. They can arrive **before the response** to the request that caused them. All clients observe one server-wide sequence; subscription filters naturally cause gaps. A gap on a filtered stream is not proof of lost delivery.

Sequences are durable and monotonically increasing across restarts using the same database. They are not meaningful across a newly created/replaced database, and the API has no server-instance/database identifier. If a reconnect yields a lower sequence than the client's stored cursor, discard that cursor and perform a fresh snapshot/resync.

Unknown event names and additional fields must not crash the client. Plugins can add event types. Do not infer operation completion from an unknown event.

## 4. Shared records

### 4.1 Agent settings

```ts
interface AgentSettings {
  harness: string;                 // Required, nonempty on creation.
  model: string;                   // Required, nonempty on creation.
  provider?: string;
  cwd?: string;
  env?: Record<string, string>;
  options: Record<string, unknown>; // Defaults to {} on creation.
  skills?: Record<string, 'unavailable' | 'available' | 'installed'>; // Optional skills plugin selection.
}
```

Request settings objects reject unknown top-level properties. `options` and `env` are the extension points for harness-specific configuration and process environment.

- With no `cwd`, creation uses the **server's** current working directory, not the client's or parent's.
- Relative working directories resolve against the server's current working directory. Prefer absolute paths.
- `cwd` must already be usable by the harness; creation does not create a workspace directory for the client.
- The default environment is the server's environment plus `settings.env`; plugins may alter it.
- Children do not automatically inherit their parent's harness, model, working directory, or options. Send the intended settings explicitly.
- Socket snapshots/events can contain settings and environment values. Treat received/logged data as potentially sensitive.

With the separate Pi plugin loaded, for `harness: "pi"`, `model` must be an **exact Pi model ID**, with `provider` specified separately when desired. Fuzzy patterns/provider-prefixed IDs are not the adapter's supported setting format: startup verifies that Pi selected the exact requested ID/provider and fails rather than falling back.

Pi `options` accepts only:

| Property | Type | Default / meaning |
|---|---|---|
| `thinking` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Omitted: Pi's configured default/capability handling |
| `appendSystemPrompt` | string | Additional system-prompt text or path, following Pi CLI behavior |
| `tools` | string[] | Passed to Pi's `--tools` option |
| `executable` | nonempty string | `"pi"`; server-side executable lookup/path |

Example settings used by the live demo/tests:

```json
{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna","cwd":"/tmp/my-project","options":{"thinking":"low"}}
```

### 4.2 Agent record

```ts
type AgentState =
  | "starting" | "running" | "idle" | "waiting"
  | "recovering" | "stopped" | "failed";

interface AgentRecord {
  id: string;
  parentId: string | null;
  name: string;
  metadata: Record<string, unknown>;
  settings: AgentSettings;
  state: AgentState;
  revision: number;
  generation: string | null;
  sessionId: string;
  sessionNumber: number;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
```

IDs are opaque strings; use returned IDs rather than constructing them. The server currently generates UUIDs.

| Field/state | Interpretation |
|---|---|
| `parentId: null` | Organization root |
| `removedAt !== null` | Historical/removed agent; hide from the active tree, but retain in history views |
| `starting` | Process/ACP session startup in progress |
| `idle` | Started process, no active/queued prompt work |
| `running` | Prompt execution active, including while cancellation is pending |
| `waiting` | Work queued for a prompt slot, or active work waiting for permission; the state alone does not identify which |
| `recovering` | Restart policy is recovering a previously active agent after server restart |
| `stopped` | No active process; explicit restart/replacement required |
| `failed` | Process/startup/cancellation failure; explicit restart/replacement required |
| `generation` | Identifier for this process start; null when no current generation |
| `sessionId` | Harness's current session identifier; distinct from process generation |
| `sessionNumber` | Organization's retained session-directory number, initially 1 |
| `revision` | Settings/metadata revision, initially 1; not a state/event counter |

State changes do not increment `revision`. `agent.modify` increments it on success, even for an effectively unchanged patch; removal and session replacement increment it too. Ordinary restart does not. Changing harness also creates a new session number/ID.

Do not treat `agent.created`, `agent.modified`, or a `starting` state as proof the process is ready. Startup may fail after the record has been saved. Query `agent.get` after successful startup/restart if you need the final harness session ID; state events do not contain the full updated record.

Prompt/provider errors can fail an operation while leaving the process `idle`, ready for another prompt. Tool failures do not necessarily fail the enclosing prompt: the agent may handle them and continue.

### 4.3 Operation

```ts
type OperationStatus = "queued" | "running" | "completed" | "failed" | "stopped";
type Caller = { kind: "client" | "agent" | "server"; id: string };

interface Operation {
  id: string;
  caller: Caller;
  agentId: string | null;
  type: string;            // Built-ins use their request method name.
  status: OperationStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: ApiError;
  cancelRequested?: boolean;
  input: unknown;          // Normalized submitted parameters, including defaults.
}
```

Terminal statuses are `completed`, `failed`, and `stopped`. A cancelled queued operation may never have `startedAt`. A stopped operation may or may not have an `error`; absence of an error does not make it successful.

`caller.id` for public clients is generated per connection and changes after reconnect. It is diagnostic attribution, not a durable client identity or permission boundary. Public clients can inspect/manage any retained operation regardless of originating connection.

Creation is special: `agentId` initially refers to the parent, or is null for a root creation. When the new agent record is allocated, the operation's target becomes the new agent ID. On successful creation, `result` is that agent record. If allocation never happens, failure can leave the parent/null target; do not mistake it for a newly created agent.

Lifecycle successes (`agent.create/modify/stop/restart/restart_subtree/replace_session/remove`) normally return an `AgentRecord` as the terminal operation's `result`. Subtree methods return the selected top agent, **not a list of all descendants**; take a snapshot to inspect the entire affected subtree.

Successful prompt results normally have this form:

```ts
interface PromptResult {
  text?: string;
  truncated?: boolean;
  stopReason?: string; // ACP stop reason; field can be absent on error/termination.
}
```

`text` accumulates assistant text chunks across the prompt's turns. It is not necessarily just the last assistant message. Thinking/tool output is not appended to this field. If no text was emitted, `text` may be absent. Pi currently maps normal completion to `end_turn`, token-limit completion to `max_tokens`, and abort/cancellation to `cancelled`.

`completed` means the harness prompt returned successfully, not that the requested task/tests necessarily succeeded. Inspect the text, tool results, and application-specific output for semantic success.

During a running prompt, `operation.get` can expose the current partial accumulated text. `operation.changed` is not emitted for every text chunk; stream message events for live rendering.

### 4.4 Truncation

Operation results and individual event `data` payloads are subject to `maxResponseBytes`. An oversized value is replaced by:

```ts
interface TruncatedValue {
  truncated: true;
  originalBytes: number;
  preview: string; // A prefix of serialized JSON, NOT guaranteed valid JSON.
}
```

Recognize this by `originalBytes` and `preview`, not merely `truncated: true`: a normal `PromptResult` can also have `truncated: true` while retaining usable `text`.

Never parse `preview` as a complete record. Show it as incomplete data. For a truncated agent lifecycle result, retrieve the agent with `agent.get` when the operation's target is known. For a truncated event, query current agent/operation state or resync; there is no endpoint that restores the full discarded event payload. A truncated `operation.changed` payload may lack its operation ID entirely.

Prompt accumulation has an additional streaming text cap. A later terminal operation result may itself be replaced by `TruncatedValue` if its serialized JSON exceeds the result cap. No global result cap is applied to aggregate snapshot/history response envelopes: even individually bounded items can produce a response large enough to disconnect the client.

## 5. Endpoints

Unless stated otherwise, send an object containing only the listed properties. Many parameter schemas reject unknown properties. Do not rely on extra fields being ignored by endpoints that currently happen to ignore them. Optional fields must be omitted rather than set to null, unless null is explicitly permitted.

### 5.1 `organization.snapshot`

Parameters: `{}`.

Result:

```ts
interface OrganizationSnapshot {
  seq: number;
  agents: AgentRecord[];
  operations: Operation[];
  capabilities?: { skills: boolean };
}
```

Includes active **and removed** agent records and all retained operations, including operations initiated by agents. Arrays have no public ordering guarantee; construct maps keyed by ID, and a tree using `parentId`.

This is a synchronous snapshot of the server's current in-memory view and sequence. It can represent an intermediate stage of a lifecycle operation; it is not a promise that all mutations have settled. It does not include a live permission-request list or a transcript.

There are no snapshot pagination/filter parameters for public clients. Large organizations may need deployment buffer-limit changes before the snapshot fits.

### 5.2 `agent.get`

Parameters: `{agentId: string}`.

Result: `AgentRecord`, including removed agents. Unknown IDs return `NOT_FOUND`. A client that knows an agent ID can use this as a smaller alternative to refreshing a full snapshot.

### 5.3 `agent.create`

Parameters:

```ts
interface CreateAgentParams {
  parentId?: string | null; // Default null.
  name?: string;           // Default "agent"; length 1–256.
  metadata?: Record<string, unknown>; // Default {}.
  settings: {
    harness: string;
    model: string;
    provider?: string;
    cwd?: string;
    env?: Record<string, string>;
    options?: Record<string, unknown>;
    skills?: Record<string, 'unavailable' | 'available' | 'installed'>;
  };
}
```

Result: an `Operation` accepted for creation. Wait for it to reach a terminal state. Parameter-schema failures are request errors; hierarchy/harness/limit/startup failures may occur later as operation failures.

Rules:

- A null/omitted `parentId` creates the root; only one **unremoved** root may exist. A stopped/failed root still occupies that role.
- A non-null parent must refer to an unremoved agent. A stopped parent may still have/create active children.
- Creation enforces depth, child-count, agent-record, and process-count limits.
- Startup failure after allocation leaves an agent record in `failed`, not silently deleted. Use restart, modify, or remove to manage it.
- A public client can create under any unremoved parent. Agent MCP callers have stricter direct-child permissions, described in §11.

A valid creation response does not mean the agent is already running. Obtain the ID from the completed operation's `result.id`; if the result was truncated, use the operation's updated `agentId` and `agent.get` after verifying success.

### 5.4 `agent.modify`

Parameters:

```ts
interface ModifyAgentParams {
  agentId: string;
  expectedRevision?: number; // Integer; normally the last observed revision.
  name?: string;            // Length 1–256.
  metadata?: Record<string, unknown>;
  settings?: Partial<AgentSettings>;
}
```

Result: an `Operation`. Terminal success result: updated `AgentRecord`.

The optional revision check happens **when the serialized mutation executes**, not when the request is accepted. A mismatch fails the operation with `CONFLICT`. Refresh the agent, resolve the conflicting edit, and submit another mutation; do not silently overwrite.

Patch behavior:

- Omitted top-level fields preserve existing values. Omitting `settings` entirely preserves all settings.
- `metadata` replaces the entire metadata object.
- `settings` shallow-merges with existing settings. Within it, `env` and `options` replace their entire corresponding objects; they do not deep-merge.
- Omitted settings keys, including `options` and `skills`, preserve their existing values. Older server builds cleared omitted `options` during patches; upgrade before using skill-only patches.
- Changing `cwd`, `env`, model/provider, harness, options, or the target skill selection counts as a launch-settings change.
- Launch-settings changes stop and restart a currently active agent, cancelling its prompt work; descendants are unaffected.
- Name/metadata-only changes do not restart its process.
- Modifying a stopped/failed agent does not start it. Follow with an explicit restart when ready.
- Changing harness creates a fresh session ID/number. Other restarts attempt to retain context according to harness support.
- Restart failure does not roll back saved settings. Query the record to show its new settings and failed state.

There is no dedicated unset operation for optional scalar settings such as `provider`: null is rejected, and omission preserves the old value. `{env:{}}` or `{options:{}}` clears those maps at the settings level; the default server environment still applies. This is a current API limitation.

### 5.5 Lifecycle methods

All accept exactly `{agentId: string}`, return an `Operation`, and normally return the selected `AgentRecord` on terminal success.

| Method | Effect |
|---|---|
| `agent.stop` | Stops only this agent and its prompt work. Descendants remain active. |
| `agent.restart` | Stops then starts only this agent with current settings. Descendants remain active. Attempts session loading when supported. |
| `agent.restart_subtree` | Stops the selected agent and all unremoved descendants, child-first; starts them parent-first. All selected subtree agents are restarted, including ones previously stopped/failed. Startup failures do not prevent attempts for other descendants. |
| `agent.replace_session` | Stops only this agent; increments session number/revision, allocates a fresh conversation session, then starts it. Descendants are unaffected; previous transcripts remain on disk. |
| `agent.remove` | Stops the selected agent and its unremoved subtree, then archives those records with `removedAt`. Workspace/session files are not deleted. |

Additional rules:

- Removed agents remain queryable but cannot be modified, restarted, prompted, or restored using a built-in endpoint.
- Stopping a root does not make another root creatable; removing it does.
- A successful ordinary restart preserves Pi context/session ID. Other harnesses without session-loading support start a new context even when asked to restart.
- A subtree restart can partially succeed but end with a `failed` operation and `START_FAILED` containing affected IDs/errors. There is no rollback; inspect each descendant's record.
- Shutdown first closes process stdin, waits up to the graceful timeout, then sends SIGTERM and, if needed, SIGKILL. Plugins can customize graceful shutdown. A forceful stop can still complete the requested lifecycle operation successfully.

Lifecycle mutations share an organization-wide serialized queue. Operations for different agents can therefore wait behind another agent's slow startup/shutdown. Await the relevant operation's completion where ordering depends on effects, such as creating an agent before prompting it. Request acceptance alone is insufficient.

### 5.6 `agent.prompt`

Parameters:

```ts
interface PromptAgentParams {
  agentId: string;
  text: string;    // Nonempty, UTF-8 byte size bounded.
  queue?: boolean; // Default false.
}
```

Result: an `Operation`. Schema/size/availability failures can return a direct request error without allocating a prompt operation.

`queue: false` (default):

1. Cancel all of that agent's queued prompts, which become `stopped` with `SUPERSEDED`.
2. If a prompt is active, request its cancellation.
3. Place the new prompt behind the still-active cancellation; it cannot execute on that agent until active work ends or its process stops.

`queue: true`: append FIFO without superseding active/queued work. At most one prompt runs per agent. A configurable organization-wide limit bounds active prompts.

The agent must have a started, available process. Stopped/failed agents are not automatically started; use restart first. There is no image/file-attachment field in the public prompt schema. The Pi adapter supports text only.

Prompt enqueueing is serialized with lifecycle mutations, so request acceptance can wait behind a startup/shutdown even though actual model execution does **not** hold the lifecycle queue. A newly accepted operation may already have advanced to `running` before the client sees its response. Subsequent event/operation queries are authoritative for current status.

A cancellation timeout terminates the process and marks the agent failed. All of its queued prompts, including a replacement prompt, then become stopped; restart the agent before submitting more work.

### 5.7 `operation.get`

Parameters: `{operationId: string}`.

Result: current `Operation`. Does not wait. The implementation also accepts a nonnegative integer `waitMs` here, but ignores it; omit it.

`NOT_FOUND` means an unknown or pruned operation, not necessarily that no work ever happened.

### 5.8 `operation.wait`

Parameters: `{operationId: string, waitMs?: number}`; `waitMs` is a nonnegative integer.

Result: current `Operation` after it reaches a terminal state or the wait expires, whichever occurs first.

- Default wait: **1,000 ms**.
- Maximum wait: `maxWaitMs`, default **30,000 ms**; larger requested waits are clamped.
- `waitMs: 0` behaves as an immediate/best-effort query.
- Waiting on an already terminal operation returns immediately.
- A nonterminal result is normal, not a timeout error.
- Expiry of this wait does **not** cancel server work.

Repeat waits until terminal status, with a separate client-side overall deadline. Set the network request deadline longer than the requested server wait plus transport slack.

### 5.9 `operation.cancel`

Parameters: `{operationId: string}`.

Result: current `Operation`, which is not necessarily terminal.

| Existing state/type | Behavior |
|---|---|
| Terminal operation | Returns unchanged; no further effect |
| Queued lifecycle operation | Stops it without executing it; cancellation can bypass the currently running mutation |
| Running lifecycle operation | Direct `NOT_CANCELLABLE` error; cannot roll back a mutation already executing |
| Queued prompt | Removes it from the FIFO and stops it |
| Active prompt | Sets `cancelRequested: true`, sends ACP cancellation, normally returns while status remains `running` |

For an active prompt, display **cancelling**, not stopped, until an operation query/event reports a terminal status. Sending the ACP notification alone is not confirmation: the active prompt remains in progress until its response completes or the process terminates. Final stream/tool updates can arrive after cancellation was requested.

To stop an agent involved in a running lifecycle operation, submit `agent.stop`; it waits its turn in the mutation queue. Do not resubmit a cancelled prompt automatically without checking process state and the application's intent.

### 5.10 `subscribe`

Parameters:

```ts
interface SubscribeParams {
  enabled?: boolean;       // Default true.
  types?: string[];        // Omitted means all types.
  excludeTypes?: string[]; // Default [].
  agentIds?: string[];     // Omitted means all agents/server-wide events.
  subtrees?: boolean;      // Default false.
}
```

Result: `{liveOnly: true, seq: number}`. `seq` is the current global event sequence when the filter was installed; it is not a replay cursor acknowledgment.

Each request **replaces the full filter**, not a patch. Its defaults apply to fields omitted from that request.

An event matches only if all applicable conditions hold:

1. `enabled` is true.
2. If `types` is supplied, its exact event type appears in the list.
3. Its exact event type does not appear in `excludeTypes` (exclusions win).
4. If `agentIds` is supplied, its `agentId` is an exact selected ID, or, with `subtrees: true`, a descendant of a selected ID. Selected agents themselves are included.

Type names do not support wildcards/prefix matching. An empty `types` or `agentIds` list matches nothing. Filtering by agent IDs excludes events without an agent ID, including server-wide events and the earliest root-creation operation events before a target ID exists. Therefore, keep an unfiltered control stream or query operations to avoid losing important status updates.

Examples:

```json
{"id":"sub-1","method":"subscribe","params":{"excludeTypes":["tool.update","agent.update"]}}
{"id":"sub-2","method":"subscribe","params":{"agentIds":["root-id"],"subtrees":true}}
{"id":"sub-3","method":"subscribe","params":{"enabled":false}}
{"id":"sub-4","method":"subscribe","params":{}}
```

Subscriptions are connection-local, **live-only**, and disappear on disconnect. Filters do not affect direct query responses or `events.history`. The subscribe response is interleaved with events; buffering must already be active when setting a filter.

### 5.11 `events.history`

Parameters:

```ts
interface HistoryParams {
  after?: number;   // Nonnegative integer sequence; default 0, exclusive.
  limit?: number;   // Integer 1–1000; default 100.
  agentId?: string; // Exact agent ID only; no subtree expansion.
}
```

Result:

```ts
interface HistoryPage {
  events: ServerEvent[]; // Ascending sequence.
  oldestSeq: number;    // Oldest retained global event, not filter-specific.
  latestSeq: number;    // Current global sequence, not necessarily this page's last item.
  expired: boolean;     // after < oldestSeq - 1.
}
```

The query selects retained events with `seq > after`; if supplied, `agentId` is an exact-match filter. There are no type/exclusion/subtree filter parameters here: apply such filtering locally, or query each desired exact agent separately.

Pagination:

- Continue with `after = last returned event.seq`, not `latestSeq`, while retrieving older pages.
- An empty filtered page can occur even when `latestSeq > after`; no retained events matched that exact agent.
- `expired: true` means global retained history has a gap before the requested cursor. Returned events can still be useful, but do not claim a complete replay. Resnapshot current state.
- A cursor beyond `latestSeq` currently yields no events rather than an error. Treat a lower new snapshot sequence as database replacement, not a valid continuation.
- There is no fixed snapshot token/upper-bound parameter for pagination. Capture an upper sequence locally if you need to finish replay at a fixed point; new events can appear between pages and old ones can expire.

Historical queries do not replay into the live subscription. Clients must merge/deduplicate history and live events by `seq` themselves.

### 5.12 `permission.respond`

Parameters:

```ts
interface PermissionResponseParams {
  permissionId: string;
  optionId?: string;
  cancelled?: boolean;
}
```

Choose one of the offered opaque option IDs:

```json
{"id":"allow-1","method":"permission.respond","params":{"permissionId":"permission-1","optionId":"allow-option"}}
```

Or cancel:

```json
{"id":"deny-1","method":"permission.respond","params":{"permissionId":"permission-1","cancelled":true}}
```

Result: `{accepted: true}`. With `cancelled: true`, `optionId` is ignored. Otherwise a currently offered option ID is required; invalid choices return `INVALID_PARAMS`. A resolved/expired permission returns `NOT_FOUND`.

The server emits `permission.resolved` when it resolves the request. Resolution may occur because of a client response, timeout, prompt completion/cancellation, or process stop. Any public client can respond; handle a second client's resolution and dismiss the dialog. Disconnecting the requesting/displaying client alone does not resolve it.

## 6. Event payload reference

All `data` shapes below are subject to §4.4 truncation. Optional fields with undefined values are omitted from JSON. Events describing agents are not always tagged with `generation`; never require that field globally.

| Type | `data` | Notes |
|---|---|---|
| `server.ready` | `{recover: boolean, limits: Limits}` | Startup-only event, not a greeting; `recover` defaults false |
| `server.stopped` | `{}` | Graceful shutdown; may be followed by EOF, not guaranteed on crash |
| `agent.created` | `AgentRecord` | Record allocated, process not necessarily ready; envelope generation omitted |
| `agent.state` | `{state: AgentState, revision: number, error?: string}` | Current generation in envelope while set; cleared generation is represented by omission |
| `agent.modified` | `AgentRecord` | Saved modification; process restart may still be pending; envelope generation omitted |
| `agent.removed` | `{removedAt: string}` | Agent has been stopped and archived; envelope generation omitted |
| `agent.session_replaced` | `{sessionNumber: number}` | Query the record for its new ID/revision/final startup state |
| `agent.error` | Error-dependent object | Prompt errors usually `{operationId, code, message}`; process failures can be `{message}` |
| `prompt.queued` | `{operationId: string, text: string}` | Captures submitted text and process generation |
| `prompt.started` | `{operationId: string}` | Associate following stream chunks with this active operation |
| `prompt.cancelling` | `{operationId: string}` | Active cancellation requested, not terminal |
| `prompt.finished` | `{operationId: string, status: OperationStatus}` | Normal prompt-completion path; not emitted on every stop/crash path |
| `operation.changed` | `Operation` | Full operation snapshot at allocation/state/target/cancellation/terminal changes; envelope has target agent ID when known, but no generation |
| `agent.message` | ACP `SessionUpdate` | Message/thought variants; see §6.1 |
| `tool.call` | ACP `SessionUpdate` with `sessionUpdate: "tool_call"` | Initial tool-call state; already-completed calls can also appear here |
| `tool.update` | ACP `SessionUpdate` with `sessionUpdate: "tool_call_update"` | Nonterminal/partial tool state |
| `tool.result` | ACP `SessionUpdate` with `sessionUpdate: "tool_call_update"` | Update status is `completed` or `failed` |
| `agent.plan` | ACP `SessionUpdate` with `sessionUpdate: "plan"` | Plan entries |
| `agent.update` | Other ACP `SessionUpdate` | Pass through/render tolerantly; not all new variants get their own category |
| `permission.requested` | `{permissionId, sessionId, toolCall, options, ...}` | ACP permission request plus server permission ID |
| `permission.resolved` | `{permissionId, outcome}` | Outcome shape in §6.3 |
| `plugin.error` | `{code, message, method?}` | Hook/endpoint-dependent diagnostic |

Do not rely on exact sibling-event ordering beyond their observed `seq`, or require that every operation passes through every event listed. In particular, stopping/crashing a process can terminalize prompt operations without `prompt.finished`. Use **terminal `Operation.status`** as the authoritative completion signal.

### 6.1 Message rendering and prompt correlation

Representative event:

```json
{"kind":"event","seq":120,"time":"2026-10-08T06:00:01.000Z","type":"agent.message","agentId":"agent-1","generation":"generation-1","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello "}}}
```

Common ACP updates:

```ts
interface ContentChunk {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  content: { type: "text"; text: string } | Record<string, unknown>;
  messageId?: string | null;
  _meta?: Record<string, unknown> | null;
}
```

Append assistant text chunks in sequence order; display thought chunks separately if desired. Preserve/tolerate non-text content and unknown variants, rather than assuming every `agent.message` has `content.text`. The core categorizes any ACP update name containing `message` or `thought` as `agent.message`, so newer message variants may have other shapes.

Important limitations:

- Message/tool events carry agent ID and generation, **not operation ID**.
- Correlate with `prompt.started` and the current running prompt operation for that agent/generation. There is at most one active prompt per agent.
- If reconnecting mid-prompt, use the snapshot's running prompt operation as a correlation hint. If the relevant events were filtered/missed, label the attribution uncertain until refreshed.
- Do not use “the last prompt submitted” as the active prompt: it may be queued behind another.
- The current Pi adapter emits text/thinking deltas, without assistant-message boundaries or message IDs. It does not forward Pi's complete finalized message/usage records as public events. A faithful multi-message transcript cannot be reconstructed from public chunks alone.
- After `prompt.finished`, the accumulated `Operation.result.text` is a bounded prompt-level summary stream, not a new additional chunk. Reconcile/replace a provisional prompt display rather than appending it again.

The server fences updates from replaced process generations. Clients should still retain historical events under their original generation and reset the live stream/tool grouping when a new generation starts. A generationless `operation.changed` or lifecycle event is valid, not automatically stale. If `agent.state` reports `stopped`/`failed` without a generation, clear/refetch the current process generation.

### 6.2 Tool and plan rendering

Representative ACP tool fields:

```ts
interface ToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string; // Common: pending, in_progress, completed, failed.
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: unknown[];
  _meta?: Record<string, unknown> | null;
}

interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[] | null;
  locations?: unknown[] | null;
  _meta?: Record<string, unknown> | null;
}
```

Correlate tool states by **`(agentId, generation, toolCallId)`**. Updates are partial: preserve fields that are absent. The semantic meaning of partial tool content/raw output is harness-specific; do not blindly concatenate it as text. The Pi adapter supplies its latest partial/final result as `rawOutput`, and wraps text result blocks as ACP content entries.

An update may be observed without its initial call because of filters, reconnect, retention, or truncation. Create a placeholder rather than failing. Tool failure is not proof of overall prompt failure.

`agent.plan.data.entries` contains ACP plan entries with `content`, `priority`, and `status` (commonly `pending`, `in_progress`, `completed`). Render in order, tolerate additional fields/statuses, and preserve the original payload. For exact/full ACP types use the stable entry point of the pinned `@agentclientprotocol/sdk` (`1.7.0` currently), not Pi RPC event types.

### 6.3 Permission dialogs

Representative event:

```json
{"kind":"event","seq":130,"time":"2026-10-08T06:00:02.000Z","type":"permission.requested","agentId":"agent-1","generation":"generation-1","data":{"permissionId":"permission-1","sessionId":"session-1","toolCall":{"toolCallId":"call-1","title":"Allow this change?","status":"pending","kind":"edit"},"options":[{"optionId":"yes","name":"Allow once","kind":"allow_once"},{"optionId":"no","name":"Reject once","kind":"reject_once"}]}}
```

Display the supplied tool-call description and option names. Submit the selected `optionId`, not the label or array index. Typical ACP option kinds are `allow_once`, `allow_always`, `reject_once`, and `reject_always`; preserve the server's offered choices rather than inventing extra ones. Client dialog cancellation sends `cancelled: true`, not a guessed rejection option.

Resolution data:

```json
{"permissionId":"permission-1","outcome":{"outcome":"selected","optionId":"yes"}}
```

or:

```json
{"permissionId":"permission-1","outcome":{"outcome":"cancelled"}}
```

Permissions expire after `maxWaitMs` (default 30 seconds) or earlier when work is cancelled/stopped/finished. The event has no explicit deadline; do not assume your countdown exactly matches remaining server time. The current Pi adapter maps confirm/select dialogs to permission options; input/editor dialogs are cancelled by the adapter because arbitrary text entry is unsupported by this path.

There is **no query/list endpoint for pending permissions**, and snapshots do not contain them. A reconnecting client can infer unresolved requests from retained `permission.requested/resolved` history, but they may already have expired; gracefully handle `NOT_FOUND` on response. If that history is incomplete or truncated, do not present an inferred dialog as authoritative. Merely seeing agent state `waiting` is insufficient to recreate a permission dialog.

## 7. Connection setup and reconnect algorithm

Subscriptions are live-only. A robust client must combine snapshots, live events, and optional history queries.

Recommended setup:

1. Connect and immediately start a read/dispatch loop that buffers events, even before sending the first request.
2. Keep all control events enabled while synchronizing. Prefer the default unfiltered stream, or explicitly call `subscribe` with `{}`.
3. Request `organization.snapshot`; retry readiness probes on `NOT_READY` with bounded backoff.
4. Build agent/operation maps from the snapshot. Store its sequence `S` as a **state synchronization watermark**.
5. Discard buffered events with `seq <= S` **for state reduction only**. Their effects are represented in the snapshot. They may still be needed for transcript/history views, since snapshots contain no transcript.
6. Apply buffered events with `seq > S` in ascending order, deduplicating by sequence, then switch to live processing.
7. Refresh individual records when lifecycle events do not contain enough fields; use full resnapshot for broad uncertainty/truncation.
8. Optionally install narrower filters once synchronized. Maintain query/poll fallbacks for statuses whose events are excluded.

Reconnect:

- Reject/mark all unresolved network requests as **outcome unknown**. A lost response is not proof the server did not act.
- Reconnect with exponential backoff/jitter and reapply subscriptions; they are not persisted.
- Repeat snapshot synchronization. Previously obtained operation IDs remain queryable unless pruned.
- If transcript continuity matters, query `events.history` from the last stored history cursor, merging with buffered live events and deduplicating. Do not skip historic chunks simply because the state snapshot is newer.
- When `expired` is true, show the transcript/history gap explicitly; resnapshot restores current state, not missing conversation text.
- If the database sequence went backwards, clear sequence-based deduplication/history assumptions and load a new organization view.

Maintain separate notions of **state watermark** and **history cursor**. A snapshot does not imply the client has downloaded all message/tool events through that sequence. Likewise, an agent-filtered subscription/history cursor does not prove global history coverage.

For bounded history replay, capture an upper sequence `T` from a snapshot or history response. Page forward from the old history cursor, processing events up to `T`; events beyond `T` belong to the buffered/live phase. The API does not freeze retention during replay, so check expiry on every page.

The built-in `OrganizationClient` is a small reference implementation, not a complete reconnecting/stateful client. It has request correlation, event callbacks, operation waiting, and explicit close; it does not perform automatic resubscription, replay, or reconciliation.

## 8. Timeouts, retry safety, and operation tracking

### 8.1 Separate three deadlines

Keep these concepts distinct:

1. **Network request deadline**: how long the client waits for one response.
2. **Server wait duration**: `operation.wait.waitMs`; bounded, not cancellation.
3. **Overall operation deadline**: how long the application wants to wait for completion; expiring it does not implicitly stop the server operation.

If the application chooses to cancel after its overall deadline, explicitly call `operation.cancel`, then continue checking until terminal or decide to stop the agent. Lifecycle operations might be noncancellable once running.

### 8.2 No exactly-once request retry

The server has no durable request-ID deduplication, client-supplied operation ID, or idempotency key. Reusing a request ID after reconnect can execute the method again.

After an uncertain response:

- Query known operation IDs instead of resubmitting their initiating mutation.
- For an unknown creation outcome, take a snapshot and reconcile. A client-chosen unique marker in `agent.create.metadata` can help identify the record, but it is not enforced as unique and does not prevent duplicates.
- Prompt retries are especially consequential: default `queue: false` can cancel ongoing work; `queue: true` can duplicate it.
- Session replacement/restart retries can cause additional replacements/restarts; reconcile first.
- Even a repeated stop/remove has record/state/event consequences and can fail after the first removal; do not assume retries are transparent.
- Read-only queries and filter installation can generally be retried after reconnect/readiness, but fresh responses may differ from previous ones.

A public client response with `ok: true` and an operation means acceptance. Model execution errors occur later on that operation; the original request does not get a second failure response.

### 8.3 Suggested operation reducer

Keep operations in a map by ID. Use accepted-operation responses, nontruncated `operation.changed` events, and `operation.get/wait` results as operation snapshots. Serialize updates locally; be cautious that a response generated earlier can arrive after a newer event, because response envelopes have no event sequence.

Never regress a known terminal operation back to queued/running on a late response. For ambiguous nonterminal updates, refresh with `operation.get`. A client-side pending-request ID is separate from the durable operation ID. A lifecycle mutation can finish before its acceptance response arrives, so always consult buffered events/current queries instead of overwriting newer state blindly.

Use `completedAt` and terminal status to stop progress indicators; do not use agent `idle`, a terminal tool call, or `prompt.finished` alone as the durable operation tracker. Poll/wait as a fallback when event filters/truncation can hide completion.

## 9. Errors

Current built-in codes include:

| Code | Typical location / meaning | Client action |
|---|---|---|
| `INVALID_PARAMS` | Request/parameter validation or unknown permission choice; may also be an operation error | Correct fields/types; refresh permission choices if necessary |
| `INTERNAL` | Unclassified exception, including current malformed-JSON parsing, harness exceptions/timeouts, and some plugin failures | Show message, reconcile state before mutation retry; not every such error is a server crash |
| `METHOD_NOT_FOUND` | Unknown method or unloaded plugin endpoint | Check deployment/client compatibility |
| `NOT_READY` | Startup/recovery in progress | Retry a readiness query with backoff |
| `SHUTTING_DOWN` | Organization shutdown in progress | Reconnect later; do not submit more mutations |
| `NOT_FOUND` | Unknown/removed mutation target, unknown/pruned operation, or resolved/expired permission | Refresh relevant state; removal and history pruning are distinct from unknown creation |
| `FORBIDDEN` | Agent capability/hierarchy violation or public use of agent-only MCP methods | Public client should omit tokens and use public methods |
| `ROOT_EXISTS` | Creation operation: an unremoved root already exists | Use existing root or explicitly remove it |
| `INVALID_HARNESS` | Creation/modification/recovery harness not registered | Correct harness/deployment configuration |
| `CONFLICT` | Modification operation's expected revision is stale | Refresh and merge edit; resubmit deliberately |
| `LIMIT` | In-flight, queue, size, tree, record, or process limit | Reduce concurrency/size or change server configuration; distinguish request failure from allocated failed operation |
| `NOT_RUNNING` | Prompt target has no available process | Inspect agent; restart if appropriate |
| `NOT_CANCELLABLE` | Attempt to cancel a running lifecycle mutation | Wait, or queue a target-agent stop |
| `FRAME_TOO_LARGE` | Incoming JSONL record exceeded limit; connection closes | Reduce record size and reconnect |
| `START_FAILED` | Restart/replacement/subtree startup failure | Inspect affected records; partial subtree success possible |
| `PROCESS_EXITED` | An active operation terminated with process failure, depending on event ordering | Inspect agent/process diagnostic; deliberate restart |
| `INTERRUPTED` | Startup marked previously pending operations stopped after server restart | Do not resume implicitly; user decides whether to submit new work |
| `SUPERSEDED` | Queued prompt cancelled by a newer default-mode prompt | Show stopped/superseded; do not retry automatically |

Plugin error codes/types may extend this list. Treat codes as machine-readable strings, messages as human-readable diagnostics; do not parse message wording for control flow. Error envelopes and failed/stopped operation records are two different reporting channels and both must be handled.

## 10. Persistence, retention, and deployment limits

The server persists agent records, operations, and events in SQLite. Removal and session replacement do not delete existing records/transcripts. On server restart:

- Previously queued/running operations become `stopped` with `INTERRUPTED`; they are never silently resumed.
- Previously active, unremoved agents become stopped by default.
- With server `--recover`, those agents are started parent-first. Individual startup failures mark agents failed and recovery continues for other descendants.
- Agents already stopped/failed, and removed agents, are not automatically recovered.

Clients should refresh after reconnect rather than assume their last running indicators are still accurate.

Default configurable limits:

| Name | Default | Client relevance |
|---|---:|---|
| `maxDepth` | 8 (root depth 0) | Child creation |
| `maxChildren` | 16 per unremoved parent | Child creation; unremoved stopped/failed children still count |
| `maxProcesses` | 32 | Process startup |
| `maxPrompts` | 8 | Global active prompts, including coordinating parents waiting inside tools |
| `maxQueuedPrompts` | 100 per agent | FIFO enqueue limit; excludes the active prompt |
| `maxPromptBytes` | 131072 | UTF-8 prompt bytes, not character count |
| `maxResponseBytes` | 1048576 | Stored result/event-data truncation |
| `maxEvents` | 100000 | Global retained events; a noisy agent can evict another agent's older events |
| `maxOperations` | 10000 | Retained terminal operations; active operations are not pruned |
| `maxAgents` | 10000 | All agent records, including removed agents |
| `maxLineBytes` | 2097152 | Incoming JSONL request-record limit |
| `maxClientBufferBytes` | 4194304 | Slow-client and single oversized outgoing-record disconnect threshold |
| `startTimeoutMs` | 30000 | Launch/session initialization stages; not a total lifecycle deadline |
| `cancelTimeoutMs` | 5000 | Active prompt cancellation escalation |
| `stopTimeoutMs` | 5000 | Graceful process-stop interval |
| `killTimeoutMs` | 1000 | SIGTERM interval before SIGKILL |
| `maxWaitMs` | 30000 | Maximum operation wait and permission timeout |

These are deployment defaults, not immutable protocol constants. `server.ready` carries actual configured limits when observed; there is no dedicated current-configuration query. A client connecting later must use deployment settings or respond to errors rather than assume it can retrieve them through snapshot.

Terminal-operation pruning happens during operation changes; a previously known ID can later return `NOT_FOUND`. Event-history cursor expiry is global, independent of an agent filter. Agent records are retained rather than pruned; eventually the all-record creation cap can require operator archival/reset.

### 10.1 Transcript access versus persistence

Public `events.history` returns the retained server event log, **not a complete Pi session transcript**. `Operation.result.text` is likewise bounded and excludes thinking/tool content.

For Pi, full native session files are stored under:

```text
<dataDir>/sessions/<agentId>/<sessionNumber>/
```

The server exposes neither `dataDir` in snapshots nor an endpoint to list/download those session files. A same-machine client that needs native transcripts must have explicit deployment knowledge and separate filesystem access, or use a future/plugin transcript endpoint. Do not derive actual transcript filenames from `sessionId` alone; Pi manages its file naming.

Native session files/workspaces are retained indefinitely by normal operation, including after removal/replacement; server event/operation history is independently bounded. Test harnesses can explicitly delete their temporary data directories on cleanup. The current live integration test does this, so it does not retain native transcripts after completion.

## 11. Agent hierarchy and extension boundaries

Public clients act as operators over the whole organization. MCP callers act as agents with per-generation capabilities:

- Agents create only their own direct children.
- They mutate/prompt strict descendants, not themselves, siblings, or ancestors.
- They query themselves/descendants and permitted operations.
- Capabilities expire when the process generation stops/restarts.

The public client normally sees descendant management as ordinary `agent.*` operations whose `caller.kind` is `agent`. It need not implement MCP to observe or manage that work. Calling `mcp.list` or `mcp.call` as an ordinary public client returns `FORBIDDEN`.

Plugins can add namespaced client endpoints and additional event types. Snapshot `capabilities.skills` advertises the skills plugin; there is no generic endpoint discovery mechanism. Other plugin schemas must be configured/documented separately. Unknown custom data should be preserved or displayed as generic JSON, not treated as a malformed core record.

Hierarchy checks are API policies, not a filesystem/process sandbox. All public clients share the server OS user's authority; agents with shell access also run with that user's privileges unless a trusted plugin adds isolation. Client logs must not leak settings, prompts, tool arguments/results, or transcript content unintentionally.

## 12. End-to-end client flow

The following requests are complete JSONL examples. IDs such as `root-id` and `create-op` stand for values returned by earlier responses, not literal IDs to invent.

### 12.1 Connect, synchronize, and create a root

```json
{"id":"snapshot-1","method":"organization.snapshot","params":{}}
{"id":"create-1","method":"agent.create","params":{"name":"coordinator","metadata":{"clientRequestMarker":"unique-marker-1"},"settings":{"harness":"pi","provider":"openai-codex","model":"gpt-6-luna","cwd":"/tmp/my-project","options":{"thinking":"low"}}}}
```

If the snapshot already contains an unremoved root, use/manage it instead of trying to create another. Ensure `/tmp/my-project` exists on the server machine.

Creation acceptance is a response with an `Operation` in `result`. Remember its `id`, then wait:

```json
{"id":"wait-create-1","method":"operation.wait","params":{"operationId":"create-op","waitMs":1000}}
```

Repeat while status is queued/running. If completed, use `result.id` as the agent ID. If failed/stopped, display its error/status and refresh; a failed record can still exist.

### 12.2 Submit work and stream it

```json
{"id":"prompt-1","method":"agent.prompt","params":{"agentId":"root-id","text":"Create two child agents using the organization MCP tools, assign one implementation and the other tests, coordinate them, and report the result."}}
```

Remember the returned prompt operation ID. Track `prompt.started`, message chunks, tool calls/results, permission requests, and agent/operation changes for both the root and its descendants. The root can allocate child creation/prompt operations while its own prompt remains running.

A subscription can exclude noisy partial tool updates:

```json
{"id":"filter-1","method":"subscribe","params":{"excludeTypes":["tool.update"]}}
```

For each permission request, display the offered choices and use `permission.respond`. Continue operation waits until terminal status:

```json
{"id":"wait-prompt-1","method":"operation.wait","params":{"operationId":"prompt-op","waitMs":30000}}
```

Leave enough global prompt slots for parents waiting on child tasks. The default 8 slots supports the demonstrated root plus two concurrent workers; a tree whose active coordinators occupy every slot can leave descendants queued indefinitely.

### 12.3 Cancel, inspect, or remove

```json
{"id":"cancel-1","method":"operation.cancel","params":{"operationId":"prompt-op"}}
{"id":"get-root-1","method":"agent.get","params":{"agentId":"root-id"}}
{"id":"history-1","method":"events.history","params":{"after":0,"limit":100,"agentId":"root-id"}}
{"id":"remove-1","method":"agent.remove","params":{"agentId":"root-id"}}
```

Cancellation/removal acceptance does not mean completion; query their operations. A root removal archives its full subtree but does not delete workspaces/native sessions. Historical `agent.get` still works after removal.

## 13. Client implementation checklist

- [ ] Configurable Unix socket path and deployment-aware server-side workspace paths.
- [ ] UTF-8/LF-only framing handling fragmentation, multiple records, CRLF, escaped newlines, and Unicode separators.
- [ ] Unique request IDs, response correlation, serialized writes, continuous reads, and receive-size limits.
- [ ] Independent event processing while requests and operation waits are outstanding.
- [ ] Direct request errors distinct from failed/stopped asynchronous operations.
- [ ] Snapshot-backed tree and operation maps; active versus historical agent views.
- [ ] FIFO/supersession UI, explicit cancelling state, and terminal-status completion checks.
- [ ] Optimistic settings edits using `expectedRevision`, with conflict refresh/merge.
- [ ] Agent/generation-aware prompt streams and tool-call maps; tolerant ACP payload rendering.
- [ ] Permission choice/timeout/race handling, including multi-client resolution and reconnect limitations.
- [ ] Separate network/operation/wait deadlines; no blind non-idempotent mutation retries.
- [ ] Resubscription and snapshot resync after reconnect; history deduplication and explicit expiry gaps.
- [ ] Truncated payload handling and large-snapshot/output-buffer disconnect recovery.
- [ ] Unknown plugin events/error codes tolerated without weakening built-in validation.
- [ ] Sensitive data excluded/redacted from client diagnostics as appropriate.

## 14. Optional skills plugin

Discover support from `organization.snapshot.capabilities?.skills === true`; absence means unsupported. Keep persisted `settings.skills` visible in raw agent data even when support is disabled. Do not call skills endpoints on older/disabled servers.

Client-only endpoints:

| Method | Parameters | Result |
|---|---|---|
| `skills.add` | `{name: string, gitUrl: string}` | `{name, gitUrl, description, createdAt, path}` |
| `skills.list` | `{}` | `{skills: Skill[], recovery: {agentId, skill, path, error?}[]}` |

Catalog names and source URLs are unique; duplicates fail with `DUPLICATE`, never update an existing entry. Names are lowercase alphanumeric words separated by single hyphens, ≤64 characters. Production Git URLs are HTTPS on github.com/gitlab.com/bitbucket.org, without credentials, ports, queries, fragments or redirects. One root `SKILL.md`, matching name and nonempty description/instructions, is required. The default branch is cloned; no delete/update/pin API exists. `skills.add` can take up to the Git timeout (60 seconds); use a longer request timeout, and never automatically retry an unknown outcome. All paths refer to the server filesystem.

`settings.skills` maps catalog names to `unavailable`, `available`, or `installed`. Missing entries mean unavailable. New agents default to no selection; children inherit nothing automatically. An explicit map is a complete replacement, `{}` clears it, and omission during modification is unchanged. Every reference must exist, including explicit unavailable entries. Use `expectedRevision` when saving drafts. Installed skills load into the agent; available skills are only delegable.

Public-client installed/available grants add availability to all ancestors, preserving their installed states. Target and ancestor records persist atomically; changed ancestor revisions increment and `agent.modified` events follow. Grant revocation is not automatic: ancestors and existing descendants retain earlier selections. MCP `child_create`/`descendant_modify` accept the same `settings.skills` field but can grant only the caller's available/installed skills; unchanged omitted selections are not fresh grants. `skills_list` is agent-facing MCP, not a public endpoint.

Mutations still return lifecycle operations and may restart active targets. Installation/validation failure does not commit selections or ancestor grants. Later launch failure leaves committed selections with a failed agent. With support disabled, new nonempty selections and launches using retained nonempty selections fail with `SKILLS_DISABLED`. Existing settings/files survive plugin disablement.

All nonremoved agents must have distinct canonical cwd paths while enabled (including stopped/failed agents). `CWD_CONFLICT`, `COLLISION`, `SKILL_NOT_READY`, `FORBIDDEN`, `LIMIT`, and validation errors require inspection, not automatic retry. The cwd plugin optionally adds containment rules.

Files install under `<cwd>/.agents/skills/<name>`. Downgrade/cwd changes retain old checkouts outside discovery; removal retains them in place. The plugin fetches committed work into fresh central recovery refs without committing, merging, resetting or deleting dirty/untracked work. Recovery is asynchronous on removal and is not implied by removal success. Watch `skills.error`, `skills.recovered`, `skills.catalog_added` and `plugin.error`; pending failures are returned by `skills.list`. Settings describe selections, not an unconditional guarantee of filesystem readiness. Missing/damaged managed checkouts cause launch failures and operator-visible diagnostics. Core SQLite writes and filesystem/Git work do not share a transaction; a separate durable journal supports conservative startup reconciliation.

Client conformance tests should cover events arriving before acceptance responses, out-of-order responses, late queued responses after terminal events, reconnect during running work, filtered sequence gaps, stopped/failed root reuse, revision conflicts, supersession, cancellation escalation, expired history/permissions, and response truncation. Deterministic protocol tests need no model calls; any model-backed testing for this project must use only `gpt-6-luna`.
