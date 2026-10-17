# API-v1 generic extensions

API v1 evolves additively with `registerSettings`, `beforeMutation`, `onInitialize`,
`prepareLaunch`, `validateLaunch` and `registerCapability`. The old feature-manager
contract is removed (plugins using it must upgrade; apiVersion remains 1 because
this is a coordinated pre-1.0 host/plugin contract replacement). Other API-v1
plugins remain compatible; future breaking changes require a new API version.

`settings.extensions` maps plugin namespaces to JSON values. Built-in settings
remain strict. On modify, omitted namespaces are preserved; supplied namespace
values completely replace that namespace (including `{}`). Plugins validate and
normalize values. Unknown namespaces are preserved in storage but cannot be
mutated or launched without their registered owner. Unknown legacy top-level
persisted fields similarly block launch and modification, never disappear.
Plugins may register a conservative legacy-settings migration. Initialization
migrates all affected rows atomically, retaining revisions (representation only), before
reconciliation and recovery. Ambiguous migrations abort startup without writes.

## Reusable client settings editors

Plugins may add optional presentation hints to `registerSettings`:

```ts
host.registerSettings({
  namespace: "demo",
  validate: validateDemoSettings,
  ui: { fields: [
    { key: "inputs", label: "Input files", editor: "paths" },
    { key: "grants", editor: "directories" },
    { key: "tags", editor: "list" },
    { key: "env", editor: "string-map", sensitive: true },
    { key: "retries", editor: "number" },
    { key: "enabled", editor: "boolean" },
  ] },
});
```

The snapshot advertises these as `capabilities.settingsEditors[namespace].fields`.
Each field addresses one **top-level** namespace object key (not a dotted path).
Keys match `[A-Za-z_][A-Za-z0-9_.-]*`; keys/labels and field counts are capped at
128, and duplicate keys are rejected at registration. Plugins with scalar/array
namespace values should omit these hints and retain opaque editing.

Editors are `text`, `number`, `boolean`, `string-map`, `object-map`, `list`
(nonempty strings), `directory`/`path` (single path), and `directories`/`paths`
(path lists). Path completion always uses `organization.paths` on the **server**,
with the same captured parent/server startup base as cwd. Directory grants must
already exist; editors do not create them. `path`/`paths` allow file suggestions;
the plugin must validate existence and its own semantics. `sensitive` hides values
outside explicit entry/raw editing and filters maps by key only.

These are hints, not a validation schema or authorization policy. Validators and
lifecycle operations remain authoritative. Clients may ignore unknown editor
kinds. Older clients/servers work unchanged. AgentOrg TUI stages edits against the
captured revision, preserves unedited sibling fields, and sends complete changed
namespace replacement values. Absent fields are not added until explicitly edited;
no defaults or runtime plugin code are loaded by the client. Avoid editing the same
namespace through both its advertised form and raw extensions in one draft (the
client rejects ambiguous changes). Podman's specialized image propagation remains
an explicit client-only operation, not a generic UI hook.

## Server-wide public settings

`registerSettings` above remains **per-agent** only. The additive
`registerServerSettings` API declares public server-wide configuration; core owns
its storage, revisions, client-only authorization, reset and change events.
Plugins read detached effective values with `serverSettings(namespace)` at the
appropriate runtime/launch boundary. Fields declare immediate, future-launch or
server-restart effects. Existing plugins need not opt in. Secrets are excluded,
and there is no settings MCP tool. See [the server settings contract](SERVER_SETTINGS.md)
for descriptors, validation, migrations and client APIs.

## Event renderers (presentation contract v1)

API v1 adds optional `HarnessPlugin.renderers` and `host.registerRenderer()`.
Existing harnesses need no changes. Renderers run **only on the trusted server**;
clients receive Markdown and JSON metadata, never callbacks or Pi TUI components.
A harness can customize **any event type** associated with its agents, not just
calls/results. Tool-specific matches use `data.toolName`, then `data.title`, never
the broad ACP `kind` (`edit`, `read`, etc.). Adapters should retain exact identity
and arguments on updates/results too; missing identity safely uses a fallback.

