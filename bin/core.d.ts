/**
 * Types for the self-hosted data layer (`core.js`). The result keys here are the
 * canonical ones from `src/contract.ts` — kept in step with
 * `MCP_TOOL_RESULT_KEYS` and asserted by `src/__tests__/canonical-results.test.ts`.
 */
export const BKN_LEAN_NODE_COLUMNS: string;
export function stripEmbeddingsFromPayload<T>(value: T): T;
export function getSupabaseClient(): any;
export function validateApiKey(supabase: any, apiKey?: string): Promise<any>;
export function resolveWorkspaceId(supabase: any, preferredWorkspaceId?: string): Promise<string>;
export function listWorkspaces(supabase: any, limit?: number): Promise<{ workspaces: any[]; count: number }>;
export function createWorkspace(
  supabase: any,
  name?: string,
  description?: string,
  options?: Record<string, any>
): Promise<{ success: boolean; workspace: any; initial_nodes_count: number; message: string }>;
export function getWorkspaceContext(
  supabase: any,
  workspaceIdInput?: string,
  includeDocs?: boolean,
  includeTasks?: boolean
): Promise<{
  workspace: { name: string; description: string } | null;
  docs: { executive_summary: string; technical_spec: string } | null;
  tasks: { epics: any; milestones: any } | null;
  knowledge_nodes_sample: Array<{ name: string; label: string; description: string }>;
}>;
export function queryGraph(
  supabase: any,
  workspaceIdInput?: string,
  query?: string,
  label?: string,
  limit?: number
): Promise<{ nodes: any[]; relationships: any[]; count: number; relationship_count: number }>;
export function createNode(
  supabase: any,
  workspaceIdInput?: string,
  name?: string,
  label?: string,
  description?: string,
  metadata?: any
): Promise<{ success: boolean; node_id: string; name: string; label: string }>;
export function linkNodes(
  supabase: any,
  workspaceIdInput?: string,
  sourceName?: string,
  targetName?: string,
  relationshipType?: string,
  description?: string
): Promise<{ success: boolean; source_name: string; target_name: string; type: string }>;
export function ingestContent(
  supabase: any,
  workspaceIdInput?: string,
  content?: string,
  sourceName?: string,
  sourceType?: string
): Promise<{ success: boolean; message: string; nodesInserted: number; edgesInserted: number }>;
export function pushTelemetry(
  supabase: any,
  workspaceIdInput?: string,
  eventName?: string,
  payload?: any,
  severity?: string
): Promise<{ success: boolean; message: string }>;
export function getSubgraph(
  supabase: any,
  workspaceIdInput?: string,
  parentUuid?: string | null
): Promise<{ nodes: any[]; count: number; parent_uuid: string | null }>;
export function deleteNode(
  supabase: any,
  workspaceIdInput?: string,
  nodeIdentifier?: string
): Promise<{
  success: boolean;
  node_identifier: string;
  node_uuid: string | null;
  relationships_removed: number;
  message: string;
}>;
export function unlinkNodes(
  supabase: any,
  workspaceIdInput?: string,
  sourceName?: string,
  targetName?: string,
  relationshipType?: string | null
): Promise<{
  success: boolean;
  source_name: string;
  target_name: string;
  type: string | null;
  message: string;
}>;
export function mutateVariable(
  supabase: any,
  workspaceIdInput?: string,
  nodeIdentifier?: string,
  operation?: string,
  amount?: number | null,
  value?: any
): Promise<{
  success: boolean;
  node_uuid: string;
  node_name: string;
  operation: string;
  previous_value: any;
  current_value: any;
  message: string;
}>;
export function traverseAgentNode(
  supabase: any,
  workspaceIdInput?: string,
  targetNodeUuid?: string,
  reason?: string,
  agentId?: string | null
): Promise<{
  success: boolean;
  agent_id: string;
  from_node_uuid: string | null;
  to_node_uuid: string;
  reason: string;
  message: string;
}>;
export function stationAgent(
  supabase: any,
  workspaceIdInput?: string,
  agentId?: string,
  homeNodeUuid?: string | null,
  currentNodeUuid?: string | null
): Promise<{
  success: boolean;
  agent_id: string;
  home_node_uuid: string | null;
  current_node_uuid: string | null;
  message: string;
}>;
export function emitSignal(
  supabase: any,
  workspaceIdInput?: string,
  options?: Record<string, any>
): Promise<{
  success: boolean;
  signal_uuid: string;
  title: string;
  severity: string;
  propagation_mode: string;
  message: string;
}>;
export function resolveSignal(
  supabase: any,
  signalUuid?: string,
  resolutionNote?: string
): Promise<{
  success: boolean;
  signal_uuid: string;
  resolution_note: string;
  resolved_at: string;
  message: string;
}>;
export function listSignals(
  supabase: any,
  workspaceIdInput?: string,
  targetNodeUuid?: string | null,
  limit?: number
): Promise<{ signals: any[]; count: number }>;
export function getHotPath(): Promise<{ agents: string; identity: string; summary: string }>;
/** @param options.rootDir Base directory for kernel writes (defaults to the checkout; refused during test runs). */
export function logDecision(decision: string, outcome: string, owner?: string, options?: { rootDir?: string }): Promise<{ success: boolean; date: string; decision: string; notesPath: string; bknNodeKey?: string | null }>;
export function updateKnowledge(filename: string, content: string, options?: { rootDir?: string }): Promise<{ success: boolean; file: string; path: string }>;
export function submitProposal(supabase: any, workspaceIdInput?: string, title?: string, description?: string, contracts?: string, testPlans?: string, filesToModify?: string[]): Promise<any>;
export function listIntegrations(
  supabase: any,
  workspaceIdInput?: string,
  query?: string,
  category?: string,
  includeRecipes?: boolean
): Promise<{
  success: boolean;
  workspace_id: string;
  connected_integrations: string[];
  count: number;
  recipes: any[];
  catalog_matches: any[];
}>;
export function executeIntegration(
  supabase: any,
  workspaceIdInput?: string,
  action?: string,
  rawArgs?: Record<string, any>,
  options?: { userId?: string; connectedAccountId?: string; ingestToGraph?: boolean }
): Promise<{
  success: boolean;
  action: string;
  resolved_slug: string;
  data: any;
  ingested_nodes_count: number;
  message: string;
}>;

