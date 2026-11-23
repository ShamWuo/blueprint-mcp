export * from "./tools";
export * from "./contract";
export * from "./handler";

export interface BlueprintClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class BlueprintMCPClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: BlueprintClientOptions) {
    this.apiKey = options.apiKey;
    // Default to the hosted service: `new BlueprintMCPClient({ apiKey })` is the
    // documented first call, and defaulting to localhost made it fail for anyone
    // who was not already running the stack. Self-hosters pass `baseUrl`.
    this.baseUrl = (options.baseUrl || "https://www.bluesc.org").replace(/\/$/, "");
  }

  private async request(method: string, params?: Record<string, any>) {
    const res = await fetch(`${this.baseUrl}/api/mcp/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MCP Request Failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`MCP Error (${data.error.code}): ${data.error.message}`);
    }

    return data.result;
  }

  async callTool(name: string, args: Record<string, any>) {
    return this.request("tools/call", { name, arguments: args });
  }

  async listWorkspaces(limit: number = 10) {
    return this.callTool("bkn_list_workspaces", { limit });
  }

  async createWorkspace(name: string, description?: string, options?: Record<string, any>) {
    return this.callTool("bkn_create_workspace", { name, description, ...options });
  }

  async queryGraph(query?: string, label?: string, limit: number = 50) {
    return this.callTool("bkn_query_graph", { query, label, limit });
  }

  async ingestContent(content: string, sourceName: string = "external_app", sourceType: string = "mcp_sdk") {
    return this.callTool("bkn_ingest_content", { content, source_name: sourceName, source_type: sourceType });
  }

  async createNode(name: string, label: string, description: string, metadata?: Record<string, any>, nodeClass?: string) {
    return this.callTool("bkn_create_node", { name, label, description, metadata, node_class: nodeClass });
  }

  async linkNodes(sourceName: string, targetName: string, relationshipType: string, description?: string) {
    return this.callTool("bkn_link_nodes", { source_name: sourceName, target_name: targetName, relationship_type: relationshipType, description });
  }

  async getWorkspaceContext(includeDocs: boolean = true, includeTasks: boolean = true) {
    return this.callTool("bkn_get_workspace_context", { include_docs: includeDocs, include_tasks: includeTasks });
  }

  async pushTelemetry(eventName: string, payload: Record<string, any>, severity: string = "info") {
    return this.callTool("bkn_push_telemetry", { event_name: eventName, severity, payload });
  }

  async mutateVariable(
    nodeIdentifier: string,
    operation: "increment" | "decrement" | "set" | "toggle" | "reset",
    options?: { amount?: number; value?: any; workspaceId?: string }
  ) {
    return this.callTool("bkn_mutate_variable", {
      node_identifier: nodeIdentifier,
      operation,
      amount: options?.amount,
      value: options?.value,
      workspace_id: options?.workspaceId,
    });
  }

  async getSubgraph(parentUuid?: string | null, workspaceId?: string) {
    return this.callTool("bkn_get_subgraph", { parent_uuid: parentUuid, workspace_id: workspaceId });
  }

  async traverseNode(targetNodeUuid: string, reason?: string, agentId?: string) {
    return this.callTool("agent_traverse_node", { target_node_uuid: targetNodeUuid, reason, agent_id: agentId });
  }

  async stationAgent(agentId: string, homeNodeUuid?: string, currentNodeUuid?: string) {
    return this.callTool("agent_station", { agent_id: agentId, home_node_uuid: homeNodeUuid, current_node_uuid: currentNodeUuid });
  }

  async emitSignal(options: {
    title: string;
    targetNodeUuid?: string;
    severity?: "info" | "warning" | "critical" | "success";
    signalType?: string;
    description?: string;
    propagationMode?: "local" | "downstream" | "upstream" | "broadcast";
    payload?: Record<string, any>;
    isPersistent?: boolean;
    workspaceId?: string;
  }) {
    return this.callTool("bkn_emit_signal", {
      title: options.title,
      target_node_uuid: options.targetNodeUuid,
      severity: options.severity,
      signal_type: options.signalType,
      description: options.description,
      propagation_mode: options.propagationMode,
      payload: options.payload,
      is_persistent: options.isPersistent,
      workspace_id: options.workspaceId,
    });
  }

  async resolveSignal(signalUuid: string, resolutionNote?: string) {
    return this.callTool("bkn_resolve_signal", {
      signal_uuid: signalUuid,
      resolution_note: resolutionNote,
    });
  }

  async listSignals(options?: { targetNodeUuid?: string; limit?: number; workspaceId?: string }) {
    return this.callTool("bkn_list_signals", {
      target_node_uuid: options?.targetNodeUuid,
      limit: options?.limit,
      workspace_id: options?.workspaceId,
    });
  }

  async writeFile(
    path: string,
    content: string,
    options?: { language?: string; description?: string; label?: string; workspaceId?: string }
  ) {
    return this.callTool("bkn_write_file", {
      path,
      content,
      language: options?.language,
      description: options?.description,
      label: options?.label,
      workspace_id: options?.workspaceId,
    });
  }

  async readFile(path: string, options?: { workspaceId?: string }) {
    return this.callTool("bkn_read_file", {
      path,
      workspace_id: options?.workspaceId,
    });
  }

  async editFile(
    path: string,
    target: string,
    replacement: string,
    options?: { all?: boolean; workspaceId?: string }
  ) {
    return this.callTool("bkn_edit_file", {
      path,
      target,
      replacement,
      all: options?.all,
      workspace_id: options?.workspaceId,
    });
  }

  async listFiles(options?: { directory?: string; workspaceId?: string }) {
    return this.callTool("bkn_list_files", {
      directory: options?.directory,
      workspace_id: options?.workspaceId,
    });
  }

  async listIntegrations(options?: {
    workspaceId?: string;
    query?: string;
    category?: string;
    includeRecipes?: boolean;
  }) {
    return this.callTool("bkn_list_integrations", {
      workspace_id: options?.workspaceId,
      query: options?.query,
      category: options?.category,
      include_recipes: options?.includeRecipes,
    });
  }

  async executeIntegration(
    action: string,
    args?: Record<string, any>,
    options?: {
      workspaceId?: string;
      userId?: string;
      connectedAccountId?: string;
      ingestToGraph?: boolean;
    }
  ) {
    return this.callTool("bkn_execute_integration", {
      action,
      arguments: args || {},
      workspace_id: options?.workspaceId,
      user_id: options?.userId,
      connected_account_id: options?.connectedAccountId,
      ingest_to_graph: options?.ingestToGraph,
    });
  }

  async connectFolder(
    path: string,
    options?: {
      workspaceId?: string;
      workspaceName?: string;
      include?: string[];
      ignore?: string[];
      maxFileSizeBytes?: number;
    }
  ) {
    return this.callTool("bkn_connect_folder", {
      path,
      workspace_id: options?.workspaceId,
      workspace_name: options?.workspaceName,
      include: options?.include,
      ignore: options?.ignore,
      max_file_size_bytes: options?.maxFileSizeBytes,
    });
  }

  async disconnectFolder(path: string) {
    return this.callTool("bkn_disconnect_folder", { path });
  }

  async listFolders() {
    return this.callTool("bkn_list_folders", {});
  }

  async syncFolder(
    path: string,
    options?: { workspaceId?: string; dryRun?: boolean; force?: boolean }
  ) {
    return this.callTool("bkn_sync_folder", {
      path,
      workspace_id: options?.workspaceId,
      dry_run: options?.dryRun,
      force: options?.force,
    });
  }
}

