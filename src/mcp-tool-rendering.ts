import type { EventRenderer, RenderLevels } from "./rendering.ts";
import { fenced, record, toolIdentity } from "./rendering.ts";
import type { ServerEvent } from "./types.ts";

export const MCP_TOOL_NAMES = ["create_subagent", "prompt_subagent", "get_subagent", "snapshot_organization", "stop_subagent", "restart_subagent", "restart_subagent_subtree", "replace_subagent_session", "remove_subagent", "modify_subagent", "get_completion", "get_operation", "wait_operation", "cancel_operation"] as const;
export type McpToolName = typeof MCP_TOOL_NAMES[number];
const labels: Record<McpToolName, string> = { create_subagent:"Create child", prompt_subagent:"Prompt", get_subagent:"Inspect agent", snapshot_organization:"Snapshot organization", stop_subagent:"Stop agent", restart_subagent:"Restart agent", restart_subagent_subtree:"Restart subtree", replace_subagent_session:"Replace session", remove_subagent:"Remove subtree", modify_subagent:"Modify agent", get_completion:"Inspect completion", get_operation:"Inspect operation", wait_operation:"Wait for operation", cancel_operation:"Cancel operation" };
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
const oneLine = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : pretty(value).replace(/\s+/g, " ").trim();
const idFor = (input: Record<string, any>, key: string, missing: string) => typeof input[key] === "string" ? input[key] : missing;
interface Decoded { domain: unknown; invocationError?: boolean; truncated: boolean; warning?: string }
/** Decode only complete, bounded MCP text values; never parse a truncated preview as JSON. */
export function decodeMcpOutput(event: Readonly<ServerEvent>): Decoded {
  const data = record(event.data), raw = data.rawOutput ?? data.content;
  const truncated = data.truncated === true || record(raw).truncated === true || record(record(raw).details).truncation?.truncated === true;
  if (truncated) return { domain: raw, invocationError: record(raw).isError === true || undefined, truncated: true, warning: "Output truncated; displayed preview only" };
  let texts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") { texts.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    const obj = record(value);
    if (obj.type === "text" && typeof obj.text === "string") texts.push(obj.text);
    else if (Array.isArray(obj.content)) collect(obj.content);
  };
  collect(raw);
  if (!texts.length) return { domain: raw, invocationError: record(raw).isError === true || undefined, truncated: false };
  const domains: unknown[] = [], fallback: string[] = [];
  for (const text of texts) {
    if (Buffer.byteLength(text) > 64 * 1024) { fallback.push(text.slice(0, 16 * 1024)); continue; }
    try { domains.push(JSON.parse(text)); } catch { fallback.push(text); }
  }
  if (fallback.length) return { domain: raw, invocationError: record(raw).isError === true || undefined, truncated: false, warning: "MCP output could not be fully decoded; showing received content" };
  const domain = domains.length === 1 ? domains[0] : domains;
  const domainRecord = record(domain), resultRecord = record(domainRecord.r ?? domainRecord.result);
  const projectedTruncation = (domainRecord.t === true && toolIdentity(event) === "get_operation") || domainRecord.truncated === true || resultRecord.truncated === true;
  return { domain, invocationError: record(raw).isError === true || undefined, truncated: projectedTruncation };
}
function domainDetails(tool: McpToolName, value: unknown): string[] {
  const d = record(value), result = record(d.r ?? d.result), state = typeof d.s === "string" ? d.s : typeof d.status === "string" ? d.status : undefined;
  const details: string[] = [];
  if (state) details.push(`Returned status: ${state}`);
  if (tool === "get_operation" && typeof d.t === "boolean") details.push(`Result truncated: ${d.t ? "yes" : "no"}`);
  if (d.cancelRequested === true || d.cancelRequested === false) details.push(`Cancellation requested: ${d.cancelRequested ? "yes" : "no"}`);
  if (d.error) details.push(`Error: ${oneLine(d.error)}`);
  if (tool === "create_subagent") {
    const childId = typeof result.id === "string" ? result.id : typeof d.childId === "string" ? d.childId : undefined;
    if (childId) details.push(`Child ID: ${childId}`);
    const operationId = typeof d.operationId === "string" ? d.operationId : typeof d.id === "string" ? d.id : undefined;
    if (operationId) details.push(`Lifecycle operation: ${operationId}${state ? ` (${state})` : ""}`);
  } else if (tool === "get_subagent") {
    for (const k of ["name", "state", "revision", "sessionNumber", "removedAt"] as const) if (d[k] !== undefined) details.push(`${k}: ${oneLine(d[k])}`);
  } else if (tool === "snapshot_organization") {
    for (const k of ["seq", "agentCount", "operationCount", "activeOperationCount"] as const) if (d[k] !== undefined) details.push(`${k}: ${oneLine(d[k])}`);
    if (Array.isArray(d.agents)) details.push(`Agents: ${d.agents.length}`);
    if (Array.isArray(d.operations)) details.push(`Operations: ${d.operations.length}`);
  } else if (tool === "replace_subagent_session") {
    for (const k of ["sessionId", "sessionNumber", "state", "generation"] as const) if (d[k] !== undefined) details.push(`${k}: ${oneLine(d[k])}`);
  } else if (tool === "remove_subagent") {
    if (d.removedAt !== undefined) details.push(`Removed at: ${oneLine(d.removedAt)}`);
    if (d.workspaceRetained !== undefined) details.push(`Workspace retained: ${d.workspaceRetained}`);
  } else if (tool === "get_operation" || tool === "wait_operation") {
    for (const k of ["type", "status", "cancelRequested"] as const) if (d[k] !== undefined) details.push(`${k}: ${oneLine(d[k])}`);
    if (d.resultAvailable !== undefined || d.a !== undefined) details.push(`Result available: ${d.resultAvailable ?? d.a}`);
    if (d.result !== undefined || d.r !== undefined) details.push(`Result: ${oneLine(d.result ?? d.r).slice(0, 180)}`);
  } else if (tool === "get_completion") {
    const entries = Array.isArray(d.items) ? d.items : Array.isArray(d.i) ? d.i : [];
    if (state) details.push(`Batch status: ${state}`);
    const total = d.total ?? d.t, cursor = d.next ?? d.n;
    if (total !== undefined) details.push(`Members on page: ${entries.length} of ${total}`);
    if (d.after !== undefined || d.a !== undefined) details.push(`Page starts at: ${d.after ?? d.a}`);
    if (entries.length) details.push(`Member results retained: ${entries.filter((item: unknown) => { const row = record(item); return row.resultAvailable === true || row.r === true; }).length}/${entries.length}`);
    if (cursor !== undefined && cursor !== null) details.push(`Next cursor: ${oneLine(cursor)}`);
    if (d.suppressionReason !== undefined || d.q !== undefined) details.push(`Suppression: ${oneLine(d.suppressionReason ?? d.q)}`);
  }
  return details;
}
function subject(tool: McpToolName, input: Record<string, any>): string {
  const args = tool === "snapshot_organization" ? (input.includeTerminalOperations === false ? "active operations" : "all operations")
    : tool === "create_subagent" ? [input.name, record(input.settings).harness, record(input.settings).model].filter(Boolean).join(" · ") || "child request"
    : tool === "prompt_subagent" ? `${idFor(input,"agentId","[agent unavailable]")}${input.queue === true ? " · queue" : " · supersede"}`
    : tool === "get_completion" ? `batch ${idFor(input,"batchId","[batch unavailable]")}`
    : ["get_operation","wait_operation","cancel_operation"].includes(tool) ? `operation ${idFor(input,"operationId","[operation unavailable]")}`
    : `agent ${idFor(input,"agentId","[agent unavailable]")}`;
  return `${labels[tool]} · ${args}`;
}
export function renderMcpTool(tool: McpToolName, event: Readonly<ServerEvent>): RenderLevels {
  const data = record(event.data), input = data.rawInput, decoded = decodeMcpOutput(event), args = record(input), details = domainDetails(tool, decoded.domain);
  if (decoded.warning) details.unshift(decoded.warning);
  if (decoded.truncated) details.unshift("[TRUNCATED]");
  if (decoded.invocationError || data.status === "failed" || data.status === "cancelled") details.unshift(`Invocation ${data.status === "cancelled" ? "cancelled" : "failed"}`);
  if (data.status) details.push(`Tool invocation: ${String(data.status).replace(/_/g, " ")}`);
  const title = subject(tool, args);
  const detail = details.slice(0, 4).join(" · ") || "No additional status available";
  const full = [`Tool: ${toolIdentity(event) ?? tool}`, title, ...details, `Input:\n${fenced(pretty(input), "json")}`, `Received result:\n${fenced(pretty(data.rawOutput ?? data.content), "json")}`, `Decoded MCP value:\n${fenced(pretty(decoded.domain), "json")}`].join("\n\n");
  return { summary: title, extended: `${title}\n${detail}`, full, updateMode: "semantic", extendedLayout: "header-detail" };
}
function exampleData(tool: McpToolName, type: string): unknown {
  const inputs: Record<McpToolName, unknown> = {
    create_subagent:{ name:"reviewer", settings:{ harness:"pi", model:"provider/model" } }, prompt_subagent:{ agentId:"child-1", text:"Inspect the implementation", queue:true }, get_subagent:{agentId:"child-1"}, snapshot_organization:{includeTerminalOperations:false}, stop_subagent:{agentId:"child-1"}, restart_subagent:{agentId:"child-1"}, restart_subagent_subtree:{agentId:"child-1"}, replace_subagent_session:{agentId:"child-1"}, remove_subagent:{agentId:"child-1"}, modify_subagent:{agentId:"child-1",expectedRevision:3,settings:{model:"provider/model"}}, get_completion:{batchId:"operation-1",after:0,limit:20}, get_operation:{operationId:"operation-1",resultOnly:true}, wait_operation:{operationId:"operation-1",waitMs:1000}, cancel_operation:{operationId:"operation-1"},
  };
  const domain: Record<string, unknown> = tool === "create_subagent" ? { operationId:"operation-1",status:"running",agentId:"parent-1" } : tool === "get_operation" ? {a:true,s:"running",t:false,r:{progress:"working"}} : tool === "get_completion" ? {b:"operation-1",s:"ready",t:2,a:1,n:1,i:[{x:"prompt-1",o:"operation-2",s:"completed",r:true}]} : {status: type === "tool.call" ? "queued" : "running", count:2};
  return { title: tool, status: type === "tool.call" ? "pending" : type === "tool.update" ? "in_progress" : "completed", rawInput: inputs[tool], ...(type !== "tool.call" && { rawOutput:{content:[{type:"text",text:JSON.stringify(domain)}],isError:false} }) };
}
export function coreMcpRenderers(): EventRenderer[] {
  return MCP_TOOL_NAMES.map(tool => ({ id:`core.mcp-${tool.replace(/_/g,"-")}`, name:`${tool} · AgentOrg MCP`, tool, eventTypes:["tool.call","tool.update","tool.result"], updateMode:"semantic", examples:["tool.call","tool.update","tool.result"].map(type=>({type,data:exampleData(tool,type)})), render:event=>renderMcpTool(tool,event) }));
}
