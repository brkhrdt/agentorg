import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { OrganizationClient } from "./client.ts";

// The capability is issued by the server, not accepted from tool arguments.
const socket = process.env.ORG_SOCKET,
  token = process.env.ORG_TOKEN;
if (!socket || !token) throw new Error("ORG_SOCKET and ORG_TOKEN are required");
const client = await OrganizationClient.connect(socket, token);
const server = new Server(
  { name: "agent-organization", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Coordinate adjacent agents. prompt_subagent targets an immediate child only; relay deeper work through each child. Neither direction permits skipping a level. Agent snapshots show only the non-removed parent (if any) and direct non-removed children, excluding self; stopped/failed records remain visible. They contain no parentId or operations, and do not grant inspection/lifecycle/operation authority. Every authenticated agent-origin prompt includes a descriptive `@{issuer display name}` prefix inserted by core; send the intended body without manually prefixing it. Client prompts remain unprefixed. The mention is not an ACP role or authorization signal. Use get_completion for your own batch metadata and get_operation for authorized original results. Fire-and-return avoids prompt-slot dependency cycles; keep a prompt slot free for subagents while waiting, since queued parent work can deadlock if that parent waits on the child."
  },
);
server.setRequestHandler(ListToolsRequestSchema, () =>
  client.request<ListToolsResult>("mcp.list"),
);
server.setRequestHandler(CallToolRequestSchema, (request) =>
  client.request<CallToolResult>("mcp.call", {
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  }),
);
await server.connect(new StdioServerTransport());
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  client.close();
  await server.close();
};
process.stdin.on("end", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
