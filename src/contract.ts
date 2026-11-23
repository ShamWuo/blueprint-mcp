import { MCP_TOOLS, type MCPToolDefinition } from "./tools";

/**
 * The MCP contract, in one place.
 *
 * The package ships two transports for the same server:
 *
 *  - the hosted endpoint (`apps/web` → `handleMCPRequest`), reached by
 *    `blueprint-nexus-mcp --key …`, and
 *  - the self-hosted bundle (`bin/blueprint-mcp.js`), reached by `--local`.
 *
 * They had drifted: the hosted side announced a different server name, the local
 * side advertised a 12-tool list that shared only 8 names with the hosted 16, and
 * eight advertised tools were stubs on one side or the other (`-32603 "not
 * configured"`, or a placeholder echo of the arguments). A client that switched
 * modes got a different server.
 *
 * Everything that defines the contract therefore lives here: identity, the
 * advertised tool list (`MCP_TOOLS` — one definition, both modes), which handler
 * key executes each tool, and the result keys every executor must return.
 * `src/__tests__/contract.test.ts` pins the plain-JS local bundle to this file
 * through the generated `bin/tool-contract.json`, so the two cannot drift again.
 */

/**
 * Server identity reported in the `initialize` handshake. Both modes must answer
 * with exactly this; the version tracks `package.json` (a test enforces it).
 */
export const MCP_SERVER_INFO = {
  name: "blueprint-nexus-mcp",
  version: "0.1.0",
} as const;

/** Protocol revision the hosted handler answers with. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** The advertised tool set. Identical in hosted and self-hosted mode. */
export const MCP_ADVERTISED_TOOLS: MCPToolDefinition[] = MCP_TOOLS;

/** Handler that executes each advertised tool. */
export interface MCPExecutorMap {
  executeListWorkspaces: (params: any) => Promise<any>;
  executeCreateWorkspace: (params: any) => Promise<any>;
  executeQueryGraph: (params: any) => Promise<any>;
  executeIngestContent: (params: any) => Promise<any>;
  executeCreateNode: (params: any) => Promise<any>;
  executeLinkNodes: (params: any) => Promise<any>;
  executeApplyPatch: (params: any) => Promise<any>;
  executeGetWorkspaceContext: (params: any) => Promise<any>;
  executePushTelemetry: (params: any) => Promise<any>;
  executeMutateVariable: (params: any) => Promise<any>;
  executeDeleteNode: (params: any) => Promise<any>;
  executeUnlinkNodes: (params: any) => Promise<any>;
  executeGetSubgraph: (params: any) => Promise<any>;
  executeGetRelatedNodes: (params: any) => Promise<any>;
  executeTraverseNode: (params: any) => Promise<any>;
  executeEmitSignal: (params: any) => Promise<any>;
  executeResolveSignal: (params: any) => Promise<any>;
  executeListSignals: (params: any) => Promise<any>;
  executeStationAgent: (params: any) => Promise<any>;
  executeAgentBoost: (params: any) => Promise<any>;
  executeWriteFile: (params: any) => Promise<any>;
  executeReadFile: (params: any) => Promise<any>;
  executeEditFile: (params: any) => Promise<any>;
  executeListFiles: (params: any) => Promise<any>;
  executeVerifyNode: (params: any) => Promise<any>;
  executeVerifyWorkspace: (params: any) => Promise<any>;
  executeListIntegrations: (params: any) => Promise<any>;
  executeExecuteIntegration: (params: any) => Promise<any>;
  executeConnectFolder: (params: any) => Promise<any>;
  executeDisconnectFolder: (params: any) => Promise<any>;
  executeListFolders: (params: any) => Promise<any>;
  executeSyncFolder: (params: any) => Promise<any>;
}

export type MCPExecutorKey = keyof MCPExecutorMap;

/**
 * Advertised tool → executor. Every advertised tool must appear here: a tool in
 * `MCP_TOOLS` with no executor is a promise the server cannot keep, which is
 * exactly how the two modes diverged before.
 */
export const MCP_TOOL_EXECUTORS: Record<string, MCPExecutorKey> = {
  bkn_list_workspaces: "executeListWorkspaces",
  bkn_create_workspace: "executeCreateWorkspace",
  bkn_query_graph: "executeQueryGraph",
  bkn_ingest_content: "executeIngestContent",
  bkn_create_node: "executeCreateNode",
  bkn_link_nodes: "executeLinkNodes",
  bkn_apply_patch: "executeApplyPatch",
  bkn_get_workspace_context: "executeGetWorkspaceContext",
  bkn_push_telemetry: "executePushTelemetry",
  bkn_mutate_variable: "executeMutateVariable",
  bkn_delete_node: "executeDeleteNode",
  bkn_unlink_nodes: "executeUnlinkNodes",
  bkn_get_subgraph: "executeGetSubgraph",
  bkn_get_related_nodes: "executeGetRelatedNodes",
  agent_traverse_node: "executeTraverseNode",
  bkn_emit_signal: "executeEmitSignal",
  bkn_resolve_signal: "executeResolveSignal",
  bkn_list_signals: "executeListSignals",
  bkn_write_file: "executeWriteFile",
  bkn_read_file: "executeReadFile",
  bkn_edit_file: "executeEditFile",
  bkn_list_files: "executeListFiles",
  bkn_verify_node: "executeVerifyNode",
  bkn_verify_workspace: "executeVerifyWorkspace",
  bkn_list_integrations: "executeListIntegrations",
  bkn_execute_integration: "executeExecuteIntegration",
  bkn_connect_folder: "executeConnectFolder",
  bkn_disconnect_folder: "executeDisconnectFolder",
  bkn_list_folders: "executeListFolders",
  bkn_sync_folder: "executeSyncFolder",
};

