/**
 * Self-hosted executor map — the `--local` mirror of the hosted handler's
 * context (`apps/web/src/lib/mcp/messages-handler.ts`).
 *
 * The hosted endpoint and this bundle are the same MCP server over two
 * transports, so the split of "advertised tools" / "callable extras" / "tools
 * that only make sense against a local checkout" must match the contract exactly
 * (`src/contract.ts`); `src/__tests__/contract.test.ts` fails if it stops
 * matching. Each entry returns the canonical result keys for its tool.
 *
 * Transport concerns (JSON-RPC framing, argument validation) live in
 * `blueprint-mcp.js`; this file is pure tool dispatch, which is also what the
 * tool runner (`blueprint-cli.js`) uses.
 */
import {
  listWorkspaces,
  createWorkspace,
  getWorkspaceContext,
  queryGraph,
  createNode,
  linkNodes,
  applyPatch,
  ingestContent,
  pushTelemetry,
  getSubgraph,
  getRelatedNodes,
  deleteNode,
  unlinkNodes,
  mutateVariable,
  traverseAgentNode,
  stationAgent,
  emitSignal,
  resolveSignal,
  listSignals,
  writeFileNode,
  readFileNode,
  editFileNode,
  listFileNodes,
  getHotPath,
  logDecision,
  updateKnowledge,
  submitProposal,
  agentBoost,
  verifyNode,
  verifyWorkspace,
  listIntegrations,
  executeIntegration,
} from "./core.js";
import {
  connectFolder,
  disconnectFolder,
  listConnectedFolders,
  syncFolderToWorkspace,
} from "./folder-bridge.js";

/** Every advertised tool, in contract order. */
export const LOCAL_ADVERTISED_EXECUTORS = {
  bkn_list_workspaces: (supabase, args = {}) => listWorkspaces(supabase, args.limit || 10),

  bkn_create_workspace: (supabase, args = {}) =>
    createWorkspace(supabase, args.name, args.description, {
      problem_statement: args.problem_statement,
      target_audience: args.target_audience,
      technologies: args.technologies,
      scope: args.scope,
      key_features: args.key_features,
      work_mode: args.work_mode,
      created_by: args.created_by,
      template_id: args.template_id,
      initial_nodes: args.initial_nodes,
    }),

  bkn_query_graph: (supabase, args = {}) =>
    queryGraph(supabase, args.workspace_id, args.query, args.label, args.limit || 50, Boolean(args.verbose)),

  bkn_ingest_content: (supabase, args = {}) =>
    ingestContent(
      supabase,
      args.workspace_id,
      args.content,
      args.source_name || "mcp_external_app",
      args.source_type || "mcp_ingest"
    ),

  bkn_get_related_nodes: (supabase, args = {}) =>
    getRelatedNodes(
      supabase,
      args.workspace_id,
      args.node ?? args.node_identifier ?? args.node_name ?? args.node_uuid,
      args.limit || 25
    ),

  bkn_create_node: (supabase, args = {}) =>
    createNode(
      supabase,
      args.workspace_id,
      args.name,
      args.label,
      args.description,
      args.metadata || {},
      args.node_class,
      args.verification
    ),

  bkn_link_nodes: (supabase, args = {}) =>
    linkNodes(
      supabase,
      args.workspace_id,
      args.source_id || args.source_uuid || args.source_name,
      args.target_id || args.target_uuid || args.target_name,
      args.relationship_type || args.edge_type,
      args.description || "",
      args.properties
    ),

  bkn_apply_patch: (supabase, args = {}) =>
    applyPatch(supabase, args.workspace_id, args.nodes || [], args.edges || []),

  bkn_get_workspace_context: (supabase, args = {}) =>
    getWorkspaceContext(
      supabase,
      args.workspace_id,
      args.include_docs ?? true,
      args.include_tasks ?? true
    ),

  bkn_push_telemetry: (supabase, args = {}) =>
    pushTelemetry(
      supabase,
      args.workspace_id,
      args.event_name,
      args.payload || {},
      args.severity || "info"
    ),

  bkn_mutate_variable: (supabase, args = {}) =>
    mutateVariable(
      supabase,
      args.workspace_id,
      args.node_identifier,
      args.operation,
      args.amount ?? null,
      args.value
    ),

  bkn_delete_node: (supabase, args = {}) =>
    deleteNode(supabase, args.workspace_id, args.node_identifier),

  bkn_unlink_nodes: (supabase, args = {}) =>
    unlinkNodes(
      supabase,
      args.workspace_id,
      args.source_name,
      args.target_name,
      args.relationship_type ?? null
    ),

  bkn_get_subgraph: (supabase, args = {}) =>
    getSubgraph(supabase, args.workspace_id, args.parent_uuid ?? null),

  agent_traverse_node: (supabase, args = {}) =>
    traverseAgentNode(
      supabase,
      args.workspace_id,
      args.target_node_uuid,
      args.reason || "",
      args.agent_id ?? null
    ),

  bkn_emit_signal: (supabase, args = {}) =>
    emitSignal(supabase, args.workspace_id, {
      title: args.title || args.signal_name,
      targetNodeUuid: args.target_node_uuid ?? null,
      severity: args.severity || "info",
      signalType: args.signal_type || "agent_alert",
      description: args.description || "",
      propagationMode: args.propagation_mode || "local",
      payload: args.payload || {},
      isPersistent: args.is_persistent === true,
    }),

  bkn_resolve_signal: (supabase, args = {}) =>
    resolveSignal(supabase, args.signal_uuid || args.signal_id, args.resolution_note || ""),

  bkn_list_signals: (supabase, args = {}) =>
    listSignals(supabase, args.workspace_id, args.target_node_uuid ?? null, args.limit ?? 50),

  bkn_write_file: (supabase, args = {}) =>
    writeFileNode(
      supabase,
      args.workspace_id,
      args.path,
      args.content,
      args.language,
      args.description,
      args.label
    ),

  bkn_read_file: (supabase, args = {}) =>
    readFileNode(supabase, args.workspace_id, args.path),

  bkn_edit_file: (supabase, args = {}) =>
    editFileNode(
      supabase,
      args.workspace_id,
      args.path,
      args.target,
      args.replacement,
      args.all
    ),

  bkn_list_files: (supabase, args = {}) =>
    listFileNodes(supabase, args.workspace_id, args.directory),

  bkn_verify_node: (supabase, args = {}) =>
    verifyNode(
      supabase,
      args.workspace_id,
      args.node || args.node_name || args.node_uuid,
      args.files_changed || [],
      args.custom_spec || null
    ),

  bkn_verify_workspace: (supabase, args = {}) =>
    verifyWorkspace(
      supabase,
      args.workspace_id,
      args.label || null,
      args.limit || 20
    ),

  bkn_list_integrations: (supabase, args = {}) =>
    listIntegrations(
      supabase,
      args.workspace_id,
      args.query || "",
      args.category || "",
      args.include_recipes ?? true
    ),

  bkn_execute_integration: (supabase, args = {}) =>
    executeIntegration(
      supabase,
      args.workspace_id,
      args.action,
      args.arguments || {},
      {
        userId: args.user_id,
        connectedAccountId: args.connected_account_id,
        ingestToGraph: args.ingest_to_graph === true,
      }
    ),

  bkn_connect_folder: (_supabase, args = {}) =>
    connectFolder({
      folderPath: args.path,
      workspaceId: args.workspace_id,
      workspaceName: args.workspace_name,
      include: args.include,
      ignore: args.ignore,
      maxFileSizeBytes: args.max_file_size_bytes,
    }),

  bkn_disconnect_folder: (_supabase, args = {}) =>
    disconnectFolder({
      folderPath: args.path,
    }),

  bkn_list_folders: () => listConnectedFolders(),

  bkn_sync_folder: (supabase, args = {}) =>
    syncFolderToWorkspace({
      folderPath: args.path,
      workspaceId: args.workspace_id,
      dryRun: args.dry_run === true,
      force: args.force === true,
      writeFileFn: (fileArgs) =>
        writeFileNode(
          supabase,
          fileArgs.workspace_id,
          fileArgs.path,
          fileArgs.content,
          fileArgs.language
        ),
    }),
};