```ts
import { renderTool, toolExamples, type EventRenderer } from "agent-organization/plugin";

const readRenderer: EventRenderer = {
  id: "read", name: "My read style", tool: "read",
  eventTypes: ["tool.call", "tool.update", "tool.result"],
  examples: toolExamples("read"), // synthetic PUBLIC samples
  render(event) {
    return renderTool(event); // or your harness's own pure formatter
  },
};
host.registerHarness({ name: "my-harness", renderers: [readRenderer], launch });
// Optional server-default candidate, selected by its ID in server settings:
host.registerRenderer({ ...readRenderer, id: "my-plugin.read" });
```

A callback receives a detached event and returns `{summary, extended, full}`
(with optional additive `extendedDiff` semantic spans):

- `summary`: exactly one nonempty logical line; used in the tree regardless of chat level.
- `extended`: at most two logical lines. Clients may wrap these onto more screen rows.
- `full`: all relevant available content, including status/errors and partial/truncation markers.
- **Raw is not a callback output.** It is always the complete original event envelope.

Return Markdown without ANSI escapes, terminal commands, HTML-dependent styling,
or client-specific markup. Clients own sanitization, colors, wrapping and clipping.
Use fenced code/diff blocks for literal content; the public `fenced()` helper
handles embedded backticks. `renderTool()` supplies portable read/bash/edit/write
styles and a generic unknown-tool representation. Headers use `$` for bash,
`<` for read, `>` for write, `Δ` for edit, and `• toolname` for unknown tools.
Routine phase/status strings and repeated argument JSON are omitted; commands,
paths/ranges, sizes, line/diff counts and failures remain. The client distinguishes
call/update/result with local header colors (yellow/orange/green or red), not
server-generated ANSI. A missing result is not a successful empty result. No filesystem reads
or native Pi render-component execution is needed to render retained history.

Callbacks must be synchronous, pure, deterministic and bounded (no I/O). Plugins
are trusted; synchronous code cannot be preempted. Throwing, async or malformed
outputs fall through to the next tier without breaking delivery. Core enforces
the logical line caps, marks truncation, substitutes `—` for an empty summary,
and bounds summary/extended/full text to 8 KiB/16 KiB/2 MiB respectively. This
presentation bounding never changes a retained/raw event.

For an edit's extended preview, `renderTool()` may return
`extendedDiff: {prefix, before, after}` alongside its two-line Markdown `extended`
representation. These are **plain literal strings**, not Markdown or ANSI, each
capped at 8192 characters and normalized to one logical line. Clients may display
`prefix` in the lifecycle header color, `before` red, and `after` green on the next
line, aligned using terminal cells. Older clients simply render `extended`.
This is an optional presentation-v1 addition, not a new plugin/capability version.
Failed edits omit this hint and show their error instead of an apparent applied
replacement. Multiline/multi-region previews are abbreviated (`↵`, `…`, `∅` for an
empty side); full retains the diff and raw always retains the source data.

Full edit output prefers the actual result's `details.patch`/`details.diff`.
Before a result exists, it computes a context diff from retained
`edits[].oldText/newText` (or legacy `oldText/newText`), **without filesystem I/O**.
Generated hunk line numbers are relative to the supplied replacement, explicitly
labelled as such. Diff computation is bounded: very large replacements use a
labelled simplified replacement diff; more than 64 regions are marked incomplete
with raw fallback. Unchanged distant content and duplicate raw argument dumps
are not included in normal full output. Clients color fenced `diff` additions and
removals locally, independently of lifecycle header colors.

Resolution: matching current-agent harness renderer (exact tool matches before
type-wide matches, then registration order), then the configured server-default
candidate, then `generic`. The built-in `core.tools` candidate distinguishes
read/bash/edit/write; unknown tools use generic fields. Non-tool events retain
client generic rendering unless their harness explicitly matches them. Harness
IDs are **not persisted on events**: changing an agent's harness, server default,
or renderer implementation may change rendering when history is fetched again.
No schema migration or replayed tool execution is involved.

`examples` contains 1–8 synthetic `{type, data}` events, covering the relevant
phases. The server generates all four level previews by invoking the real
callback; raw is generated from the unchanged synthetic envelope. Never put real
session data or secrets in examples/names. Public catalog records contain only
IDs, names, event types, optional tool/harness, and generated examples. Harness
IDs are qualified as `<harness>/<renderer.id>`; server-default IDs are unqualified.

Client transport is opt-in and additive:

