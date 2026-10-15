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
