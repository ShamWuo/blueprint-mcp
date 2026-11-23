import fs from "node:fs/promises";
import path from "node:path";
// Generated from packages/shared/src/lib/bkn-local-store.ts — see
// scripts/generate-mcp-local-store.mjs. Never hand-edit the generated file.
import { LocalBKNStore, toNodeKey } from "./local-store.generated.js";
import {
  runVerificationSpec,
  stripEmbeddingsFromPayload,
  listIntegrations,
  executeIntegration,
} from "./core.js";
import {
  connectFolder,
  disconnectFolder,
  listConnectedFolders,
  syncFolderToWorkspace,
} from "./folder-bridge.js";

/**
 * Projects a stored node into the shape MCP tool results expose. The store
 * speaks the portable vocabulary (`title`, `content`); MCP clients have always
 * received `name` / `description`, so the rename happens here, once.
 */
function toMcpNode(node) {
  return {
    id: node.id,
    name: node.title,
    title: node.title,
    label: node.label,
    description: node.content,
    content: node.content,
    status: node.status,
    confidence: node.confidence,
    tags: node.tags || [],
    properties: stripEmbeddingsFromPayload(node.properties || {}),
  };
}

/**
 * Creates an executor map bound to a local `.bkn` directory.
 */
export function createLocalStoreExecutors(baseDir = ".bkn") {
  const store = new LocalBKNStore(baseDir);

  return {
    bkn_list_workspaces: async () => {
      let workspaceName = "Local Workspace";
      let workspaceId = "local";
      try {
        const configRaw = await fs.readFile(store.configPath, "utf8");
        const cfg = JSON.parse(configRaw);
        if (cfg.workspaceName) workspaceName = cfg.workspaceName;
        if (cfg.workspaceId) workspaceId = cfg.workspaceId;
      } catch {}

      const workspaces = [
        {
          id: workspaceId,
          name: workspaceName,
          description: "Local File-Backed Workspace",
          mode: "local_filesystem",
          path: store.baseDir,
        },
      ];
      return Object.assign(workspaces, {
        workspaces,
        count: workspaces.length,
      });
    },

    bkn_create_workspace: async (_supabase, args = {}) => {
      await store.ensureDirectories();
      const cfg = {
        workspaceId: args.name ? String(args.name).toLowerCase().replace(/\s+/g, "-") : "local",
        workspaceName: args.name || "Local Workspace",
        description: args.description || "",
        template_id: args.template_id || null,
        created_at: new Date().toISOString(),
      };
      await fs.writeFile(store.configPath, JSON.stringify(cfg, null, 2), "utf8");
      const initialNodes = Array.isArray(args.initial_nodes) ? args.initial_nodes : [];
      for (const n of initialNodes) {
        if (n && n.name) {
          await store.saveNode({
            id: toNodeKey(n.name),
            title: n.name,
            label: n.label || "Concept",
            content: n.description || "",
            properties: n.metadata || {},
          });
        }
      }
      return {
        success: true,
        workspace: cfg,
        template_id: args.template_id || null,
        initial_nodes_count: initialNodes.length,
        message: `Local workspace '${cfg.workspaceName}' created at ${store.baseDir}.`,
      };
    },

    bkn_query_graph: async (_supabase, args = {}) => {
      const res = await store.queryGraph(args.query || "", args.label || "", args.limit || 50);
      const nodes = res.nodes.map(toMcpNode);
      const relationships = res.edges;
      return {
        nodes,
        relationships,
        count: nodes.length,
        relationship_count: relationships.length,
        summary: `Found ${nodes.length} nodes and ${relationships.length} edges in local .bkn store.`,
      };
    },

    bkn_ingest_content: async (_supabase, args = {}) => {
      const title = args.source_name || "Ingested Note";
      const id = String(title).toLowerCase().replace(/[^\w-]/g, "-");
      const node = await store.saveNode({
        id,
        title,
        label: "Resource",
        content: String(args.content || ""),
        tags: ["ingest", String(args.source_type || "manual")],
      });
      return {
        success: true,
        node_id: node.id,
        name: node.title || node.name,
        nodesInserted: 1,
        edgesInserted: 0,
        message: `Ingested '${node.title || node.id}' into local .bkn store.`,
      };
    },

    bkn_create_node: async (_supabase, args = {}) => {
      const name = args.name || "Untitled Node";
      const id = String(name).toLowerCase().replace(/[^\w-]/g, "-");
      const props = { ...(args.metadata || {}) };
      if (args.verification !== undefined && args.verification !== null) {
        props.verification = args.verification;
      }
      const node = await store.saveNode({
        id,
        title: name,
        label: args.label || "Concept",
        content: args.description || "",
        properties: props,
      });
      return { success: true, node_id: node.id, name: node.title || node.name, label: node.label };
    },

    bkn_link_nodes: async (_supabase, args = {}) => {
      const source = args.source_id || args.source_uuid || args.source_name || "";
      const target = args.target_id || args.target_uuid || args.target_name || "";
      const rel = args.relationship_type || args.edge_type || "relates_to";
      const edge = await store.saveEdge({
        id: "",
        source,
        target,
        type: rel,
        ...(args.description ? { properties: { note: args.description } } : {}),
      });
      return {
        success: true,
        edge_id: edge.id,
        source: edge.source,
        target: edge.target,
        source_name: edge.source,
        target_name: edge.target,
        type: rel,
      };
    },

    bkn_get_workspace_context: async () => {
      const text = await store.getWorkspaceContext();
      const allNodes = await store.listNodes();
      const tasks = allNodes.filter((n) => String(n.label).toLowerCase() === "task").map(toMcpNode);
      return {
        context: text,
        workspace: { id: "local", name: "Local Workspace", mode: "local_filesystem", path: store.baseDir },
        docs: { context_markdown: text },
        tasks,
        knowledge_nodes_sample: allNodes.slice(0, 25).map(toMcpNode),
      };
    },

    bkn_push_telemetry: async (_supabase, args = {}) => {
      return {
        success: true,
        event: args.event_name,
        status: "logged_locally",
        message: `Logged telemetry event '${args.event_name}' locally.`,
      };
    },

    bkn_mutate_variable: async (_supabase, args = {}) => {
      const node = await store.getNode(args.node_identifier);
      if (!node) {
        throw new Error(`Variable node '${args.node_identifier}' not found in local store.`);
      }
      node.properties = node.properties || {};
      const previousValue = node.properties.current_value ?? node.properties.value ?? null;
      const step = typeof args.amount === "number" && Number.isFinite(args.amount) ? args.amount : 1;
      const op = args.operation || "set";
      let currentValue;
      switch (op) {
        case "increment":
          currentValue = (typeof previousValue === "number" ? previousValue : Number(previousValue) || 0) + step;
          break;
        case "decrement":
          currentValue = (typeof previousValue === "number" ? previousValue : Number(previousValue) || 0) - step;
          break;
        case "toggle":
          currentValue = !(previousValue === true);
          break;
        case "reset":
          currentValue = typeof previousValue === "boolean" ? false : 0;
          break;
        default:
          currentValue = args.value;
          break;
      }
      node.properties.value = currentValue;
      node.properties.current_value = currentValue;
      await store.saveNode(node);
      return {
        success: true,
        node_id: node.id,
        node_uuid: node.id,
        node_name: node.title || node.id,
        operation: op,
        previous_value: previousValue,
        current_value: currentValue,
        new_value: currentValue,
        message: `Mutated variable '${node.title || node.id}': ${op} -> ${JSON.stringify(currentValue)}.`,
      };
    },

    bkn_delete_node: async (_supabase, args = {}) => {
      const key = toNodeKey(args.node_identifier || "");
      const edges = await store.listEdges();
      const connected = edges.filter((e) => e.source === key || e.target === key);
      for (const edge of connected) {
        await store.deleteEdge(edge.id);
      }
      const success = await store.deleteNode(args.node_identifier);
      return {
        success,
        deleted_id: args.node_identifier,
        node_identifier: args.node_identifier,
        node_uuid: key,
        relationships_removed: connected.length,
        message: success
          ? `Deleted node '${args.node_identifier}' and ${connected.length} edge(s).`
          : `Node '${args.node_identifier}' not found.`,
      };
    },

    bkn_unlink_nodes: async (_supabase, args = {}) => {
      // Edges are keyed by (source, type, target) with no stored id, so resolve
      // the matches first; omitting the type removes every link between the pair.
      const source = toNodeKey(args.source_name || "");
      const target = toNodeKey(args.target_name || "");
      const type = args.relationship_type;
      const matches = (await store.listEdges()).filter(
        (edge) => edge.source === source && edge.target === target && (!type || edge.type === type)
      );

      let success = false;
      for (const match of matches) {
        if (await store.deleteEdge(match.id)) success = true;
      }
      return {
        success,
        source_name: args.source_name || source,
        target_name: args.target_name || target,
        type: type ?? null,
        message: `Removed ${matches.length} relationship(s) between '${source}' and '${target}'.`,
      };
    },

    bkn_get_subgraph: async (_supabase, args = {}) => {
      const rootId = args.parent_uuid ?? args.root_node_name ?? args.root_node_id ?? null;
      const res = await store.queryGraph(rootId || "", undefined, 50);
      const nodes = res.nodes.map(toMcpNode);
      return {
        root_id: rootId,
        parent_uuid: rootId,
        nodes,
        count: nodes.length,
        edges: res.edges,
      };
    },

    bkn_get_related_nodes: async (_supabase, args = {}) => {
      const anchorRef = args.node ?? args.node_identifier ?? args.node_name ?? args.node_uuid ?? "";
      const anchorNode = await store.getNode(anchorRef);
      const anchorKey = anchorNode ? anchorNode.id : toNodeKey(anchorRef);
      const anchorName = anchorNode ? (anchorNode.title || anchorNode.id) : String(anchorRef);
      const allNodes = await store.listNodes();
      const nodeByKey = new Map(allNodes.map((n) => [n.id, n]));
      const allEdges = await store.listEdges();
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 25;

      const related = [];
      for (const edge of allEdges) {
        if (edge.source === anchorKey || edge.target === anchorKey) {
          const isOutgoing = edge.source === anchorKey;
          const peerKey = isOutgoing ? edge.target : edge.source;
          const peer = nodeByKey.get(peerKey);
          related.push({
            direction: isOutgoing ? "outgoing" : "incoming",
            relationship_type: edge.type,
            node_uuid: peerKey,
            name: peer ? (peer.title || peer.id) : peerKey,
            label: peer ? peer.label : "Concept",
            description: peer ? peer.content : "",
          });
          if (related.length >= limit) break;
        }
      }

      return {
        success: true,
        node_uuid: anchorKey,
        node_name: anchorName,
        related,
        count: related.length,
      };
    },

    agent_traverse_node: async (_supabase, args = {}) => {
      const targetRef = args.target_node_uuid || args.target_node_name || args.node_name || "";
      const node = await store.getNode(targetRef);
      const toUuid = node ? node.id : String(targetRef);
      return {
        success: true,
        agent_id: args.agent_id || "local-agent",
        from_node_uuid: null,
        to_node_uuid: toUuid,
        reason: args.reason || "",
        node: node ? toMcpNode(node) : null,
        message: `Agent traversed to '${node ? (node.title || node.id) : toUuid}'.`,
      };
    },

    bkn_emit_signal: async (_supabase, args = {}) => {
      const title = args.title || args.signal_name || "Signal";
      const severity = args.severity || "info";
      const propagationMode = args.propagation_mode || "local";
      const signalUuid = `sig-${toNodeKey(title)}`;
      return {
        success: true,
        signal_uuid: signalUuid,
        title,
        signal: title,
        severity,
        propagation_mode: propagationMode,
        payload: args.payload,
        message: `Signal '${title}' emitted locally [${severity}].`,
      };
    },

    bkn_resolve_signal: async (_supabase, args = {}) => {
      const signalUuid = args.signal_uuid || args.signal_id || "sig-local";
      return {
        success: true,
        signal_id: signalUuid,
        signal_uuid: signalUuid,
        resolution_note: args.resolution_note || "",
        resolved_at: new Date().toISOString(),
        message: `Signal '${signalUuid}' resolved locally.`,
      };
    },

    bkn_list_signals: async () => {
      return { signals: [], count: 0 };
    },

    bkn_agent_boost: async (_supabase, args = {}) => {
      const allNodes = await store.listNodes();
      const allEdges = await store.listEdges();
      const invariants = [];
      const decisions = [];
      const contracts = [];
      const executableContracts = [];

      for (const n of allNodes) {
        if (n.properties?.is_superseded === true) continue;
        const l = String(n.label || "").toLowerCase();
        const verSpec = n.properties?.verification || n.properties?.facets?.verification;
        if (verSpec) {
          executableContracts.push({
            node_name: n.title || n.id,
            label: n.label,
            spec: verSpec,
          });
        }
        if (l === "rule" || l === "principle") {
          invariants.push({ rule: n.title || n.id, statement: n.content || "" });
        } else if (l === "decision") {
          decisions.push({ decision: n.title || n.id, rationale: n.content || "" });
        } else if (l === "concept" || l === "resource" || l === "component") {
          contracts.push({ name: n.title || n.id, kind: l, description: n.content || "" });
        }
      }

      const task = args.task || "General Code Task";
      const mdSections = [
        `# 🛡️ ARCHITECTURAL BOOST BRIEF: ${task}`,
        `> Grounded by Local Blueprint Knowledge Network (\`${store.baseDir}\`, ${allNodes.length} nodes, ${allEdges.length} edges)`,
        "",
        "## 1. Non-Negotiable Invariants & Rules (MUST PRESERVE)",
        ...invariants.slice(0, 25).map((r) => `- **\`${r.rule}\`**: ${r.statement}`),
        "",
        "## 2. Key Architecture Decisions & Rationale",
        ...decisions.slice(0, 25).map((d) => `- **\`${d.decision}\`**: ${d.rationale}`),
      ];

      return {
        success: true,
        task,
        workspace_id: "local",
        governing_invariants: invariants,
        decisions,
        contracts,
        executable_contracts: executableContracts,
        prompt_injection_markdown: mdSections.join("\n"),
      };
    },

    bkn_write_file: async (_supabase, args = {}) => {
      const targetPath = path.resolve(args.path);
      const content = String(args.content || "");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
      const sizeBytes = Buffer.byteLength(content);
      const lineCount = content.length === 0 ? 0 : content.split("\n").length;
      return {
        success: true,
        path: args.path,
        node_id: toNodeKey(args.path),
        bytes: sizeBytes,
        size_bytes: sizeBytes,
        line_count: lineCount,
      };
    },

    bkn_read_file: async (_supabase, args = {}) => {
      const targetPath = path.resolve(args.path);
      const content = await fs.readFile(targetPath, "utf8");
      const sizeBytes = Buffer.byteLength(content);
      const lineCount = content.length === 0 ? 0 : content.split("\n").length;
      return {
        success: true,
        path: args.path,
        content,
        language: args.language || "text",
        size_bytes: sizeBytes,
        line_count: lineCount,
        node_id: toNodeKey(args.path),
      };
    },

    bkn_edit_file: async (_supabase, args = {}) => {
      const targetPath = path.resolve(args.path);
      let content = await fs.readFile(targetPath, "utf8");
      const targetStr = args.target ?? args.old_str;
      const replacementStr = args.replacement ?? args.new_str ?? "";
      if (targetStr && content.includes(targetStr)) {
        let replacementsMade = 1;
        if (args.all) {
          const parts = content.split(targetStr);
          replacementsMade = parts.length - 1;
          content = parts.join(replacementStr);
        } else {
          content = content.replace(targetStr, replacementStr);
        }
        await fs.writeFile(targetPath, content, "utf8");
        const newSizeBytes = Buffer.byteLength(content);
        const newLineCount = content.length === 0 ? 0 : content.split("\n").length;
        return {
          success: true,
          path: args.path,
          modified: true,
          replacements_made: replacementsMade,
          new_size_bytes: newSizeBytes,
          new_line_count: newLineCount,
        };
      }
      throw new Error(`Target text to replace not found in ${args.path}`);
    },

    bkn_list_files: async (_supabase, args = {}) => {
      const dirPath = path.resolve(args.directory || ".");
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const files = entries.map((e) => ({
        name: e.name,
        path: path.join(args.directory || ".", e.name),
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      }));
      return {
        success: true,
        directory: args.directory || ".",
        count: files.length,
        files,
      };
    },

    bkn_verify_node: async (_supabase, args = {}) => {
      const nodeName = args.node || args.node_name || args.node_identifier || "test_node";
      const node = await store.getNode(nodeName);
      const spec = args.spec || node?.properties?.verification;
      if (spec) {
        const res = await runVerificationSpec(spec, {
          filesChanged: args.files_changed || [],
          node: node
            ? { uuid: node.id, name: node.title || node.id, label: node.label, properties: node.properties }
            : { uuid: nodeName, name: nodeName, label: "Rule" },
        });
        return {
          success: true,
          node_name: node?.title || nodeName,
          verified: res.passed,
          duration_ms: res.durationMs,
          diagnostics: res.diagnostics,
          result: res,
        };
      }
      return {
        success: true,
        node_name: nodeName,
        verified: true,
        duration_ms: 1,
        diagnostics: `[Local Mode] Node '${nodeName}' has no executable contract; marked verified.`
      };
    },

    bkn_verify_workspace: async (_supabase, args = {}) => {
      const allNodes = await store.listNodes();
      const targetLabels = Array.isArray(args.labels) && args.labels.length > 0
        ? args.labels.map((l) => String(l).toLowerCase())
        : null;
      const verifiable = allNodes.filter((n) => {
        if (targetLabels && !targetLabels.includes(String(n.label || "").toLowerCase())) return false;
        return Boolean(n.properties?.verification);
      });
      if (verifiable.length === 0) {
        return {
          success: true,
          all_passed: true,
          total_contracts: 0,
          passed_contracts: 0,
          failed_contracts: 0,
          diagnostics: "[Local Mode] No active executable verification contracts found in local store."
        };
      }
      const nodeResults = [];
      let passedContracts = 0;
      let failedContracts = 0;
      for (const n of verifiable) {
        const res = await runVerificationSpec(n.properties.verification, {
          filesChanged: args.files_changed || [],
          node: { uuid: n.id, name: n.title || n.id, label: n.label, properties: n.properties },
        });
        if (res.passed) passedContracts++;
        else failedContracts++;
        nodeResults.push({
          node_name: n.title || n.id,
          label: n.label,
          verified: res.passed,
          duration_ms: res.durationMs,
          diagnostics: res.diagnostics,
        });
      }
      return {
        success: true,
        all_passed: failedContracts === 0,
        total_contracts: verifiable.length,
        passed_contracts: passedContracts,
        failed_contracts: failedContracts,
        diagnostics: `${passedContracts} of ${verifiable.length} verification contracts passed (${failedContracts} failed).`,
        node_results: nodeResults,
      };
    },

    bkn_list_integrations: async (supabase, args = {}) =>
      listIntegrations(
        supabase,
        args.workspace_id || "local",
        args.query || "",
        args.category || "",
        args.include_recipes ?? true
      ),

    bkn_execute_integration: async (supabase, args = {}) =>
      executeIntegration(
        supabase,
        args.workspace_id || "local",
        args.action,
        args.arguments || {},
        {
          userId: args.user_id,
          connectedAccountId: args.connected_account_id,
          ingestToGraph: args.ingest_to_graph === true,
        }
      ),

    bkn_connect_folder: async (_supabase, args = {}) =>
      connectFolder({
        folderPath: args.path,
        workspaceId: args.workspace_id || "local",
        workspaceName: args.workspace_name,
        include: args.include,
        ignore: args.ignore,
        maxFileSizeBytes: args.max_file_size_bytes,
      }),

    bkn_disconnect_folder: async (_supabase, args = {}) =>
      disconnectFolder({
        folderPath: args.path,
      }),

    bkn_list_folders: async () => listConnectedFolders(),

    bkn_sync_folder: async (_supabase, args = {}) =>
      syncFolderToWorkspace({
        folderPath: args.path,
        workspaceId: args.workspace_id || "local",
        dryRun: args.dry_run === true,
        force: args.force === true,
        writeFileFn: async (fileArgs) => {
          const content = String(fileArgs.content || "");
          const sizeBytes = Buffer.byteLength(content, "utf8");
          const lineCount = content.split("\n").length;
          const node = await store.upsertNode({
            title: fileArgs.path,
            label: "Resource",
            content,
            properties: {
              path: fileArgs.path,
              language: fileArgs.language || "text",
              size_bytes: sizeBytes,
              line_count: lineCount,
              is_code_file: true,
            },
          });
          return {
            success: true,
            path: fileArgs.path,
            node_id: node.id,
            size_bytes: sizeBytes,
            line_count: lineCount,
          };
        },
      }),
  };
}
