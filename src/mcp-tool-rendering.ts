import type { EventRenderer, RenderContext, RenderLevels } from "./rendering.ts";
import { fenced, literalMarkdown, record, toolIdentity } from "./rendering.ts";
import type { ServerEvent } from "./types.ts";

export const MCP_TOOL_NAMES = ["create_subagent", "prompt_subagent", "get_subagent", "snapshot_organization", "stop_subagent", "restart_subagent", "restart_subagent_subtree", "replace_subagent_session", "remove_subagent", "modify_subagent", "get_completion", "get_operation", "wait_operation", "cancel_operation"] as const;
export type McpToolName = typeof MCP_TOOL_NAMES[number];
const labels: Record<McpToolName, string> = {
  create_subagent: "Create child", prompt_subagent: "Prompt", get_subagent: "Inspect agent", snapshot_organization: "Snapshot organization",
  stop_subagent: "Stop agent", restart_subagent: "Restart agent", restart_subagent_subtree: "Restart subtree", replace_subagent_session: "Replace session",
  remove_subagent: "Remove subtree", modify_subagent: "Modify agent", get_completion: "Inspect completion", get_operation: "Inspect operation", wait_operation: "Wait for operation", cancel_operation: "Cancel operation",
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
const oneLine = (value: unknown) => (typeof value === "string" ? value : pretty(value)).replace(/\s+/g, " ").trim();
const idFor = (input: Record<string, any>, key: string, missing: string) => typeof input[key] === "string" ? oneLine(input[key]) : missing;
const has = (value: object, key: string) => Object.hasOwn(value, key);
interface Decoded { domain: unknown; invocationError?: boolean; truncated: boolean; warning?: string; complete: boolean }
function storedTruncation(value: unknown, depth = 0): boolean {
  const data = record(value);
  return data.truncated === true || (depth < 8 && (has(data, "result") && storedTruncation(data.result, depth + 1) || has(data, "r") && storedTruncation(data.r, depth + 1)));
}
/** Decode one complete MCP JSON value. Mixed/multiple blocks remain literal, never a guessed result. */
export function decodeMcpOutput(event: Readonly<ServerEvent>, canonicalTool = toolIdentity(event)): Decoded {
  const data = record(event.data), raw = has(data, "rawOutput") ? data.rawOutput : data.content, outer = record(raw);
  const envelope = Array.isArray(outer.content);
  const contentBlocks = Array.isArray(raw) && raw.length > 0 && raw.every(item => typeof record(item).type === "string");
  const invocationError = envelope && outer.isError === true || undefined;
  if (data.truncated === true || outer.truncated === true || record(outer.details).truncation?.truncated === true)
    return { domain: raw, invocationError, truncated: true, complete: false, warning: "Output truncated; received preview only" };
  let domain: unknown = raw;
  if (typeof raw === "string" || envelope || contentBlocks || ["text", "content"].includes(outer.type)) {
    const texts: string[] = [];
    let valid = true, blocks = 0, bytes = 0;
    const collect = (value: unknown, depth = 0): void => {
      if (!valid) return;
      if (++blocks > 64 || depth > 8) { valid = false; return; }
      if (typeof value === "string") { bytes += Buffer.byteLength(value); if (bytes > 64 * 1024) valid = false; else texts.push(value); }
      else if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); }
      else {
        const block = record(value);
        if (block.type === "text" && typeof block.text === "string") collect(block.text, depth + 1);
        else if (block.type === "content" && block.content !== undefined) collect(block.content, depth + 1);
        else valid = false;
      }
    };
    collect(envelope ? outer.content : raw);
    if (valid && texts.length === 1) {
      try {
        domain = JSON.parse(texts[0]!);
        const pending = [{ value: domain, depth: 0 }];
        let nodes = 0;
        while (pending.length && valid) {
          const { value, depth } = pending.pop()!;
          if (++nodes > 4096 || depth > 64) { valid = false; break; }
          if (value && typeof value === "object") for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
        }
      } catch { valid = false; }
    } else valid = false;
    if (!valid) return { domain: raw, invocationError, truncated: false, complete: false, warning: "MCP output undecoded (invalid/mixed content or decoding budget); see received result" };
  }
  const d = record(domain);
  return { domain, invocationError, complete: d.truncated !== true, truncated: storedTruncation(domain) || canonicalTool === "get_operation" && d.t === true };
}
function domainState(tool: McpToolName, d: Record<string, any>): string | undefined {
  const value = tool === "get_completion" ? d.state ?? d.s : tool === "get_subagent" ? d.state : d.status ?? d.s;
  return typeof value === "string" ? oneLine(value) : undefined;
}
function domainDetails(tool: McpToolName, value: unknown, context: Readonly<RenderContext>): string[] {
  const d = record(value), result = record(has(d, "r") ? d.r : d.result), state = domainState(tool, d), details: string[] = [];
  if (state) details.push(`${tool === "get_completion" ? "Batch status" : tool === "get_subagent" ? "Agent state" : "Returned status"}: ${state}`);
  if (tool === "get_operation" && context.targetName) details.push(`Agent: ${oneLine(context.targetName)}`);
  if (tool === "get_operation" && typeof d.t === "boolean") details.push(`Result truncated: ${d.t ? "yes" : "no"}`);
  if (typeof d.cancelRequested === "boolean") details.push(`Cancellation requested: ${d.cancelRequested ? "yes" : "no"}`);
  if (d.error !== undefined) details.push(`Error: ${oneLine(d.error)}`);
  if (typeof d.code === "string" && typeof d.message === "string") details.push(`Error: ${d.code}: ${oneLine(d.message)}`);
  if (tool === "get_completion") {
    const entries = Array.isArray(d.items) ? d.items : Array.isArray(d.i) ? d.i : [];
    const total = d.total ?? d.t, cursor = d.next ?? d.n;
    if (d.suppressionReason !== undefined || d.q !== undefined) details.push(`Suppression: ${oneLine(d.suppressionReason ?? d.q)}`);
    if (total !== undefined) details.push(`Members on page: ${entries.length} of ${total}`);
    if (d.after !== undefined || d.a !== undefined) details.push(`Page starts at: ${d.after ?? d.a}`);
    if (entries.length) {
      details.push(`Member operations retained: ${entries.filter((item: unknown) => { const row = record(item); return row.resultAvailable === true || row.r === true; }).length}/${entries.length} (operation retention, not result bodies)`);
      details.push(`Member statuses: ${entries.slice(0, 8).map((item: unknown) => { const row = record(item); return oneLine(row.status ?? row.s ?? "unknown"); }).join(", ")}${entries.length > 8 ? ", …" : ""}`);
    }
    if (cursor !== undefined && cursor !== null) details.push(`Next cursor: ${oneLine(cursor)}`);
  } else if (tool === "snapshot_organization") {
    if (Array.isArray(d.agents)) details.push(`Agents: ${d.agents.length}`);
    if (Array.isArray(d.operations)) details.push(`Operations: ${d.operations.length}`);
    if (d.seq !== undefined) details.push(`Sequence: ${oneLine(d.seq)}`);
  } else {
    const operationId = typeof d.operationId === "string" ? d.operationId : typeof d.id === "string" && (typeof d.status === "string" || typeof d.type === "string") ? d.id : undefined;
    if (operationId) details.push(`Lifecycle operation: ${operationId}`);
    if (tool === "create_subagent" && typeof result.id === "string") details.push(`Child ID: ${result.id}`);
    if (tool === "get_subagent" || ["stop_subagent", "restart_subagent", "restart_subagent_subtree", "replace_subagent_session", "remove_subagent", "modify_subagent"].includes(tool)) {
      const agent = tool === "get_subagent" ? d : result;
      for (const key of ["state", "name", "revision", "sessionId", "sessionNumber", "removedAt", "generation"])
        if (agent[key] !== undefined && !(tool === "get_subagent" && key === "state")) details.push(`${key}: ${oneLine(agent[key])}`);
      const settings = record(agent.settings);
      for (const key of ["harness", "model", "provider"]) if (settings[key] !== undefined) details.push(`${key}: ${oneLine(settings[key])}`);
      if (tool === "remove_subagent") details.push("Workspaces/history retained");
    }
    if (["get_operation", "wait_operation", "cancel_operation"].includes(tool)) {
      if (d.type !== undefined) details.push(`Operation type: ${oneLine(d.type)}`);
      const available = typeof d.a === "boolean" ? d.a : typeof d.resultAvailable === "boolean" ? d.resultAvailable : has(d, "result") || has(d, "r");
      details.push(`Result available: ${available}`);
      // Arbitrary child answers stay in the fenced received/decoded sections, not compact previews.
    }
  }
  return details;
}
function subject(tool: McpToolName, input: Record<string, any>, context: Readonly<RenderContext>): { title: string; target?: string } {
  if (tool === "prompt_subagent") {
    const name = oneLine(context.targetName ?? idFor(input, "agentId", "[agent unavailable]")).slice(0, 254).replace(/[\uD800-\uDBFF]$/, "");
    const target = `@${name}`;
    return { title: `${target} ${typeof input.text === "string" && input.text.trim() ? oneLine(input.text) : "[prompt unavailable]"}`, target };
  }
  const args = tool === "snapshot_organization" ? input.includeTerminalOperations === false ? "active operations" : "all operations"
    : tool === "create_subagent" ? [input.name, record(input.settings).harness, record(input.settings).model].filter(value => typeof value === "string" && value).map(oneLine).join(" · ") || "child request"
    : tool === "get_completion" ? `batch ${idFor(input, "batchId", "[batch unavailable]")}`
    : ["get_operation", "wait_operation", "cancel_operation"].includes(tool) ? [idFor(input, "operationId", "[operation unavailable]"), tool === "get_operation" && context.targetName ? oneLine(context.targetName) : undefined].filter(Boolean).join(" · ")
    : `agent ${idFor(input, "agentId", "[agent unavailable]")}`;
  return { title: `${labels[tool]} · ${args}` };
}
export function renderMcpTool(tool: McpToolName, event: Readonly<ServerEvent>, context: Readonly<RenderContext> = {}): RenderLevels {
  const data = record(event.data), args = record(data.rawInput), decoded = decodeMcpOutput(event, tool);
  const domain = decoded.complete ? decoded.domain : undefined, d = record(domain);
  const state = domainState(tool, d), details = domainDetails(tool, domain, context);
  if (tool === "prompt_subagent") details.push(`Prompt policy: ${args.queue === true ? "queue" : "supersede"}`);
  if (tool === "modify_subagent") { details.push(`Changed fields: ${Object.keys(args).filter(key => !["agentId", "expectedRevision"].includes(key)).join(", ") || "none"}`); if (args.expectedRevision !== undefined) details.push(`Expected revision: ${args.expectedRevision}`); }
  if (decoded.warning) details.push(decoded.warning);
  if (decoded.truncated) details.unshift("[TRUNCATED]");
  const invocationError = decoded.invocationError || ["failed", "cancelled", "canceled"].includes(data.status);
  if (invocationError) details.unshift(`Invocation ${["cancelled", "canceled"].includes(data.status) ? "cancelled" : "failed"}`);
  if (data.status) details.push(`Tool invocation: ${String(data.status).replace(/_/g, " ")}`);
  const status = invocationError ? "failed invocation" : state ?? (data.status ? `${String(data.status).replace(/_/g, " ")} invocation` : "Status unavailable");
  const priority = [status, decoded.truncated && "[TRUNCATED]", decoded.warning && "[UNDECODED]", ...details.filter(text => !/^(Returned status:|Batch status:|Agent state:|Tool invocation:|Invocation |\[TRUNCATED\])/.test(text)).slice(0, 3)].filter(Boolean).join(" · ");
  const { title, target } = subject(tool, args, context), heading = literalMarkdown(title);
  const operationAgentTargets = tool === "get_operation" && context.targetName ? [context.targetName] : undefined;
  const identity = toolIdentity(event) ?? tool;
  const full = [heading, literalMarkdown(priority), `Tool: ${literalMarkdown(identity)}`, ...details.map(literalMarkdown),
    `Input:\n${fenced(pretty(data.rawInput), "json")}`, `Received result:\n${fenced(pretty(has(data, "rawOutput") ? data.rawOutput : data.content), "json")}`, `Decoded MCP value:\n${fenced(pretty(decoded.domain), "json")}`].join("\n\n");
  return { summary: heading, extended: `${heading}\n${literalMarkdown(priority)}`, full, updateMode: "semantic", extendedLayout: "header-detail", toolSymbol: "∴", ...(target && { toolTarget: target }), ...(operationAgentTargets && { toolTargets: operationAgentTargets }), ...(tool === "prompt_subagent" && { toolPrompt: typeof args.text === "string" ? args.text : "" }), invocationError };
}
const exampleInputs: Record<McpToolName, unknown> = {
  create_subagent:{name:"reviewer",settings:{harness:"pi",model:"provider/model"}}, prompt_subagent:{agentId:"child-1",text:"Review the implementation",queue:true}, get_subagent:{agentId:"child-1"}, snapshot_organization:{includeTerminalOperations:false}, stop_subagent:{agentId:"child-1"}, restart_subagent:{agentId:"child-1"}, restart_subagent_subtree:{agentId:"child-1"}, replace_subagent_session:{agentId:"child-1"}, remove_subagent:{agentId:"child-1"}, modify_subagent:{agentId:"child-1",expectedRevision:3,settings:{model:"provider/model"}}, get_completion:{batchId:"operation-1",after:0,limit:20}, get_operation:{operationId:"operation-1",resultOnly:true}, wait_operation:{operationId:"operation-1",waitMs:1000}, cancel_operation:{operationId:"operation-1"},
};
const exampleDomains: Record<McpToolName, { update: unknown; result: unknown }> = {
  create_subagent:{update:{id:"operation-1",type:"agent.create",status:"running",agentId:"parent-1"},result:{id:"operation-1",type:"agent.create",status:"completed",agentId:"parent-1",result:{id:"child-1",name:"reviewer"}}},
  prompt_subagent:{update:{id:"operation-2",type:"agent.prompt",status:"running",agentId:"child-1"},result:{id:"operation-2",type:"agent.prompt",status:"queued",agentId:"child-1"}},
  get_subagent:{update:{id:"child-1",name:"reviewer",state:"starting",revision:3,sessionNumber:1},result:{id:"child-1",name:"reviewer",state:"running",revision:3,sessionNumber:1,settings:{harness:"pi",model:"provider/model"}}},
  snapshot_organization:{update:{seq:41,agents:[{id:"parent-1"},{id:"child-1"}],operations:[{id:"operation-1",status:"running"}]},result:{seq:42,agents:[{id:"parent-1"},{id:"child-1"}],operations:[{id:"operation-1",status:"running"}]}},
  stop_subagent:{update:{id:"operation-3",status:"running",agentId:"child-1"},result:{id:"operation-3",status:"completed",agentId:"child-1",result:{state:"stopped"}}},
  restart_subagent:{update:{id:"operation-4",status:"running",agentId:"child-1"},result:{id:"operation-4",status:"completed",agentId:"child-1",result:{state:"running",generation:"generation-2"}}},
  restart_subagent_subtree:{update:{id:"operation-5",status:"running",agentId:"child-1"},result:{id:"operation-5",status:"completed",agentId:"child-1"}},
  replace_subagent_session:{update:{id:"operation-6",status:"running",agentId:"child-1"},result:{id:"operation-6",status:"completed",agentId:"child-1",result:{sessionId:"session-2",sessionNumber:2}}},
  remove_subagent:{update:{id:"operation-7",status:"running",agentId:"child-1"},result:{id:"operation-7",status:"completed",agentId:"child-1",result:{removedAt:"2026-01-01T00:00:00.000Z"}}},
  modify_subagent:{update:{id:"operation-8",status:"running",agentId:"child-1"},result:{id:"operation-8",status:"completed",agentId:"child-1",result:{revision:4}}},
  get_completion:{update:{b:"operation-9",s:"dispatching",t:2,a:0,n:1,i:[{x:0,o:"operation-8",g:"child-1",s:"running",r:false}]},result:{batchId:"operation-9",state:"ready",total:2,after:0,next:1,items:[{index:0,operationId:"operation-8",targetAgentId:"child-1",status:"completed",resultAvailable:true}]}},
  get_operation:{update:{a:true,s:"running",t:false,r:null},result:{a:true,s:"completed",t:false,r:{status:"completed"}}},
  wait_operation:{update:{id:"operation-8",type:"agent.modify",status:"running",cancelRequested:false},result:{id:"operation-8",type:"agent.modify",status:"completed",cancelRequested:false,result:{revision:4}}},
  cancel_operation:{update:{id:"operation-8",type:"agent.prompt",status:"running",cancelRequested:true},result:{id:"operation-8",type:"agent.prompt",status:"stopped",cancelRequested:true}},
};
function exampleData(tool: McpToolName, type: string): unknown {
  const invocationStatus = type === "tool.call" ? "pending" : type === "tool.update" ? "in_progress" : "completed";
  const domain = type === "tool.call" ? undefined : exampleDomains[tool][type === "tool.update" ? "update" : "result"];
  return { title: tool, status: invocationStatus, rawInput: structuredClone(exampleInputs[tool]), ...(domain !== undefined && { rawOutput:{content:[{type:"text",text:JSON.stringify(domain)}],isError:false} }) };
}
export function coreMcpRenderers(): EventRenderer[] {
  return MCP_TOOL_NAMES.map(tool => ({ id:`core.mcp-${tool.replace(/_/g,"-")}`, name:`${tool} · AgentOrg MCP`, tool, eventTypes:["tool.call","tool.update","tool.result"], updateMode:"semantic", examples:["tool.call","tool.update","tool.result"].map(type=>({type,data:exampleData(tool,type)})), render:(event, context)=>renderMcpTool(tool,event,context) }));
}