/**
 * Callable but unadvertised: `agent_station` predates the advertised set and is
 * reachable through the SDK (`client.stationAgent`). Kept in both modes so an
 * SDK caller behaves the same either way, but not advertised in either.
 */
export const MCP_EXTRA_TOOL_EXECUTORS: Record<string, MCPExecutorKey> = {
  agent_station: "executeStationAgent",
  bkn_agent_boost: "executeAgentBoost",
};

/**
 * Tools that only exist in self-hosted mode, because they read the local
 * checkout (`kernel/AGENTS.md`, `kernel/notes/notes.md`) rather than the graph.
 * They are callable by name but are never advertised, so the advertised set stays
 * identical across both transports.
 */
export const MCP_REPO_LOCAL_TOOL_NAMES = [
  "get_hot_path",
  "log_decision",
  "update_knowledge",
  "submit_proposal",
] as const;

/**
 * Canonical result keys per tool. Both modes must return at least these top-level
 * keys for a successful call — the value shapes are free, the contract is not.
 * `src/__tests__/canonical-results.test.ts` drives every executor on both sides
 * against these lists.
 */
export const MCP_TOOL_RESULT_KEYS: Record<string, readonly string[]> = {
  bkn_list_workspaces: ["workspaces", "count"],
  bkn_create_workspace: ["success", "workspace", "initial_nodes_count", "message"],
  bkn_query_graph: ["nodes", "relationships", "count", "relationship_count"],
  bkn_ingest_content: ["success", "message", "nodesInserted", "edgesInserted"],
  bkn_create_node: ["success", "node_id", "name", "label"],
  bkn_link_nodes: ["success", "source_name", "target_name", "type"],
  bkn_apply_patch: ["success", "nodes_upserted", "edges_linked", "nodes", "edges", "message"],
  bkn_get_workspace_context: ["workspace", "docs", "tasks", "knowledge_nodes_sample"],
  bkn_push_telemetry: ["success", "message"],
  bkn_mutate_variable: [
    "success",
    "node_uuid",
    "node_name",
    "operation",
    "previous_value",
    "current_value",
    "message",
  ],
  bkn_delete_node: [
    "success",
    "node_identifier",
    "node_uuid",
    "relationships_removed",
    "message",
  ],
  bkn_unlink_nodes: ["success", "source_name", "target_name", "type", "message"],
  bkn_get_subgraph: ["nodes", "count", "parent_uuid"],
  bkn_get_related_nodes: ["success", "node_uuid", "node_name", "related", "count"],
  agent_traverse_node: [
    "success",
    "agent_id",
    "from_node_uuid",
    "to_node_uuid",
    "reason",
    "message",
  ],
  bkn_emit_signal: ["success", "signal_uuid", "title", "severity", "propagation_mode", "message"],
  bkn_resolve_signal: [
    "success",
    "signal_uuid",
    "resolution_note",
    "resolved_at",
    "message",
  ],
  bkn_list_signals: ["signals", "count"],
  agent_station: ["success", "agent_id", "home_node_uuid", "current_node_uuid", "message"],
  bkn_agent_boost: ["success", "task", "workspace_id", "prompt_injection_markdown"],
  bkn_write_file: ["success", "path", "node_id", "size_bytes", "line_count"],
  bkn_read_file: ["success", "path", "content", "language", "size_bytes", "line_count", "node_id"],
  bkn_edit_file: ["success", "path", "replacements_made", "new_size_bytes", "new_line_count"],
  bkn_list_files: ["success", "count", "files"],
  bkn_verify_node: ["success", "node_name", "verified", "duration_ms", "diagnostics"],
  bkn_verify_workspace: ["success", "total_contracts", "passed_contracts", "failed_contracts", "diagnostics"],
  bkn_list_integrations: ["success", "connected_integrations", "count", "recipes", "catalog_matches"],
  bkn_execute_integration: ["success", "action", "resolved_slug", "data", "ingested_nodes_count", "message"],
  bkn_connect_folder: ["success", "folder_path", "workspace_id", "workspace_name", "message"],
  bkn_disconnect_folder: ["success", "folder_path", "disconnected", "message"],
  bkn_list_folders: ["success", "count", "folders"],
  bkn_sync_folder: ["success", "folder_path", "workspace_id", "dry_run", "total_scanned", "synced_count", "skipped_count", "failed_count"],
};

/** Missing required keys for `tool`, or an empty array when the result conforms. */
export function missingResultKeys(tool: string, result: unknown): string[] {
  const required = MCP_TOOL_RESULT_KEYS[tool];
  if (!required) return [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [...required];
  }
  const payload = result as Record<string, unknown>;
  return required.filter((key) => !(key in payload));
}
