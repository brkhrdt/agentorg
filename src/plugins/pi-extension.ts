import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicitly loaded into each pi --mode rpc process by the ACP adapter. */
export default function organizationExtension(pi: ExtensionAPI) {
  const { ORG_SOCKET, ORG_TOKEN, ORG_MCP_BRIDGE, ORG_BUN, ORG_AGENT_ID } =
    process.env;
  if (!ORG_SOCKET || !ORG_TOKEN || !ORG_MCP_BRIDGE || !ORG_BUN) return;
  pi.registerMcpServer("organization", {
    command: ORG_BUN,
    args: [ORG_MCP_BRIDGE],
    env: { ORG_SOCKET, ORG_TOKEN },
    exposure: "direct",
    timeout: 60,
    description:
      "Create your own child agents, assign tasks, wait for operation results, and coordinate your subtree.",
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      `\nYour organization agent ID is ${ORG_AGENT_ID}. Use the organization MCP tools to delegate work. child_create returns an operation; wait for completion to get result.id. descendant_prompt returns a prompt operation; wait for completion to read result.text. Never use subagent extensions or launch pi yourself to delegate.`,
  }));
}
