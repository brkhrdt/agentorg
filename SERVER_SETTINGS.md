# Server-wide public settings (API v1)

Server settings are organization-wide, not agent `settings.extensions` and not
client display preferences. The core owns SQLite persistence, validation dispatch,
revision fencing, authorization, and durable change events. Plugins opt in with
public declarations; existing plugins need not change. **Credentials and secrets
must not be declared or accepted here**, including inside nested lists/maps.
There is no secret editor, environment editor, or settings MCP tool.

## Client API

Non-agent clients and trusted server code may call these methods. Agent callers
are denied, even when directly requesting methods rather than using MCP. This
uses the existing trusted Unix-socket client model, not a new user/role system.

- `organization.settings.list {}` returns `{groups, facts}`. Facts (cwd, data
  directory, socket, loaded harnesses/plugins) are read-only.
- `organization.settings.get {namespace}` returns one settings group.
- `organization.settings.update {namespace, expectedRevision, patch?, reset?}`
  saves an atomic, top-level patch and/or resets named fields. Supply the revision
  returned by a read; stale revisions return `CONFLICT`. Unknown keys, overlapping
  patch/reset keys, and invalid values are rejected before any write or effect.

Example:

```json
{"namespace":"core","expectedRevision":0,"patch":{"maxProcesses":16}}
```

Reset removes the persisted override, restoring the **current startup default**:

```json
{"namespace":"core","expectedRevision":1,"reset":["maxProcesses"]}
```

Lists/maps are complete field replacements, not recursive merges. Delete a list
entry by saving the remaining list; `[]` empties it, whereas reset restores its
default. Revision checks prevent concurrent clients losing each other's changes.
To reset a group, send all its field keys in `reset`. No automatic retries.

Each group includes its descriptor, `revision`, `defaults`, desired `values`,
currently `effective` values, `overridden` keys, and `restartRequired` keys.
The snapshot advertises descriptors only (not configuration values) under
`capabilities.serverSettings = {version: 1, groups, endpoints: {list, get, update}}`.
Agent snapshots omit that capability. Clients must not infer editable settings
from arbitrary plugin capabilities or per-agent extension data.

A successful changed save atomically commits configuration and an
`organization.settings.changed` event. Its public payload is
`{namespace, revision, changedKeys, restartRequired}`—not settings values.
Notifications publish only after persistence and effective-state updates.
Identical/no-op saves do not advance revisions or emit changes. Clients refresh
on notifications, retain stale drafts, and require explicit reload/reconciliation
before retrying a conflicting save.

## Defaults, persistence and effects

Overrides live in the organization's protected `organization.sqlite`, in an
additive `server_settings` table, independently of agent records. They survive
restart and override operator/CLI/plugin-module defaults. Reset removes the
override rather than persisting a copy of the default, so future operator default
changes take effect. Disabling a plugin retains its settings records but hides
its settings and blocks modification until it is loaded again.

Field effects:

- `immediate`: applies at subsequent runtime checks. It does not cancel existing
  work or retroactively shorten timers already installed.
- `future-launch`: becomes available now for the plugin to read when building
  future launches; existing launch configurations must be snapshots.
- `restart`: desired values are saved, but effective values remain unchanged
  until the **server** restarts. Resetting a pending change back to the effective
  value clears the indicator. There is no server/agent restart API in this view.

The initial `core` group exposes the existing runtime limits. `maxLineBytes`
requires restart because client and ACP parsers capture it at creation. Other
limits apply at subsequent checks. Lowering count limits does not delete agents,
stop existing processes, or cancel active prompts; admissions are constrained.
History retention changes prune on subsequent event/operation writes. No save
changes any agent's revision or generation or automatically restarts agents.

## Rendering defaults

The built-in `rendering` group has one immediate setting:
`defaultToolRenderer` (default `core.tools`). It selects a **server-owned registry
candidate**, after a harness's own matching renderers and before `generic`.
`core.tools` supplies distinct read/bash/edit/write formats; `generic` displays
arguments/output for any tool. Plugins may register additional named candidates
with `host.registerRenderer()`. Discover public IDs/names/examples with
`events.renderers {}`; only unqualified IDs (without a harness prefix) can be
selected here. The settings picker uses `events.renderer-choices {}` to list
server-default candidates (client-only, no harness-owned IDs). An unknown/unavailable/nonmatching ID safely falls back to generic,
including after a plugin is disabled. This keeps persisted settings portable.

```json
{"namespace":"rendering","expectedRevision":0,"patch":{"defaultToolRenderer":"generic"}}
```