- Non-agent snapshots advertise `capabilities.rendering = {version: 1, catalog: "events.renderers"}`.
- `events.renderers {}` returns `{version: 1, renderers: [...]}` (client-only).
- `subscribe {renderings: true}` sends a separate
  `{kind: "presentation", seq, rendering: {rendererId, subtype?, summary, extended, full, extendedDiff?}}`
  **before** its unchanged event frame. Filters apply to both; agent subscriptions
  never receive presentation frames.
- `events.history {after, limit, agentId?, renderings: true}` adds a `renderings`
  object keyed by sequence number; `events` remains untouched. Agent history
  omits this sidecar. Default subscriptions/history responses are unchanged.

The public `OrganizationClient` exposes `onPresentation((seq, rendering) => …)`
separately from `onEvent`; presentation remains opt-in via `subscribe`.
Clients should negotiate version 1, ignore unsupported versions, keep sidecars
outside event records, and retain generic rendering when presentation is absent.
Do not merge harness-rendered message chunks unless the renderer supports it.
Chat level preferences may use `<event.type>:<tool>` subtypes inheriting their
parent event type; they do not select the server renderer. Presentation contract
breaking changes require a new capability version; plugin API breaking changes
require a new `apiVersion`. See [server defaults](SERVER_SETTINGS.md).

## Lifecycle participants

Lifecycle participants prepare inside the server's serialized queue, before an
old process stops. They receive cloned current records and the proposed target,
plus the original settings patch. They can transform target settings and request
related settings replacements with expected revisions. Conflicting participants
requesting the same related record are rejected rather than last-writer-wins.
Settings transforms/workspace validators run on related records too. Related rows and target
commit in one core SQLite transaction. Related changes may not change the launch
identity of a running agent. Owners may declare `launchKey` for their namespace;
by default the whole value participates. A launchKey must include all resources
that require a process restart. Apply runs after stop; failure rolls participants
back in reverse order. Preparation must compensate its own partial failure.
Finalize runs after record commit; errors are reported, never undo the commit.
Initialization, restart, stop, replacement and removal also admit participants.
Hooks must not enqueue/wait for nested lifecycle requests; these are rejected.
Read-only requests are safe. Plugins are trusted; authorization of their related
changes belongs to the plugin, not to the end-user caller.

`prepareLaunch` augments generic context env/MCP servers before harness launch;
`beforeLaunch` transforms the spec; `validateLaunch` checks the final resolved
spec after all transformations. `LaunchSpec.consumesEnv` declares environment
contracts a harness/wrapper consumes; plugins can require these for readiness.
Host capability env variables are applied last. `LaunchSpec.inheritEnv: false` omits ambient host environment and `settings.env` from the final merge (only explicit spec env, trusted context env, and core capability variables remain). Container plugins set `LaunchContext.executionEnvironment: "container"` before harness launch; adapters then return image-installed commands rather than host paths. Process limits, credentials, bounded startup and
safe shutdown remain host-owned. Workspace policy plugins validate final cwd.
`capabilities.plugins` is an uninterpreted namespaced discovery map; absent maps
on older servers mean optional plugin features are unavailable.

The host prefixes plugin setup and callback failures with the plugin's `name`,
for example `skills: cwd must be unique`, while preserving API error codes.
This includes lifecycle hooks, settings callbacks, harnesses, endpoints, tools,
observers, shutdown hooks and mutation apply/rollback/finalize callbacks. Callback
timeouts also identify their plugin. Delegated failures retain the originating
plugin rather than accumulating prefixes. Plugins receive a scoped `PluginHost`;
error/warning events emitted through it (types ending in `.error`, `.warn` or
`.warning`, including the bare names) have string payloads or their `message`
field prefixed too. Ordinary event payloads are unchanged. Direct console output
is not intercepted.

This is compensation, not a distributed transaction. SQLite is atomic only for
core rows. Plugins must journal filesystem/external actions before applying them
and reconcile on initialization. A crash between apply and record commit requires
compensation; a crash after commit requires completion. Launch failure after
commit does not revert settings. Stop/remove do not require absent extension
owners and preserve opaque data; restart/recovery revalidate owners at launch. Shutdown/process state writes are outside that
settings commit. Plugins own their own SQLite databases and close them on shutdown.
