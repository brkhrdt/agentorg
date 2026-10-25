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
      "Coordinate adjacent agents. prompt_subagent targets an immediate child only; relay deeper work through each child. prompt_parent targets your implicit direct parent only when explicitly instructed to message/report upward (never send unsolicited updates), defaults to queue=true, and returns immediately; root agents receive NO_PARENT. Neither direction permits skipping a level. Snapshots show full-tree agent records, but operation visibility and completion metadata remain scoped. Server-generated parent-completion notifications are distinct from explicit prompt_parent messages. Fire-and-return avoids prompt-slot dependency cycles."
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
