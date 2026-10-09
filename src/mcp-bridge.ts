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
      "Manage your direct children and coordinate descendants. Lifecycle and prompt calls return operations: wait/query to obtain results. You cannot manage ancestors, siblings, or yourself. Keep a prompt slot free for descendants while waiting.",
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