Changes affect subsequent presentation/live deliveries and history reads, never
stored event envelopes or running agents. Already downloaded client presentations
can remain cached until that history is reloaded. Chat summary/extended/full/raw
levels and per-tool subtype overrides remain **client-only** preferences.
See [the renderer plugin/transport contract](EXTENSIONS.md#event-renderers-presentation-contract-v1).

## Plugin contract

Register during `setup` using the additive `PluginHost` methods:

```ts
host.registerServerSettings({
  namespace: "example",
  title: "Example plugin",
  version: 1,
  defaults: { enabled: true, retries: 3, tags: [] },
  fields: [
    { key: "enabled", label: "Enabled", editor: "boolean", effect: "immediate" },
    { key: "retries", label: "Retries", editor: "number", min: 1, max: 10,
      effect: "future-launch" },
    { key: "tags", label: "Tags", editor: "list", effect: "future-launch" },
  ],
  validate(value) {
    if (!Number.isInteger(value.retries)) throw new Error("Retries must be an integer");
    if (!(value.tags as unknown[]).every(v => typeof v === "string"))
      throw new Error("Tags must be strings");
    return value;
  },
});

// Read at the relevant runtime/launch boundary, not just once during setup.
const config = host.serverSettings("example");
```

`serverSettings(namespace)` returns a detached copy of **effective** configuration.
The scoped host automatically attributes the descriptor and callback errors to
its plugin. `core` and `rendering` are reserved. Schemas, display metadata, defaults, normalization,
and any nested resource policies belong to the plugin; storage, fencing, and
client-only access remain core-owned. Plugins may observe the normal settings
change event for cache invalidation, but must not rely on asynchronous observers
for authoritative application. There is no plugin persistence/application hook
in the commit path, so external side effects cannot cause half-committed settings.

Supported editors are `text`, `number`, `boolean`, `select` (`choices` required),
`list` (public JSON entries), `string-map`, and `object-map`. Clients render static
`select` choices as pickers. `choicesEndpoint` adds server-supplied suggestions
for text/list fields; its client-only endpoint accepts `{}` and returns
`{choices: [{value, label}]}`. An option may advertise an explicit public-resource
setup step: `setup: {endpoint, params, inputKey, label}`. The client prompts for a
value, submits that one client-only setup action, and only then stages selection.
Setup may persist independently of a settings draft (e.g. trusted volume identity
registration), but must not grant access or auto-retry on uncertain outcomes.
No credentials should appear in options, labels or setup parameters.

For structured record lists, declare `itemFields` (one level of ordinary fields),
`itemDefaults` for required fields, and optional `itemIdKey`/`itemLabelKey`. `itemDefaultsFrom`
maps entry field names to sibling public setting keys, allowing forms to seed
from the current server draft. Clients offer add/edit/delete, stage an entry,
stage the list, then confirm the revision-fenced server save. `object-map` fields
can use the same `itemFields`/`itemDefaults` form: supply a `choicesEndpoint` for
new keys (no `itemIdKey`). Add selects an unused server resource, then opens its
field form; existing keys can be edited/deleted without discovery. Choice entries
may supply public `defaults` to prefill known properties. Stage the entry, stage
the map, then confirm the server save. This does not perform option setup or
resource registration unless the endpoint explicitly advertises a setup step.
Record metadata is validated/bounded like ordinary fields; it is not permission
or resource policy. `deprecated: true` marks a public compatibility field that
normal forms omit while preserving its values and API access. This is **not** a
secret mask; credentials remain forbidden. Deprecating a field must not erase its
persisted values or implicitly convert metadata/policy into grants. Fields may provide a
label, description, number bounds, and effect. Namespace/field counts and labels
are bounded, keys are top-level (not dotted paths), and duplicate/unknown fields
and sensitive descriptors are rejected. Defaults must be normalized and contain all required fields.

`optional: true` permits an absent field, in defaults and normalized values, as well
as in record-list forms. Absence means inherit the plugin/runtime default; it is
not the same as an explicit empty string/list. Forms show inherited fields and
reset them to absence when their defaults omit the key. At the top level,
`reset: [key]` removes the override; inside a record form it omits the property
from the staged record. Plugins still own validation and inheritance semantics.
`null` is not an inheritance marker and does not bypass editor type validation.

`validate` is a **pure, synchronous, deterministic** complete-object validator;
it may return normalized public JSON. It is used for registration, reads, and
changes, so it must not perform probes, I/O, or mutations. Do not change undeclared
keys or return secret data. Core checks JSON/editor shape after normalization and
checks the effective configuration as well as desired configuration, rejecting
inconsistent mixtures of immediate and restart-only changes. Classify coupled
fields together when necessary.

Persisted records have a schema `version` and monotonic `revision`. To change a
plugin schema, supply a pure `migrate(overrides, fromVersion)` that returns new
overrides. Core validates the result, normalizes and persists it, and advances the
revision before initialization/recovery. Unsupported/newer versions or invalid
migrations fail closed without overwriting the record. Startup migration is
reflected in subsequent snapshots/reads, not a live mutation notification.

Optionally declare `validateChange(next, previous)` for **read-only, bounded
availability checks** before a changed save. Core runs it inside the serialized
mutation queue after pure validation, with detached desired configurations and a
25-second deadline. Rejection/timeout leaves records, revisions, effective state
and events unchanged; reads and no-op updates never call it. Nested mutations are
forbidden. Plugin code must bound/cancel its own I/O, perform no external writes,
and never rely on this check guaranteeing future external resource availability.
There is still no persistence/application callback in the commit transaction.

Podman now declares named container catalogs and server-supplied choices, and the
TUI snapshots selected configurations into newly created agents. Bounded
in-container capability probes and discovery-driven provider/model options remain
follow-up work. Capability discovery/probing is
not a settings validator: potentially asynchronous probes should produce explicit
validated public results before a catalog save, not run during ordinary reads.