/** Callable but unadvertised, in both modes (see `MCP_EXTRA_TOOL_EXECUTORS`). */
export const LOCAL_EXTRA_EXECUTORS = {
  agent_station: (supabase, args = {}) =>
    stationAgent(
      supabase,
      args.workspace_id,
      args.agent_id,
      args.home_node_uuid ?? null,
      args.current_node_uuid ?? null
    ),
  bkn_agent_boost: (supabase, args = {}) =>
    agentBoost(
      supabase,
      args.workspace_id,
      args.task,
      args.target_entity || args.target_service
    ),
};

/**
 * Self-hosted only: these read the local checkout (`kernel/AGENTS.md`,
 * `kernel/notes/notes.md`) instead of the graph, so they cannot exist on the
 * hosted endpoint. Never advertised, so the advertised set stays identical in
 * both modes.
 */
export const LOCAL_REPO_TOOL_EXECUTORS = {
  get_hot_path: () => getHotPath(),
  log_decision: (_supabase, args = {}) =>
    logDecision(args.decision, args.outcome, args.owner || "Antigravity"),
  update_knowledge: (_supabase, args = {}) => updateKnowledge(args.filename, args.content),
  submit_proposal: (supabase, args = {}) =>
    submitProposal(
      supabase,
      args.workspace_id,
      args.title,
      args.description,
      args.contracts,
      args.test_plans,
      args.files_to_modify || []
    ),
};

/** Everything this bundle can execute, advertised or not. */
export const LOCAL_TOOL_EXECUTORS = {
  ...LOCAL_ADVERTISED_EXECUTORS,
  ...LOCAL_EXTRA_EXECUTORS,
  ...LOCAL_REPO_TOOL_EXECUTORS,
};
