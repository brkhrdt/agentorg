# Agent Organization Server Specification

## Status

Initial product and architecture specification. No implementation details or wire schema have been finalized yet.

## Purpose

Build a Bun/TypeScript server that manages a hierarchical organization of AI agents. Clients connect to the server through a Unix domain socket using a JSONL (JSON Lines) API. The server manages agent processes and their lifecycles, communicates with them using the Agent Client Protocol (ACP), and gives agents MCP tools to create and manage their descendants.

The server must support different agent harnesses in one organization tree (for example, Claude and Codex), with harness-specific behavior provided by plugins.

## Initial scope

- Single-user, single-server deployment with one Unix socket.
- A client creates the root agent and selects its harness, model, and other startup options.
- Agents use ACP. Harness plugins implement ACP integration; the server should defer to the protocol and its TypeScript package rather than inventing a parallel agent protocol.
- The server exposes an MCP interface to agents for managing descendants.
- Clients can issue commands and receive streamed server and agent events over JSONL.
- Plugins can extend server behavior, including process setup, API endpoints, MCP tools, and event handling.

Authentication, multi-user support, and remote networking are out of scope for the initial version.

## Agent hierarchy and lifecycle

- Agents form a tree with a client-created root.
- An agent may create and manage its direct children. It may manage descendants through those child relationships, but cannot create a child directly under an arbitrary other agent.
- Removing an agent removes it and its entire subtree from the active organization and stops the associated processes. Removed agents and their history remain available as historical records; removal does not delete workspace directories.
- The server owns process lifecycle management and the relationship between parent and child agents. Shutdown should be graceful where possible, with a forceful termination fallback. The graceful-stop timeout and escalation policy remain to be specified.
- Agent lifecycle operations include create, modify settings, stop, restart, restart a subtree, replace an agent's session without its prior conversation context, and remove. Restarting one agent does not stop its descendants; restarting a subtree does.
- Agent states include `starting`, `running`, `idle`, `waiting`, `recovering`, `stopped`, and `failed`. Exact transitions and whether `running` and `idle` are separate states remain to be finalized. `stopped` and `failed` are terminal until an operator restarts or replaces the session.
- Agent settings changes that affect process launch (such as working directory or access policy) restart affected active agents; metadata-only changes should not. Modifications may use an expected revision to reject stale updates.
- Each agent has a prompt queue. By default, a new prompt supersedes that agent's active work and cancels its queued prompts; an explicit queue option appends it to that agent's FIFO queue. A global limit bounds concurrently active prompts. Queued work can be cancelled immediately; active work remains in progress until ACP confirms cancellation or the process is terminated.
- Lifecycle mutations are serialized through an organization-wide queue, but prompt execution does not hold that queue. Each process start has a generation identifier so late events from a replaced process cannot mutate current agent state or complete a newer operation.

## Protocols and client API

### Client connection

- Clients connect to a Unix domain socket.
- The API is line-delimited JSON: each request and response/event occupies one JSON line.
- The API will be defined by this project. It should support creating and managing agents, sending commands to agents, and receiving streamed events.
- Clients may subscribe to all events by default or filter subscriptions by event type (for example, excluding tool-update events) and by agent.
- Requests that start long-running work return an operation ID and current status; operations have a caller, target agent, type, status, and start/completion timestamps, with result or error information when complete. Initial statuses are `queued`, `running`, `completed`, `failed`, and `stopped`; the final three are terminal.
- Clients can query operation status and cancel operations. A request may wait briefly for completion, then return the still-running operation rather than cancelling it. The initial wait duration and exact cancellation behavior remain configurable design details.
- Agent events and operation changes use a monotonically increasing server sequence so clients can order them. Event categories should cover lifecycle, prompts, agent messages, tool calls/updates/results, plans, errors, and permission events; plugins may add event types.
- Exact request/response schemas, event names, reconnection behavior, and whether agent filters support subtrees are open design decisions. Decide whether to persist/replay events or offer live-only delivery; if replay is supported, define cursor expiry and snapshot/resync behavior.

### Agent communication

- Agent processes communicate with the server over stdin/stdout using ACP.
- ACP protocol behavior should follow the selected ACP package/specification.
- Harness-specific launch and integration behavior belongs in harness plugins.

### MCP interface

- Agents receive MCP tools that allow them to create and manage their own direct children and operate on their descendants according to the hierarchy rules.
- The initial demo requires a root agent to create child agents and coordinate their work.
- Exact tool names, schemas, permissions, and error behavior remain to be designed.

## Persistence, recovery, and limits

- Persist agent records, operations, and communication/event history so that removing an agent or replacing its session does not erase its history. Persistence technology and the retention policy remain open.
- On server restart, queued or running operations are marked interrupted/stopped rather than silently resumed. Recovery of agents is a separate policy decision; if enabled, start the root first and then descendants in parent-before-child order. Mark unrecoverable agents failed while continuing recovery of other descendants.
- Enforce configurable limits for organization depth, children per agent, concurrent agent processes, concurrent prompts, prompt size, stored response size, and event/history retention. Exact defaults and behavior at each limit remain to be specified.

## Plugin system

Plugins are trusted, in-process Bun/TypeScript packages with a stable server plugin API. Plugins may start or communicate with external processes when needed.

The plugin API should allow plugins to:

- Observe server and agent lifecycle/events.
- Customize agent process creation and lifecycle behavior, including command/arguments, environment variables, working directory, and optional isolation/containerization.
- Add client-facing API endpoints and corresponding behavior.
- Add MCP tools for agents.
- Provide agent harness integrations, including harness-specific ACP process setup or behavior.

The server should include or support separate harness plugins (initial examples: Claude and Codex), so agents using different harnesses can coexist in the same tree.

Plugin API stability is a requirement from the start. The precise extension hooks, plugin loading/discovery mechanism, versioning, and failure isolation policy remain to be designed.

## Process and workspace defaults

- Without a plugin changing the behavior, agents use the server's current working directory and environment.
- Plugins are the extension point for changing environment variables, working directories, containerization, and other process policies.
- Enforcing that child workspaces are subdirectories of parent workspaces is a possible plugin policy, not a built-in requirement for the initial version.
- Workspace deletion is not part of agent removal.

## Initial demonstration

Demonstrate the following end-to-end flow:

1. A client connects to the Unix socket and creates a root agent, selecting a harness, model, and startup options.
2. The client subscribes to events and sends a task to the root agent.
3. The root agent uses MCP tools to create two direct children, assigning one to write code and the other to write tests for a simple task.
4. The root coordinates the children and reports the result.
5. The client observes relevant lifecycle and agent events, with the ability to filter event types and agents.

## Open design decisions

- Exact JSONL request, response, error, and event schemas.
- Whether agent subscriptions select exact agent IDs, subtrees, or both.
- Event delivery and reconnection semantics: event/history records are persisted, but whether the live stream supports replay or is live-only remains open (the initial expectation is live-only). If replay is supported, define cursor expiry and snapshot/resync behavior.
- Graceful-stop timeout and force-termination behavior.
- Exact ACP package/specification and harness plugin interfaces.
- MCP tool names, schemas, and permission model.
- Plugin discovery, configuration, versioning, and error isolation.
- Persistence technology and retention policy; whether agent processes are automatically recovered across server restarts.
