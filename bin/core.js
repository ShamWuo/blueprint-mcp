import { createClient } from "@supabase/supabase-js";
import childProcess from "child_process";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { LocalBKNStore, toNodeKey } from "./local-store.generated.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

// Helper to parse .env file without external dependencies if needed
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.error(`[blueprint-mcp] Warning loading env file ${filePath}:`, err.message);
  }
}

// Ensure env variables are loaded
loadEnvFile(path.join(repoRoot, "apps/web/.env.local"));
loadEnvFile(path.join(repoRoot, ".env"));

export function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
  }
  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

let cachedApiKeyData = null;

export async function validateApiKey(supabase, apiKey) {
  if (!apiKey) return null;
  const trimmed = apiKey.trim();
  if (cachedApiKeyData && cachedApiKeyData.rawKey === trimmed) {
    return cachedApiKeyData;
  }
  try {
    const keyHash = crypto.createHash("sha256").update(trimmed).digest("hex");
    const { data: rpcData, error: rpcErr } = await supabase.rpc("validate_workspace_api_key", { p_key_hash: keyHash });
    if (!rpcErr && rpcData && rpcData.length > 0) {
      const record = rpcData[0];
      cachedApiKeyData = { rawKey: trimmed, record };
      void Promise.resolve(
        supabase.from("workspace_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", record.id)
      ).catch(() => {});
      return cachedApiKeyData;
    }
    const { data: directData } = await supabase.from("workspace_api_keys").select("*").eq("key_hash", keyHash).maybeSingle();
    if (directData) {
      cachedApiKeyData = { rawKey: trimmed, record: directData };
      void Promise.resolve(
        supabase.from("workspace_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", directData.id)
      ).catch(() => {});
      return cachedApiKeyData;
    }
  } catch (err) {
    console.error("[blueprint-mcp] Error validating API key:", err.message);
  }
  return null;
}

/**
 * The workspace this checkout is bound to, from `.bkn/config.json`.
 *
 * Local-first is the common case for this repository, and the binding is an
 * explicit statement of intent — unlike "most recently updated workspace",
 * which answers a different question. Falling back to that heuristic silently
 * returned an empty graph instead of an error.
 */
function readBoundWorkspaceId() {
  const candidates = [
    path.join(repoRoot, ".bkn", "config.json"),
    path.join(process.cwd(), ".bkn", "config.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof config?.workspaceId === "string" && config.workspaceId) {
        return config.workspaceId;
      }
    } catch (err) {
      console.warn(`Ignoring unreadable workspace binding at ${file}:`, err?.message ?? err);
    }
  }
  return null;
}

export async function resolveWorkspaceId(supabase, preferredWorkspaceId) {
  if (preferredWorkspaceId) return preferredWorkspaceId;

  const boundWorkspaceId = readBoundWorkspaceId();
  if (boundWorkspaceId) return boundWorkspaceId;

  if (process.env.BLUEPRINT_WORKSPACE_ID) return process.env.BLUEPRINT_WORKSPACE_ID;

  // Check if an API key is provided via env var
  const apiKey = process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
  if (apiKey) {
    const validated = await validateApiKey(supabase, apiKey);
    if (validated?.record?.workspace_id) {
      return validated.record.workspace_id;
    }
  }

  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, updated_at, created_at")
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(10);

  if (error || !data || data.length === 0) {
    throw new Error("No workspaces found in database. Pass workspace_id explicitly.");
  }
  if (data.length === 1) return data[0].id;

  // Guessing here is worse than failing: a wrong workspace returns an empty
  // graph, which reads as "the knowledge does not exist" rather than as a
  // scoping mistake, and every retry repeats it.
  const visible = data.map((row) => `${row.name ?? "(unnamed)"} — ${row.id}`).join("; ");
  throw new Error(
    `workspace_id is required: ${data.length} workspaces are visible (${visible}). ` +
      "Pass workspace_id, set BLUEPRINT_WORKSPACE_ID, or work in a checkout with a .bkn/config.json binding."
  );
}

export async function listWorkspaces(supabase, limit = 10) {
  const apiKey = process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
  let boundWsId = process.env.BLUEPRINT_WORKSPACE_ID;
  if (!boundWsId && apiKey) {
    const validated = await validateApiKey(supabase, apiKey);
    if (validated?.record?.workspace_id) {
      boundWsId = validated.record.workspace_id;
    }
  }

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, name, description, created_at, updated_at")
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw error;

  let list = workspaces ? [...workspaces] : [];
  if (boundWsId) {
    const existingIdx = list.findIndex((w) => w.id === boundWsId);
    if (existingIdx > 0) {
      const [target] = list.splice(existingIdx, 1);
      list.unshift(target);
    } else if (existingIdx === -1) {
      const { data: ws } = await supabase
        .from("workspaces")
        .select("id, name, description, created_at, updated_at")
        .eq("id", boundWsId)
        .maybeSingle();
      if (ws) {
        list.unshift(ws);
      }
    }
  }

  // Fetch node counts per workspace
  const results = [];
  for (const ws of list.slice(0, limit)) {
    const { count } = await supabase
      .from("bkn_nodes")
      .select("uuid", { count: "exact", head: true })
      .eq("blueprint_id", ws.id);
    results.push({
      ...ws,
      node_count: count ?? 0
    });
  }
  return { workspaces: results, count: results.length };
}

export async function createWorkspace(supabase, name, description = "", options = {}) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("Workspace name is required and must be a non-empty string.");
  }

  const trimmedName = name.trim();
  const trimmedDesc = typeof description === "string" ? description.trim() : "";

  // Resolve creator
  let creatorId = options.created_by || null;
  if (!creatorId) {
    const apiKey = process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
    if (apiKey) {
      const validated = await validateApiKey(supabase, apiKey);
      if (validated?.record?.created_by) {
        creatorId = validated.record.created_by;
      }
    }
  }
  if (!creatorId) {
    // Default to the first admin or primary user profile
    const { data: adminProfiles } = await supabase
      .from("profiles")
      .select("id, email, display_name")
      .or("is_admin.eq.true,tier.eq.Pro,tier.eq.Ultra")
      .order("created_at", { ascending: true })
      .limit(1);

    if (adminProfiles && adminProfiles.length > 0) {
      creatorId = adminProfiles[0].id;
    }
  }

  const newWsId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert workspace record
  const { data: newWs, error: wsErr } = await supabase
    .from("workspaces")
    .insert({
      id: newWsId,
      name: trimmedName,
      description: trimmedDesc,
      problem_statement: options.problem_statement?.trim() || "",
      target_audience: options.target_audience?.trim() || "",
      technologies: Array.isArray(options.technologies) ? options.technologies : [],
      scope: options.scope || "medium",
      key_features: Array.isArray(options.key_features) ? options.key_features : [],
      created_by: creatorId,
      work_mode: options.work_mode || "solo",
      progress: 0,
      created_at: now,
      updated_at: now,
      last_updated: now
    })
    .select()
    .single();

  if (wsErr) {
    throw new Error(`Failed to create workspace: ${wsErr.message}`);
  }

  // Register owner in project_members if creator exists
  if (creatorId) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, display_name")
        .eq("id", creatorId)
        .maybeSingle();

      const email = profile?.email || "owner@bluesc.io";
      const displayName = profile?.display_name || email.split("@")[0] || "Owner";
      const avatar = (email || "OW").slice(0, 2).toUpperCase();

      await supabase.from("project_members").insert({
        project_id: newWsId,
        user_id: creatorId,
        email: email.toLowerCase().trim(),
        name: displayName,
        role: "Owner",
        avatar
      });
    } catch (memberErr) {
      console.warn("[blueprint-mcp] Warning: Failed to register project member:", memberErr.message);
    }
  }

  // Initialize workspace_settings
  try {
    await supabase.from("workspace_settings").insert({
      workspace_id: newWsId,
      dashboard_layout: {}
    });
  } catch (settingsErr) {
    console.warn("[blueprint-mcp] Warning: Failed to initialize workspace_settings:", settingsErr.message);
  }

  // Initialize workspace_docs
  try {
    await supabase.from("workspace_docs").insert({
      workspace_id: newWsId,
      executive_summary: trimmedDesc || `Workspace for ${trimmedName}`,
      technical_spec: "",
      user_stories: [],
      generated_at: now
    });
  } catch (docsErr) {
    console.warn("[blueprint-mcp] Warning: Failed to initialize workspace_docs:", docsErr.message);
  }

  // Initialize root BKN Concept node so the workspace is immediately queryable in graph
  let initialNodeCount = 0;
  try {
    const rootNodeUuid = crypto.randomUUID();
    await supabase.from("bkn_nodes").insert({
      uuid: rootNodeUuid,
      blueprint_id: newWsId,
      name: trimmedName,
      label: "Concept",
      description: trimmedDesc || `Root architecture concept for ${trimmedName}`,
      status: "active",
      properties: {
        is_root: true,
        created_via: "mcp_create_workspace"
      }
    });
    initialNodeCount++;

    // If initial_nodes were passed in options, insert them as well
    if (Array.isArray(options.initial_nodes) && options.initial_nodes.length > 0) {
      for (const node of options.initial_nodes) {
        if (node?.name && node?.label) {
          const nodeUuid = crypto.randomUUID();
          await supabase.from("bkn_nodes").insert({
            uuid: nodeUuid,
            blueprint_id: newWsId,
            name: node.name.trim(),
            label: node.label.trim(),
            description: node.description?.trim() || "",
            status: "active",
            properties: node.metadata || {}
          });
          initialNodeCount++;
        }
      }
    }
  } catch (nodeErr) {
    console.warn("[blueprint-mcp] Warning: Failed to initialize root BKN node:", nodeErr.message);
  }

  return {
    success: true,
    workspace: newWs,
    initial_nodes_count: initialNodeCount,
    message: `Workspace '${trimmedName}' successfully created with ID ${newWsId}.`
  };
}

export async function getWorkspaceContext(supabase, workspaceIdInput, includeDocs = true, includeTasks = true) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data: workspace, error: wsErr } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .single();

  if (wsErr) throw wsErr;

  let docs = null;
  if (includeDocs) {
    const { data } = await supabase
      .from("workspace_docs")
      .select("executive_summary, technical_spec")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    docs = data
      ? { executive_summary: data.executive_summary ?? null, technical_spec: data.technical_spec ?? null }
      : null;
  }

  let tasks = null;
  if (includeTasks) {
    const { data } = await supabase
      .from("workspace_tasks")
      .select("epics, milestones")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    tasks = data ? { epics: data.epics ?? null, milestones: data.milestones ?? null } : null;
  }

  const { data: sampleNodes } = await supabase
    .from("bkn_nodes")
    .select("name, label, description")
    .eq("blueprint_id", workspaceId)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(25);

  return {
    workspace: workspace ? { name: workspace.name, description: workspace.description } : null,
    docs,
    tasks,
    knowledge_nodes_sample: sampleNodes || []
  };
}

export const BKN_LEAN_NODE_COLUMNS = [
  "uuid",
  "blueprint_id",
  "label",
  "name",
  "description",
  "status",
  "assignee",
  "is_archived",
  "properties",
  "created_at",
  "last_active",
  "current_mastery",
  "parent_uuid",
  "confidence",
  "source_type",
  "created_by",
  "last_validated_at",
  "context_snapshot",
  "domain_namespace",
  "is_provisional",
  "source_id",
  "is_superseded",
].join(", ");

/**
 * Recursively strips `embedding` fields from any MCP payload before returning
 * it to an AI agent. Embeddings live in the database for vector similarity search
 * and must never bloat LLM tool responses.
 */
export function stripEmbeddingsFromPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripEmbeddingsFromPayload(item));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "embedding") continue;
      out[k] = stripEmbeddingsFromPayload(v);
    }
    return out;
  }
  return value;
}

const COMPACT_NODE_PROP_KEYS = [
  "current_value",
  "default_value",
  "unit",
  "step",
  "variable_type",
  "data_type",
  "reset_policy",
  "expression",
  "formula",
  "current_state",
  "computed_value",
  "node_class",
  "verification",
  "graph_key",
];

const COMPACT_EDGE_PROP_KEYS = [
  "action",
  "target_status",
  "target_mutation",
  "condition",
  "logic_branch",
];

function compactNodeForMcp(node) {
  const props = node?.properties && typeof node.properties === "object" ? node.properties : {};
  const compactProps = {};
  for (const key of COMPACT_NODE_PROP_KEYS) {
    if (props[key] !== undefined) compactProps[key] = props[key];
  }
  const rawDesc = typeof node?.description === "string" ? node.description.trim() : "";
  const description = rawDesc.length > 280 ? `${rawDesc.slice(0, 277)}...` : rawDesc;
  return {
    uuid: node.uuid,
    name: node.name,
    label: node.label,
    ...(node.status ? { status: node.status } : {}),
    ...(description ? { description } : {}),
    ...(node.is_superseded ? { is_superseded: true } : {}),
    ...(Object.keys(compactProps).length > 0 ? { properties: compactProps } : {}),
  };
}

function compactEdgeForMcp(edge, nameByUuid = new Map()) {
  const props = edge?.properties && typeof edge.properties === "object" ? edge.properties : {};
  const compactProps = {};
  for (const key of COMPACT_EDGE_PROP_KEYS) {
    if (props[key] !== undefined) compactProps[key] = props[key];
  }
  const rawNote =
    typeof edge?.source_snippet === "string" && edge.source_snippet.trim()
      ? edge.source_snippet.trim()
      : typeof props.description === "string"
        ? props.description.trim()
        : "";
  const note = rawNote.length > 160 ? `${rawNote.slice(0, 157)}...` : rawNote;
  const sourceName = nameByUuid.get(edge.source_uuid);
  const targetName = nameByUuid.get(edge.target_uuid);
  return {
    source_uuid: edge.source_uuid,
    ...(sourceName ? { source_name: sourceName } : {}),
    target_uuid: edge.target_uuid,
    ...(targetName ? { target_name: targetName } : {}),
    type: edge.type,
    ...(note ? { note } : {}),
    ...(Object.keys(compactProps).length > 0 ? { properties: compactProps } : {}),
  };
}

export async function queryGraph(supabase, workspaceIdInput, query, label, limit = 50, verbose = false) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  let q = supabase
    .from("bkn_nodes")
    .select(BKN_LEAN_NODE_COLUMNS)
    .eq("blueprint_id", workspaceId)
    .or("is_archived.is.null,is_archived.eq.false")
    .limit(limit);

  if (label) {
    q = q.ilike("label", label);
  }

  if (query) {
    const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    q = q.or(`name.ilike.%${escaped}%,description.ilike.%${escaped}%`);
  }

  let { data: nodes, error: nodeErr } = await q;
  if (nodeErr) throw nodeErr;

  // Multi-keyword fallback if exact query returned no nodes
  if ((!nodes || nodes.length === 0) && query && query.trim()) {
    const STOPWORDS = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "for", "on", "with", "at", "by", "from", "all", "these", "this", "that", "node", "nodes", "item", "items"]);
    const keywords = query
      .split(/[^a-zA-Z0-9_-]+/)
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length >= 2 && !STOPWORDS.has(k));

    if (keywords.length > 0) {
      let kwQuery = supabase
        .from("bkn_nodes")
        .select(BKN_LEAN_NODE_COLUMNS)
        .eq("blueprint_id", workspaceId)
        .or("is_archived.is.null,is_archived.eq.false")
        .limit(limit);

      if (label) kwQuery = kwQuery.ilike("label", label);

      const filterClauses = [];
      for (const kw of keywords.slice(0, 6)) {
        const safeKw = kw.replace(/%/g, "\\%").replace(/_/g, "\\_");
        filterClauses.push(`name.ilike.%${safeKw}%`);
        filterClauses.push(`description.ilike.%${safeKw}%`);
      }

      try {
        const { data: kwMatches } = await kwQuery.or(filterClauses.join(","));
        if (kwMatches && kwMatches.length > 0) {
          nodes = kwMatches;
        }
      } catch (_) {}
    }
  }

  if (nodes && nodes.length > 0) {
    nodes = nodes
      .filter(n => !n.is_archived && !n.properties?.is_archived)
      .map(n => stripEmbeddingsFromPayload(n));
  }

  const nodeUuids = (nodes || []).map((n) => n.uuid);
  // Cap the OR filter at 50 uuids, matching the hosted executor's request size.
  const edgeNodeUuids = nodeUuids.slice(0, 50);
  let edges = [];

  if (edgeNodeUuids.length > 0) {
    const { data: edgeData } = await supabase
      .from("bkn_edges")
      .select(verbose ? "*" : "source_uuid, target_uuid, type, source_snippet, properties")
      .eq("blueprint_id", workspaceId)
      .or(`source_uuid.in.(${edgeNodeUuids.join(",")}),target_uuid.in.(${edgeNodeUuids.join(",")})`)
      .limit(100);
    edges = edgeData || [];
  }

  const nameByUuid = new Map();
  for (const n of nodes || []) {
    if (n?.uuid && n?.name) nameByUuid.set(n.uuid, n.name);
  }
  const missingEndpointIds = Array.from(
    new Set(
      edges
        .flatMap((e) => [e.source_uuid, e.target_uuid])
        .filter((id) => id && !nameByUuid.has(id))
    )
  ).slice(0, 100);

  if (missingEndpointIds.length > 0) {
    try {
      const { data: endpointRows } = await supabase
        .from("bkn_nodes")
        .select("uuid, name")
        .in("uuid", missingEndpointIds);
      for (const row of endpointRows || []) {
        if (row?.uuid && row?.name) nameByUuid.set(row.uuid, row.name);
      }
    } catch (_) {}
  }

  const outNodes = verbose ? (nodes || []) : (nodes || []).map(compactNodeForMcp);
  const outEdges = verbose
    ? edges.map((e) => ({
        ...e,
        ...(nameByUuid.get(e.source_uuid) ? { source_name: nameByUuid.get(e.source_uuid) } : {}),
        ...(nameByUuid.get(e.target_uuid) ? { target_name: nameByUuid.get(e.target_uuid) } : {}),
      }))
    : edges.map((e) => compactEdgeForMcp(e, nameByUuid));

  return {
    nodes: outNodes,
    relationships: outEdges,
    count: outNodes.length,
    relationship_count: outEdges.length
  };
}

export async function createNode(supabase, workspaceIdInput, name, label, description, metadata = {}, nodeClass, verification) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const mergedProps = { ...metadata };
  if (nodeClass) {
    mergedProps.node_class = nodeClass;
  }
  if (verification !== undefined && verification !== null) {
    mergedProps.verification = verification;
  }

  // Check if exists
  const { data: existing } = await supabase
    .from("bkn_nodes")
    .select("uuid, properties")
    .eq("blueprint_id", workspaceId)
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    const finalProps = { ...(existing.properties || {}), ...mergedProps };
    const { data, error } = await supabase
      .from("bkn_nodes")
      .update({
        label,
        description,
        properties: finalProps,
        last_active: new Date().toISOString()
      })
      .eq("uuid", existing.uuid)
      .select()
      .single();

    if (error) throw error;
    return { success: true, node_id: data.uuid, name, label };
  }

  const { data, error } = await supabase
    .from("bkn_nodes")
    .insert({
      blueprint_id: workspaceId,
      name,
      label,
      description,
      status: "Active",
      properties: mergedProps,
      source_type: "agent_mcp",
      created_by: "agent"
    })
    .select()
    .single();

  if (error) throw error;
  return { success: true, node_id: data.uuid, name, label };
}

export async function linkNodes(supabase, workspaceIdInput, sourceName, targetName, relationshipType, description = "", properties = undefined) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const sourceNode = await resolveNode(supabase, workspaceId, sourceName, { required: false });
  const targetNode = await resolveNode(supabase, workspaceId, targetName, { required: false });

  if (!sourceNode || !targetNode) {
    throw new Error(`Nodes not found: source '${sourceName}' (${!!sourceNode}) or target '${targetName}' (${!!targetNode}) does not exist in workspace.`);
  }

  const edgeProps = {
    description,
    ...(properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {}),
  };

  const edgeRecord = {
    source_uuid: sourceNode.uuid,
    target_uuid: targetNode.uuid,
    type: relationshipType,
    blueprint_id: workspaceId,
    source_snippet: description || undefined,
    properties: edgeProps
  };

  const { data, error } = await supabase
    .from("bkn_edges")
    .upsert(edgeRecord, { onConflict: "source_uuid,target_uuid,type" })
    .select();

  if (error) {
    // If conflict constraint isn't unique index, fallback to standard insert
    const { error: insErr } = await supabase.from("bkn_edges").insert(edgeRecord);
    if (insErr) throw insErr;
  }

  return {
    success: true,
    source_name: sourceName,
    target_name: targetName,
    type: relationshipType
  };
}

export async function applyPatch(supabase, workspaceIdInput, nodesInput = [], edgesInput = []) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const nodes = [];
  for (const n of Array.isArray(nodesInput) ? nodesInput : []) {
    if (!n || !n.name || !n.label) continue;
    const res = await createNode(
      supabase,
      workspaceId,
      n.name,
      n.label,
      n.description || "",
      n.metadata || {},
      n.node_class,
      n.verification
    );
    nodes.push(res);
  }

  const edges = [];
  for (const e of Array.isArray(edgesInput) ? edgesInput : []) {
    if (!e || !e.source_name || !e.target_name || !e.relationship_type) continue;
    const res = await linkNodes(
      supabase,
      workspaceId,
      e.source_name,
      e.target_name,
      e.relationship_type,
      e.description || "",
      e.properties
    );
    edges.push(res);
  }

  return {
    success: true,
    nodes_upserted: nodes.length,
    edges_linked: edges.length,
    nodes,
    edges,
    message: `Applied BKN patch: ${nodes.length} node(s) upserted, ${edges.length} edge(s) linked.`
  };
}

export async function ingestContent(supabase, workspaceIdInput, content, sourceName = "agent_ingest", sourceType = "agent_mcp") {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  let entities = [];
  let relationships = [];

  // If OPENROUTER_API_KEY is available, use DeepSeek V4 Flash per AGENTS.md rule
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          provider: {
            allow_fallbacks: true,
            sort: "latency"
          },
          messages: [
            {
              role: "system",
              content: `You are a Universal Knowledge Graph Extraction Engine.
Extract entities and relationships from the text.
Classify labels strictly into: 'Rule', 'Decision', 'Concept', 'Insight', 'Goal', 'Task'.
Relationship types: 'governs', 'decided_by', 'supports', 'conflicts_with', 'implements', 'depends_on', 'requires', 'blocks', 'triggers', 'aligns', 'references'.
Return ONLY valid JSON:
{
  "entities": [{"name": "...", "label": "...", "description": "..."}],
  "relationships": [{"source_name": "...", "target_name": "...", "type": "...", "description": "..."}]
}`
            },
            { role: "user", content }
          ],
          response_format: { type: "json_object" }
        })
      });

      if (response.ok) {
        const json = await response.json();
        const contentText = json.choices?.[0]?.message?.content || "{}";
        const parsed = JSON.parse(contentText);
        entities = parsed.entities || [];
        relationships = parsed.relationships || [];
      }
    } catch (err) {
      console.warn("[blueprint-mcp] OpenRouter extraction failed, falling back to AST parser:", err.message);
    }
  }

  // Fallback: Structural AST parsing
  if (entities.length === 0) {
    const lines = content.split("\n");
    let currentHeading = null;
    let currentDesc = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,4}\s+(.+)/);
      if (headingMatch) {
        if (currentHeading) {
          entities.push({
            name: currentHeading,
            label: "Concept",
            description: currentDesc.join(" ").trim() || currentHeading
          });
          currentDesc = [];
        }
        currentHeading = headingMatch[1].trim();
      } else if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
        const itemText = line.trim().replace(/^[-*]\s+/, "");
        if (itemText.length > 5) {
          const colonIdx = itemText.indexOf(":");
          if (colonIdx > 0 && colonIdx < 50) {
            const name = itemText.slice(0, colonIdx).trim().replace(/[*_]/g, "");
            const desc = itemText.slice(colonIdx + 1).trim();
            entities.push({
              name,
              label: "Insight",
              description: desc
            });
            if (currentHeading) {
              relationships.push({
                source_name: currentHeading,
                target_name: name,
                type: "supports",
                description: `Extracted from section ${currentHeading}`
              });
            }
          } else {
            currentDesc.push(itemText);
          }
        }
      } else if (line.trim()) {
        currentDesc.push(line.trim());
      }
    }

    if (currentHeading) {
      entities.push({
        name: currentHeading,
        label: "Concept",
        description: currentDesc.join(" ").trim() || currentHeading
      });
    }
  }

  // Upsert entities into bkn_nodes
  const insertedNodes = [];
  for (const ent of entities) {
    try {
      const res = await createNode(supabase, workspaceId, ent.name, ent.label, ent.description, {
        source_name: sourceName,
        source_type: sourceType
      });
      insertedNodes.push(res);
    } catch (e) {
      console.warn(`[blueprint-mcp] Failed to insert node ${ent.name}:`, e.message);
    }
  }

  // Insert relationships into bkn_edges
  const insertedEdges = [];
  for (const rel of relationships) {
    try {
      const res = await linkNodes(supabase, workspaceId, rel.source_name, rel.target_name, rel.type, rel.description);
      insertedEdges.push(res);
    } catch (e) {
      console.warn(`[blueprint-mcp] Failed to link nodes ${rel.source_name} -> ${rel.target_name}:`, e.message);
    }
  }

  const result = {
    nodesInserted: insertedNodes.length,
    edgesInserted: insertedEdges.length,
    nodes: insertedNodes.map((n) => n.name),
    edges: insertedEdges
  };

  return {
    success: true,
    message: `Ingested text into Knowledge Graph: ${result.nodesInserted} nodes created, ${result.edgesInserted} relationships linked.`,
    ...result
  };
}

export async function pushTelemetry(supabase, workspaceIdInput, eventName, payload = {}, severity = "info") {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const apiKey = process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
  let apiKeyId = null;
  if (apiKey) {
    const validated = await validateApiKey(supabase, apiKey);
    apiKeyId = validated?.record?.id || null;
  }

  const { error } = await supabase
    .from("mcp_audit_logs")
    .insert({
      workspace_id: workspaceId,
      api_key_id: apiKeyId,
      client_name: "blueprint-mcp-agent",
      tool_name: eventName,
      payload,
      status: severity === "error" || severity === "critical" ? "failed" : "success",
      result_summary: `Telemetry event '${eventName}' [${severity}] logged by agent`,
      latency_ms: 0
    });

  if (error) throw error;
  return { success: true, message: `Telemetry event '${eventName}' logged.` };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/**
 * Resolve a single node by uuid or exact name inside one workspace.
 *
 * `required: false` is how the tools that mirror the hosted endpoint's
 * idempotent behaviour (delete/unlink of an already-removed node) avoid turning
 * a no-op into an error.
 */
async function resolveNode(supabase, workspaceId, identifier, { required = true } = {}) {
  const raw = typeof identifier === "string" ? identifier.trim() : "";
  if (!raw) {
    if (!required) return null;
    throw new Error("A node_identifier (uuid or exact name) is required.");
  }

  // Case-insensitive name lookup, matching the hosted resolver: an agent that
  // passes "auth token expiry" should reach the same node in either mode.
  let query = supabase
    .from("bkn_nodes")
    .select("uuid, name, label, description, properties")
    .eq("blueprint_id", workspaceId);

  query = isUuid(raw) ? query.eq("uuid", raw) : query.ilike("name", raw);

  const { data: node, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!node && required) {
    throw new Error(`Node '${raw}' does not exist in workspace ${workspaceId}.`);
  }
  return node || null;
}

/**
 * Neighbourhood of one node: the nodes an edge touches it on, with the edge type
 * and which way the edge points.
 *
 * `bkn_get_subgraph` answers the same question only for tree-shaped graphs, where
 * every related node hangs under the anchor. Typed graphs are not trees: a rule
 * that governs a component, and the component that requires the rule, are two
 * directions of the same edge, and an agent walking the graph needs to see which
 * is which to decide what to trust.
 */
export async function getRelatedNodes(supabase, workspaceIdInput, nodeIdentifier, limit = 25) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const node = await resolveNode(supabase, workspaceId, nodeIdentifier, { required: false });

  if (!node) {
    return {
      success: false,
      node_uuid: null,
      node_name: typeof nodeIdentifier === "string" ? nodeIdentifier : null,
      related: [],
      count: 0,
      message: `Node '${nodeIdentifier}' does not exist in this workspace BKN.`
    };
  }

  const { data: edges, error } = await supabase
    .from("bkn_edges")
    .select("source_uuid, target_uuid, type")
    .or(`source_uuid.eq.${node.uuid},target_uuid.eq.${node.uuid}`);
  if (error) throw error;

  // One row per neighbour, even when two edges connect the same pair: the caller
  // asked for the neighbourhood, and the edge types are the useful part of it.
  const neighbourIds = [];
  const edgeByNeighbour = new Map();
  for (const edge of edges || []) {
    const isOutgoing = edge.source_uuid === node.uuid;
    const neighbourId = isOutgoing ? edge.target_uuid : edge.source_uuid;
    if (!neighbourId || neighbourId === node.uuid) continue;
    if (!edgeByNeighbour.has(neighbourId)) {
      neighbourIds.push(neighbourId);
      edgeByNeighbour.set(neighbourId, { type: edge.type, direction: isOutgoing ? "outgoing" : "incoming" });
    }
  }

  if (neighbourIds.length === 0) {
    return {
      success: true,
      node_uuid: node.uuid,
      node_name: node.name,
      related: [],
      count: 0,
      message: `'${node.name}' has no relationships yet.`
    };
  }

  const { data: nodes, error: nodeErr } = await supabase
    .from("bkn_nodes")
    .select("uuid, name, label, description")
    .in("uuid", neighbourIds)
    .or("is_archived.is.null,is_archived.eq.false")
    .limit(limit);
  if (nodeErr) throw nodeErr;

  const related = (nodes || []).map((neighbour) => {
    const edge = edgeByNeighbour.get(neighbour.uuid) || {};
    return {
      uuid: neighbour.uuid,
      name: neighbour.name,
      label: neighbour.label,
      description: neighbour.description ?? null,
      edge_type: edge.type,
      direction: edge.direction
    };
  });

  return { success: true, node_uuid: node.uuid, node_name: node.name, related, count: related.length };
}

export async function getSubgraph(supabase, workspaceIdInput, parentUuid = null) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data, error } = await supabase.rpc("bkn_get_subgraph", {
    p_blueprint_id: workspaceId,
    p_parent_uuid: parentUuid ?? null
  });
  if (error) throw error;

  const nodes = (data || []).map((n) => stripEmbeddingsFromPayload(n));
  return { nodes, count: nodes.length, parent_uuid: parentUuid ?? null };
}

/**
 * Archive a node and sever its edges.
 *
 * Archiving (not `DELETE`) is what the hosted endpoint does, so the two modes
 * leave the same graph behind: the row stays, flagged `is_archived`, and the
 * edges around it are gone.
 */
export async function deleteNode(supabase, workspaceIdInput, nodeIdentifier) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const node = await resolveNode(supabase, workspaceId, nodeIdentifier, { required: false });

  if (!node) {
    return {
      success: true,
      node_identifier: nodeIdentifier,
      node_uuid: null,
      relationships_removed: 0,
      message: `Node '${nodeIdentifier}' was not found or already removed.`
    };
  }

  const { data: edges, error: edgeErr } = await supabase
    .from("bkn_edges")
    .select("source_uuid")
    .eq("blueprint_id", workspaceId)
    .or(`source_uuid.eq.${node.uuid},target_uuid.eq.${node.uuid}`);
  if (edgeErr) throw edgeErr;

  const relationshipsRemoved = (edges || []).length;

  const { error: unlinkErr } = await supabase
    .from("bkn_edges")
    .delete()
    .eq("blueprint_id", workspaceId)
    .or(`source_uuid.eq.${node.uuid},target_uuid.eq.${node.uuid}`);
  if (unlinkErr) throw unlinkErr;

  const { error } = await supabase
    .from("bkn_nodes")
    .update({ is_archived: true, last_active: new Date().toISOString() })
    .eq("blueprint_id", workspaceId)
    .eq("uuid", node.uuid);
  if (error) throw error;

  return {
    success: true,
    node_identifier: nodeIdentifier,
    node_uuid: node.uuid,
    relationships_removed: relationshipsRemoved,
    message: `Deleted node '${node.name}' and severed ${relationshipsRemoved} relationship(s).`
  };
}

export async function unlinkNodes(supabase, workspaceIdInput, sourceName, targetName, relationshipType = null) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const sourceNode = await resolveNode(supabase, workspaceId, sourceName, { required: false });
  const targetNode = await resolveNode(supabase, workspaceId, targetName, { required: false });

  if (!sourceNode || !targetNode) {
    return {
      success: true,
      source_name: sourceName,
      target_name: targetName,
      type: relationshipType || null,
      message: "One or both nodes could not be found to unlink."
    };
  }

  let matchQuery = supabase
    .from("bkn_edges")
    .select("type")
    .eq("blueprint_id", workspaceId)
    .eq("source_uuid", sourceNode.uuid)
    .eq("target_uuid", targetNode.uuid);
  if (relationshipType) {
    matchQuery = matchQuery.eq("type", relationshipType);
  }

  const { data: matched, error: matchErr } = await matchQuery;
  if (matchErr) throw matchErr;

  const removed = (matched || []).length;

  if (removed > 0) {
    let deleteQuery = supabase
      .from("bkn_edges")
      .delete()
      .eq("blueprint_id", workspaceId)
      .eq("source_uuid", sourceNode.uuid)
      .eq("target_uuid", targetNode.uuid);
    if (relationshipType) {
      deleteQuery = deleteQuery.eq("type", relationshipType);
    }

    const { error } = await deleteQuery;
    if (error) throw error;
  }

  return {
    success: true,
    source_name: sourceName,
    target_name: targetName,
    type: relationshipType || null,
    message: `Removed ${removed} relationship(s) between '${sourceNode.name}' and '${targetNode.name}'.`
  };
}

export async function mutateVariable(supabase, workspaceIdInput, nodeIdentifier, operation, amount = null, value = undefined) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const node = await resolveNode(supabase, workspaceId, nodeIdentifier);

  const properties = node.properties && typeof node.properties === "object" ? node.properties : {};
  const previousValue = properties.current_value ?? properties.value ?? null;
  const step = typeof amount === "number" && Number.isFinite(amount) ? amount : 1;

  let currentValue;
  switch (operation) {
    case "increment":
      currentValue = (typeof previousValue === "number" ? previousValue : Number(previousValue) || 0) + step;
      break;
    case "decrement":
      currentValue = (typeof previousValue === "number" ? previousValue : Number(previousValue) || 0) - step;
      break;
    case "set":
      if (value === undefined) {
        throw new Error("The 'set' operation requires a value.");
      }
      currentValue = value;
      break;
    case "toggle":
      currentValue = !(previousValue === true);
      break;
    case "reset":
      currentValue = typeof previousValue === "boolean" ? false : 0;
      break;
    default:
      throw new Error(
        `Unsupported mutation operation '${operation}'. Use increment, decrement, set, toggle or reset.`
      );
  }

function evaluateSelfHostedExpression(expression, contextVariables = {}) {
  if (!expression || typeof expression !== "string" || !expression.trim()) return false;
  const normalizedContext = {};
  for (const [key, val] of Object.entries(contextVariables)) {
    normalizedContext[key.toLowerCase()] = val;
    normalizedContext[key.toLowerCase().replace(/[^a-z0-9]/g, "")] = val;
    normalizedContext[key.toLowerCase().replace(/[\s\-]/g, "_")] = val;
  }

  const resolvedExpr = expression.replace(/@([a-zA-Z0-9_\-]+)/g, (_, varName) => {
    const rawKey = varName.toLowerCase();
    const val =
      normalizedContext[rawKey] ??
      normalizedContext[rawKey.replace(/[^a-z0-9]/g, "")] ??
      normalizedContext[rawKey.replace(/[\s\-]/g, "_")];
    if (val === undefined || val === null) return "false";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") return String(val);
    return JSON.stringify(String(val));
  });

  const tokenRegex =
    /\s*(&&|\|\||!==|!=|===|==|>=|<=|>|<|!|\(|\)|\+|-|\*|\/|%|true|false|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[0-9]+(?:\.[0-9]+)?|[a-zA-Z_][a-zA-Z0-9_]*)\s*/g;
  const tokens = [];
  let consumedLen = 0;
  let m;
  while ((m = tokenRegex.exec(resolvedExpr)) !== null) {
    if (m.index !== consumedLen) return false;
    consumedLen = tokenRegex.lastIndex;
    if (m[1]) tokens.push(m[1]);
  }
  if (consumedLen !== resolvedExpr.length || tokens.length === 0) return false;

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];
  const toNum = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  function parseOr() {
    let left = parseAnd();
    while (peek() === "||") {
      consume();
      left = left || parseAnd();
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() === "&&") {
      consume();
      left = left && parseNot();
    }
    return left;
  }
  function parseNot() {
    if (peek() === "!") {
      consume();
      return !parseNot();
    }
    return parseRelational();
  }
  function parseRelational() {
    const leftVal = parseAddSub();
    const op = peek();
    if (op && [">=", "<=", ">", "<", "==", "===", "!=", "!=="].includes(op)) {
      consume();
      const rightVal = parseAddSub();
      if (leftVal === undefined || rightVal === undefined) return false;
      if (typeof leftVal === "number" || typeof rightVal === "number") {
        const a = toNum(leftVal);
        const b = toNum(rightVal);
        if (Number.isNaN(a) || Number.isNaN(b)) return op === "!=" || op === "!==";
        if (op === ">=") return a >= b;
        if (op === "<=") return a <= b;
        if (op === ">") return a > b;
        if (op === "<") return a < b;
        if (op === "==" || op === "===") return a === b;
        return a !== b;
      }
      if (op === "==" || op === "===") return leftVal === rightVal;
      if (op === "!=" || op === "!==") return leftVal !== rightVal;
      if (op === ">=") return leftVal >= rightVal;
      if (op === "<=") return leftVal <= rightVal;
      if (op === ">") return leftVal > rightVal;
      return leftVal < rightVal;
    }
    return typeof leftVal === "number" && !Number.isFinite(leftVal) ? false : Boolean(leftVal);
  }
  function parseAddSub() {
    let left = parseMulDiv();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseMulDiv();
      const a = toNum(left);
      const b = toNum(right);
      left = Number.isNaN(a) || Number.isNaN(b) ? NaN : op === "+" ? a + b : a - b;
    }
    return left;
  }
  function parseMulDiv() {
    let left = parseUnary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = consume();
      const right = parseUnary();
      const a = toNum(left);
      const b = toNum(right);
      if (Number.isNaN(a) || Number.isNaN(b)) left = NaN;
      else if (op === "*") left = a * b;
      else if (op === "/") left = b === 0 ? NaN : a / b;
      else left = b === 0 ? NaN : a % b;
    }
    return left;
  }
  function parseUnary() {
    if (peek() === "+") {
      consume();
      return toNum(parseUnary());
    }
    if (peek() === "-") {
      consume();
      const inner = toNum(parseUnary());
      return Number.isNaN(inner) ? NaN : -inner;
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const token = peek();
    if (!token) return undefined;
    if (token === "(") {
      consume();
      const saved = pos;
      const arith = parseAddSub();
      if (peek() === ")") {
        consume();
        return arith;
      }
      pos = saved;
      const boolVal = parseOr();
      if (peek() === ")") consume();
      return boolVal;
    }
    consume();
    if (token === "true") return true;
    if (token === "false") return false;
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) return Number(token);
    const rawId = token.toLowerCase();
    return (
      normalizedContext[rawId] ??
      normalizedContext[rawId.replace(/[^a-z0-9]/g, "")] ??
      normalizedContext[rawId.replace(/[\s\-]/g, "_")]
    );
  }

  try {
    const out = parseOr();
    return pos === tokens.length ? out : false;
  } catch {
    return false;
  }
}

async function runSelfHostedReactiveCascade(supabase, workspaceId, mutatedNode, currentValue, nowIso) {
  let cascadedLogicCount = 0;
  let triggeredActionsCount = 0;

  try {
    const { data: rawNodes } = await supabase
      .from("bkn_nodes")
      .select("uuid, name, label, properties, is_archived")
      .eq("blueprint_id", workspaceId)
      .in("label", ["Variable", "Logic"]);

    const activeNodes = (rawNodes || []).filter((n) => !n.is_archived && !n.properties?.is_archived);
    const logicNodes = activeNodes.filter((n) => n.label === "Logic");
    if (logicNodes.length === 0) return { cascadedLogicCount, triggeredActionsCount };

    const varContext = {};
    const registerCtx = (uuid, name, val) => {
      varContext[uuid] = val;
      if (name) {
        varContext[name] = val;
        varContext[name.toLowerCase()] = val;
        varContext[name.toLowerCase().replace(/[\s\-]/g, "_")] = val;
      }
    };

    for (const v of activeNodes.filter((n) => n.label === "Variable")) {
      const val =
        v.uuid === mutatedNode.uuid
          ? currentValue
          : (v.properties?.current_value ?? v.properties?.value ?? v.properties?.default_value ?? 0);
      registerCtx(v.uuid, v.name, val);
    }
    registerCtx(mutatedNode.uuid, mutatedNode.name, currentValue);

    const logicEdgesCache = new Map();
    const firedMutateEdges = new Set();
    const lastStateByLogic = new Map();

    for (let pass = 0; pass < 6; pass++) {
      let anyChanged = false;
      for (const ln of logicNodes) {
        const expr = ln.properties?.expression || ln.properties?.formula;
        if (!expr) continue;
        const nextState = evaluateSelfHostedExpression(expr, varContext);
        const prevState = lastStateByLogic.get(ln.uuid);
        if (pass > 0 && prevState === nextState) continue;

        lastStateByLogic.set(ln.uuid, nextState);
        registerCtx(ln.uuid, ln.name, nextState);
        cascadedLogicCount++;
        anyChanged = true;

        await supabase
          .from("bkn_nodes")
          .update({
            properties: {
              ...(ln.properties || {}),
              value: nextState,
              result: nextState,
              evaluated_value: nextState,
              current_state: nextState,
              last_evaluated_at: nowIso,
            },
            last_active: nowIso,
          })
          .eq("blueprint_id", workspaceId)
          .eq("uuid", ln.uuid);

        let edges = logicEdgesCache.get(ln.uuid);
        if (!edges) {
          const { data: fetched } = await supabase
            .from("bkn_edges")
            .select("source_uuid, target_uuid, type, properties")
            .eq("blueprint_id", workspaceId)
            .eq("source_uuid", ln.uuid);
          edges = fetched || [];
          logicEdgesCache.set(ln.uuid, edges);
        }

        for (const edge of edges) {
          const branch = edge.properties?.logic_branch || edge.type;
          const matches =
            (nextState && (branch === "when_true" || branch === "if")) ||
            (!nextState && (branch === "when_false" || branch === "else"));
          if (!matches) continue;

          const action = edge.properties?.action || "set_status_shipped";
          const edgeKey = `${edge.source_uuid}->${edge.target_uuid}:${edge.type}`;

          if (action === "mutate_variable" && edge.properties?.target_mutation) {
            if (firedMutateEdges.has(edgeKey)) continue;
            firedMutateEdges.add(edgeKey);
            const { data: tRow } = await supabase
              .from("bkn_nodes")
              .select("uuid, name, properties")
              .eq("blueprint_id", workspaceId)
              .eq("uuid", edge.target_uuid)
              .maybeSingle();
            if (tRow) {
              const tProps = tRow.properties || {};
              const tPrev = Number(tProps.current_value ?? tProps.value ?? tProps.default_value ?? 0);
              const mut = edge.properties.target_mutation;
              const amt = Number(mut.amount ?? tProps.step ?? 1);
              let tNext = tPrev;
              if (mut.operation === "increment") tNext = tPrev + amt;
              else if (mut.operation === "decrement") tNext = tPrev - amt;
              else if (mut.operation === "set") tNext = mut.value;
              else if (mut.operation === "toggle") tNext = !Boolean(tProps.current_value);
              else if (mut.operation === "reset") tNext = tProps.default_value ?? 0;

              await supabase
                .from("bkn_nodes")
                .update({
                  properties: { ...tProps, current_value: tNext, value: tNext },
                  last_active: nowIso,
                })
                .eq("blueprint_id", workspaceId)
                .eq("uuid", tRow.uuid);
              registerCtx(tRow.uuid, tRow.name, tNext);
              triggeredActionsCount++;
              anyChanged = true;
            }
          } else if (action.startsWith("set_status") || edge.properties?.target_status) {
            const statusToSet = edge.properties?.target_status || (nextState ? "Shipped" : "Pending");
            const { data: tRow } = await supabase
              .from("bkn_nodes")
              .select("properties")
              .eq("blueprint_id", workspaceId)
              .eq("uuid", edge.target_uuid)
              .maybeSingle();
            await supabase
              .from("bkn_nodes")
              .update({
                status: statusToSet,
                properties: { ...(tRow?.properties || {}), status: statusToSet, last_active: nowIso },
                last_active: nowIso,
              })
              .eq("blueprint_id", workspaceId)
              .eq("uuid", edge.target_uuid);
            triggeredActionsCount++;
          }
        }
      }
      if (!anyChanged) break;
    }
  } catch (_) {
    // Non-fatal in minimal mock clients
  }

  return { cascadedLogicCount, triggeredActionsCount };
}

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("bkn_nodes")
    .update({
      properties: { ...properties, current_value: currentValue, value: currentValue },
      last_active: nowIso
    })
    .eq("blueprint_id", workspaceId)
    .eq("uuid", node.uuid);
  if (error) throw error;

  const { cascadedLogicCount, triggeredActionsCount } = await runSelfHostedReactiveCascade(
    supabase,
    workspaceId,
    node,
    currentValue,
    nowIso
  );

  return {
    success: true,
    node_uuid: node.uuid,
    node_name: node.name,
    operation,
    previous_value: previousValue,
    current_value: currentValue,
    cascaded_logic_count: cascadedLogicCount,
    triggered_actions_count: triggeredActionsCount,
    message: `Mutated variable '${node.name}': ${operation} -> ${JSON.stringify(currentValue)}.`
  };
}

export async function traverseAgentNode(supabase, workspaceIdInput, targetNodeUuid, reason = "", agentId = null) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data: targetNode, error: nodeErr } = await supabase
    .from("bkn_nodes")
    .select("uuid, name")
    .eq("blueprint_id", workspaceId)
    .eq("uuid", targetNodeUuid)
    .maybeSingle();
  if (nodeErr) throw nodeErr;
  if (!targetNode) {
    throw new Error(`Target node '${targetNodeUuid}' does not exist in workspace ${workspaceId}.`);
  }

  let agentQuery = supabase
    .from("agents")
    .select("id, name, current_node_uuid, home_node_uuid")
    .eq("workspace_id", workspaceId);
  if (agentId) {
    agentQuery = agentQuery.eq("id", agentId);
  }

  const { data: agent, error: agentErr } = await agentQuery
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (agentErr) throw agentErr;
  if (!agent) {
    throw new Error(
      agentId
        ? `Agent '${agentId}' does not exist in workspace ${workspaceId}.`
        : `No resident agent found for workspace ${workspaceId}.`
    );
  }

  const updates = { current_node_uuid: targetNode.uuid };
  // Station the agent the first time it moves; later traversals must not
  // overwrite the original home node.
  if (!agent.home_node_uuid) updates.home_node_uuid = targetNode.uuid;

  const { error } = await supabase.from("agents").update(updates).eq("id", agent.id);
  if (error) throw error;

  return {
    success: true,
    agent_id: agent.id,
    from_node_uuid: agent.current_node_uuid ?? null,
    to_node_uuid: targetNode.uuid,
    reason: reason || "",
    message: `Agent '${agent.name || agent.id}' traversed to '${targetNode.name}'.`
  };
}

/**
 * Station an agent at a home node and/or move its current location. Callable in
 * both modes but unadvertised: the SDK's `client.stationAgent()` is its caller.
 */
export async function stationAgent(
  supabase,
  workspaceIdInput,
  agentId,
  homeNodeUuid = null,
  currentNodeUuid = null
) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  if (!agentId) {
    throw new Error("agent_id is required to station an agent.");
  }
  if (!homeNodeUuid && !currentNodeUuid) {
    throw new Error("Provide home_node_uuid, current_node_uuid, or both to station an agent.");
  }

  for (const [label, uuid] of [
    ["home_node_uuid", homeNodeUuid],
    ["current_node_uuid", currentNodeUuid]
  ]) {
    if (!uuid) continue;
    const { data: node, error: nodeErr } = await supabase
      .from("bkn_nodes")
      .select("uuid")
      .eq("blueprint_id", workspaceId)
      .eq("uuid", uuid)
      .maybeSingle();
    if (nodeErr) throw nodeErr;
    if (!node) {
      throw new Error(`Node '${uuid}' passed as ${label} does not exist in this workspace BKN.`);
    }
  }

  const updates = {};
  if (homeNodeUuid) updates.home_node_uuid = homeNodeUuid;
  if (currentNodeUuid) updates.current_node_uuid = currentNodeUuid;

  const { data: agent, error } = await supabase
    .from("agents")
    .update(updates)
    .eq("workspace_id", workspaceId)
    .eq("id", agentId)
    .select("id, name, home_node_uuid, current_node_uuid")
    .maybeSingle();
  if (error) throw error;
  if (!agent) {
    throw new Error(`Agent '${agentId}' does not exist in this workspace.`);
  }

  return {
    success: true,
    agent_id: agent.id,
    home_node_uuid: agent.home_node_uuid ?? null,
    current_node_uuid: agent.current_node_uuid ?? null,
    message: `Agent '${agent.name || agent.id}' stationed at '${agent.current_node_uuid || agent.home_node_uuid}'.`
  };
}

export async function emitSignal(supabase, workspaceIdInput, options = {}) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const title = typeof options.title === "string" ? options.title.trim() : "";
  if (!title) {
    throw new Error("Signal title is required.");
  }

  const severity = options.severity || "info";
  const signalType = options.signalType || "agent_alert";
  const propagationMode = options.propagationMode || "local";

  const { data, error } = await supabase.rpc("bkn_emit_signal", {
    p_blueprint_id: workspaceId,
    p_title: title,
    p_target_node_uuid: options.targetNodeUuid ?? null,
    p_source_node_uuid: null,
    p_source_agent_id: options.sourceAgentId ?? null,
    p_description: options.description || "",
    p_signal_type: signalType,
    p_severity: severity,
    p_propagation_mode: propagationMode,
    p_payload: options.payload || {},
    p_is_persistent: options.isPersistent === true
  });
  if (error) throw error;

  return {
    success: true,
    signal_uuid: data,
    title,
    severity,
    propagation_mode: propagationMode,
    message: `Signal '${title}' emitted [${severity}] with ${propagationMode} propagation.`
  };
}

export async function resolveSignal(supabase, signalUuid, resolutionNote = "") {
  if (!signalUuid) {
    throw new Error("signal_uuid is required.");
  }

  const { error } = await supabase.rpc("bkn_resolve_signal", {
    p_signal_uuid: signalUuid,
    p_resolution_note: resolutionNote || ""
  });
  if (error) throw error;

  return {
    success: true,
    signal_uuid: signalUuid,
    resolution_note: resolutionNote || "",
    resolved_at: new Date().toISOString(),
    message: `Signal '${signalUuid}' marked resolved.`
  };
}

export async function listSignals(supabase, workspaceIdInput, targetNodeUuid = null, limit = 50) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data, error } = await supabase.rpc("bkn_list_active_signals", {
    p_blueprint_id: workspaceId,
    p_target_node_uuid: targetNodeUuid ?? null,
    p_limit: limit ?? 50
  });
  if (error) throw error;

  const signals = data || [];
  return { signals, count: signals.length };
}

export async function getHotPath() {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const lowercaseAgentsPath = path.join(repoRoot, "agents.md");
  const kernelAgentsPath = path.join(repoRoot, "kernel/AGENTS.md");
  const identityPath = path.join(repoRoot, "kernel/IDENTITY.md");

  let agentsContent = "";
  if (fs.existsSync(agentsPath)) {
    agentsContent = await fsp.readFile(agentsPath, "utf-8");
  } else if (fs.existsSync(lowercaseAgentsPath)) {
    agentsContent = await fsp.readFile(lowercaseAgentsPath, "utf-8");
  } else if (fs.existsSync(kernelAgentsPath)) {
    agentsContent = await fsp.readFile(kernelAgentsPath, "utf-8");
  }

  let identityContent = "";
  if (fs.existsSync(identityPath)) {
    identityContent = await fsp.readFile(identityPath, "utf-8");
  }

  return {
    agents: agentsContent,
    identity: identityContent,
    summary: "Tier 1 Safety Guardrails, Hot Path, and Agent Roles loaded."
  };
}

/**
 * Base directory for the repo-local kernel tools (`logDecision`, `updateKnowledge`).
 *
 * Those two write into the checkout, and this package's own test suite used to
 * call them directly: every `npm test` run appended a `Test MCP Decision` block to
 * the real `kernel/notes/notes.md`, noise that accumulated from 2026-09-04 on.
 * Callers may target another root (`{ rootDir }` or `BLUEPRINT_KERNEL_ROOT`), and
 * a write against the real checkout is now refused while a test runner is active,
 * so a test that forgets to inject a root fails loudly instead of dirtying the
 * project's audit log.
 */
function resolveKernelRoot(rootDir) {
  const configured = rootDir || process.env.BLUEPRINT_KERNEL_ROOT;
  const root = configured || repoRoot;
  const isTestRun = Boolean(
    process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test"
  );
  if (isTestRun && !configured && path.resolve(root) === path.resolve(repoRoot)) {
    throw new Error(
      "Refusing to write into the checkout during a test run: pass { rootDir } (or set BLUEPRINT_KERNEL_ROOT) to target a temporary directory."
    );
  }
  return root;
}

export async function writeFileNode(supabase, workspaceIdInput, filePath, content, language, description, label) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("Missing required parameter: 'path'");
  }
  const fileContent = typeof content === "string" ? content : String(content ?? "");
  const sizeBytes = Buffer.byteLength(fileContent, "utf8");
  const lineCount = fileContent.length === 0 ? 0 : fileContent.split("\n").length;
  const targetLabel = (typeof label === "string" && label.trim()) ? label.trim() : "Resource";

  let detectedLang = language;
  if (!detectedLang) {
    const ext = path.extname(normalizedPath).toLowerCase().replace(/^\./, "");
    const extMap = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      py: "python",
      md: "markdown",
      css: "css",
      html: "html",
      sql: "sql",
      sh: "shell",
      yaml: "yaml",
      yml: "yaml"
    };
    detectedLang = extMap[ext] || "text";
  }

  const properties = {
    node_class: "file",
    is_file: true,
    path: normalizedPath,
    language: detectedLang,
    content: fileContent,
    size_bytes: sizeBytes,
    line_count: lineCount,
    updated_at: new Date().toISOString()
  };

  const { data: existing } = await supabase
    .from("bkn_nodes")
    .select("uuid, properties")
    .eq("blueprint_id", workspaceId)
    .eq("name", normalizedPath)
    .maybeSingle();

  let nodeId;
  if (existing) {
    const mergedProps = { ...(existing.properties || {}), ...properties };
    const { data, error } = await supabase
      .from("bkn_nodes")
      .update({
        label: targetLabel,
        description: description || `File: ${normalizedPath}`,
        properties: mergedProps,
        last_active: new Date().toISOString()
      })
      .eq("uuid", existing.uuid)
      .select()
      .single();

    if (error) throw error;
    nodeId = data ? data.uuid : existing.uuid;
  } else {
    const { data, error } = await supabase
      .from("bkn_nodes")
      .insert({
        blueprint_id: workspaceId,
        name: normalizedPath,
        label: targetLabel,
        description: description || `File: ${normalizedPath}`,
        status: "Active",
        confidence: 1.0,
        is_provisional: false,
        source_type: "mcp_file",
        created_by: "agent",
        properties
      })
      .select()
      .single();

    if (error) throw error;
    nodeId = data ? data.uuid : crypto.randomUUID();
  }

  return {
    success: true,
    path: normalizedPath,
    node_id: nodeId,
    size_bytes: sizeBytes,
    line_count: lineCount
  };
}

export async function readFileNode(supabase, workspaceIdInput, filePath) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("Missing required parameter: 'path'");
  }

  let query = supabase
    .from("bkn_nodes")
    .select("uuid, name, label, description, properties")
    .eq("blueprint_id", workspaceId);

  if (isUuid(normalizedPath)) {
    query = query.eq("uuid", normalizedPath);
  } else {
    query = query.eq("name", normalizedPath);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`File node '${normalizedPath}' not found in workspace.`);
  }

  const props = data.properties || {};
  const content = props.content ?? data.description ?? "";
  const sizeBytes = props.size_bytes ?? Buffer.byteLength(content, "utf8");
  const lineCount = props.line_count ?? (content.length === 0 ? 0 : content.split("\n").length);
  const language = props.language || "text";

  return {
    success: true,
    path: props.path || data.name,
    content,
    language,
    size_bytes: sizeBytes,
    line_count: lineCount,
    node_id: data.uuid
  };
}

export async function editFileNode(supabase, workspaceIdInput, filePath, target, replacement, all = false) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("Missing required parameter: 'path'");
  }
  if (typeof target !== "string" || target === "") {
    throw new Error("Missing required parameter: 'target'");
  }
  if (typeof replacement !== "string") {
    throw new Error("Missing required parameter: 'replacement'");
  }

  let query = supabase
    .from("bkn_nodes")
    .select("uuid, name, properties")
    .eq("blueprint_id", workspaceId);

  if (isUuid(normalizedPath)) {
    query = query.eq("uuid", normalizedPath);
  } else {
    query = query.eq("name", normalizedPath);
  }

  const { data: node, error } = await query.maybeSingle();
  if (error) throw error;
  if (!node) {
    throw new Error(`File node '${normalizedPath}' not found in workspace.`);
  }

  const props = node.properties || {};
  const currentContent = typeof props.content === "string" ? props.content : "";

  if (!currentContent.includes(target)) {
    throw new Error(`Target string not found in '${normalizedPath}'. Ensure target exactly matches the text.`);
  }

  let newContent;
  let replacementsMade = 0;
  if (all) {
    const parts = currentContent.split(target);
    replacementsMade = parts.length - 1;
    newContent = parts.join(replacement);
  } else {
    replacementsMade = 1;
    newContent = currentContent.replace(target, replacement);
  }

  const newSizeBytes = Buffer.byteLength(newContent, "utf8");
  const newLineCount = newContent.length === 0 ? 0 : newContent.split("\n").length;

  const updatedProps = {
    ...props,
    content: newContent,
    size_bytes: newSizeBytes,
    line_count: newLineCount,
    updated_at: new Date().toISOString()
  };

  const { error: updateError } = await supabase
    .from("bkn_nodes")
    .update({
      properties: updatedProps,
      last_active: new Date().toISOString()
    })
    .eq("uuid", node.uuid);

  if (updateError) throw updateError;

  return {
    success: true,
    path: props.path || node.name,
    replacements_made: replacementsMade,
    new_size_bytes: newSizeBytes,
    new_line_count: newLineCount
  };
}

export async function listFileNodes(supabase, workspaceIdInput, directory) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const prefix = typeof directory === "string" ? directory.trim() : "";

  let query = supabase
    .from("bkn_nodes")
    .select("uuid, name, properties, created_at, last_active")
    .eq("blueprint_id", workspaceId)
    .or("is_archived.is.null,is_archived.eq.false");

  const { data: rows, error } = await query;
  if (error) throw error;

  const files = (rows || [])
    .filter((n) => {
      const isFile = n.properties?.is_file === true || n.properties?.content !== undefined || (n.name && n.name.includes("."));
      if (!isFile) return false;
      const filePath = n.properties?.path || n.name;
      if (prefix && !filePath.startsWith(prefix)) return false;
      return true;
    })
    .map((n) => {
      const p = n.properties || {};
      const content = typeof p.content === "string" ? p.content : "";
      return {
        path: p.path || n.name,
        language: p.language || "text",
        size_bytes: p.size_bytes ?? Buffer.byteLength(content, "utf8"),
        line_count: p.line_count ?? (content.length === 0 ? 0 : content.split("\n").length),
        node_id: n.uuid,
        updated_at: p.updated_at || n.last_active || n.created_at || new Date().toISOString()
      };
    });

  return {
    success: true,
    count: files.length,
    files
  };
}

export async function logDecision(decision, outcome, owner = "Agent", options = {}) {
  const root = resolveKernelRoot(options.rootDir);
  const notesPath = path.join(root, "kernel/notes/notes.md");
  const today = new Date().toISOString().split("T")[0];
  const entry = `\n\n## [${today}] ${decision}\n- **Outcome**: ${outcome}\n- **Owner**: ${owner}\n- **Status**: Logged via Blueprint MCP\n`;

  await fsp.mkdir(path.dirname(notesPath), { recursive: true });
  await fsp.appendFile(notesPath, entry, "utf-8");

  const localBknDir = path.join(root, ".bkn");
  let bknNodeKey = null;
  if (fs.existsSync(path.join(localBknDir, "graph.yaml"))) {
    try {
      const store = new LocalBKNStore(localBknDir);
      const node = await store.saveNode({
        id: toNodeKey(decision),
        title: String(decision || "Decision"),
        label: "Decision",
        content: String(outcome || ""),
        properties: { owner, logged_at: today, source: "mcp_log_decision" },
      });
      bknNodeKey = node.id;
    } catch (_) {}
  }

  return { success: true, date: today, decision, notesPath, bknNodeKey };
}

export async function updateKnowledge(filename, content, options = {}) {
  const cleanName = path.basename(filename);
  const targetDir = path.join(resolveKernelRoot(options.rootDir), "kernel/knowledge");
  const targetPath = path.join(targetDir, cleanName);

  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(targetPath, content, "utf-8");

  return { success: true, file: cleanName, path: targetPath };
}

export async function submitProposal(supabase, workspaceIdInput, title, description, contracts, testPlans, filesToModify) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data, error } = await supabase
    .from("kernel_proposals")
    .insert({
      blueprint_id: workspaceId,
      title,
      description: description || "",
      pass_a_artifacts: {
        contracts,
        test_plans: testPlans,
        files_to_modify: filesToModify
      },
      status: "pending_approval"
    })
    .select();

  if (error) throw error;
  return { success: true, proposalId: data[0].id, title, status: "pending_approval" };
}

export async function agentBoost(supabase, workspaceIdInput, task, targetEntity) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  const { data: nodes } = await supabase
    .from("bkn_nodes")
    .select("uuid, name, label, description, properties")
    .eq("blueprint_id", workspaceId)
    .limit(200);

  const { data: edges } = await supabase
    .from("bkn_edges")
    .select("source_uuid, target_uuid, type, source_snippet, properties")
    .eq("blueprint_id", workspaceId)
    .limit(300);

  const nodeMap = new Map();
  for (const n of nodes || []) {
    nodeMap.set(n.uuid, n);
    if (n.name) nodeMap.set(n.name.toLowerCase(), n);
  }

  const supersededByMap = new Map();
  for (const e of edges || []) {
    if (e.type === "supersedes" || e.type === "superseded_by") {
      const deprecatedUuid = e.type === "supersedes" ? e.target_uuid : e.source_uuid;
      const successorUuid = e.type === "supersedes" ? e.source_uuid : e.target_uuid;
      if (nodeMap.has(deprecatedUuid) && nodeMap.has(successorUuid)) {
        supersededByMap.set(deprecatedUuid, {
          successorUuid,
          warning: e.source_snippet || "Legacy pattern superseded by active architecture decision."
        });
      }
    }
  }
  for (const n of nodes || []) {
    const supUuid = n.properties?.superseded_by_uuid;
    if (typeof supUuid === "string" && nodeMap.has(supUuid) && !supersededByMap.has(n.uuid)) {
      supersededByMap.set(n.uuid, {
        successorUuid: supUuid,
        warning: "Legacy pattern superseded by active architecture decision."
      });
    }
  }

  const resolveUltimateSuccessor = (startUuid) => {
    let curr = startUuid;
    const seen = new Set([curr]);
    while (supersededByMap.has(curr)) {
      const next = supersededByMap.get(curr).successorUuid;
      if (seen.has(next)) break;
      seen.add(next);
      curr = next;
    }
    return curr;
  };

  const invariants = [];
  const decisions = [];
  const contracts = [];
  const antiPatterns = [];
  const executableContracts = [];

  for (const [deprecatedUuid, info] of supersededByMap.entries()) {
    const depNode = nodeMap.get(deprecatedUuid);
    const ultimateUuid = resolveUltimateSuccessor(info.successorUuid);
    const succNode = nodeMap.get(ultimateUuid);
    if (depNode && succNode) {
      antiPatterns.push({
        deprecated: depNode.name,
        supersededBy: succNode.name,
        warning: info.warning
      });
    }
  }

  for (const n of nodes || []) {
    if (supersededByMap.has(n.uuid) || n.properties?.is_superseded === true) {
      continue;
    }
    const l = (n.label || "").toLowerCase();
    const desc = n.description || n.properties?.description || "";
    const verSpec = n.properties?.verification || n.properties?.facets?.verification;
    if (verSpec) {
      const checkType = typeof verSpec === "string"
        ? "command"
        : Array.isArray(verSpec)
          ? "composite"
          : (verSpec.type || "command");
      const summary = typeof verSpec === "string"
        ? `\`${verSpec}\``
        : (verSpec.description || verSpec.command || verSpec.glob || verSpec.url || checkType);
      executableContracts.push({
        node_name: n.name,
        label: n.label,
        check_type: checkType,
        summary,
        spec: verSpec
      });
    }
    if (l === "rule" || l === "principle") {
      invariants.push({
        rule: n.name,
        statement: desc,
        severity: n.properties?.severity || "high",
        ...(verSpec ? { executable_verification: verSpec } : {})
      });
    } else if (l === "decision") {
      decisions.push({ decision: n.name, rationale: desc });
    } else if (l === "concept" || l === "resource" || l === "component") {
      contracts.push({ name: n.name, kind: n.properties?.kind || l, description: desc });
    }
  }

  const blastRadiusWarnings = [];
  if (targetEntity) {
    const targetNode = nodeMap.get(String(targetEntity).toLowerCase());
    if (targetNode) {
      const dependents = [];
      for (const e of edges || []) {
        if (e.target_uuid === targetNode.uuid && (e.type === "depends_on" || e.type === "requires" || e.type === "implements")) {
          const dep = nodeMap.get(e.source_uuid);
          if (dep) dependents.push(dep.name);
        }
      }
      if (dependents.length > 0) {
        blastRadiusWarnings.push({
          target: targetNode.name,
          dependents,
          risk: dependents.length >= 3 ? "CRITICAL" : "HIGH"
        });
      }
    }
  }

  const mdSections = [
    `# 🛡️ ARCHITECTURAL BOOST BRIEF: ${task || "General Code Task"}`,
    `> Grounded by Blueprint Knowledge Network (Workspace: \`${workspaceId}\`)`,
    "",
    "## 1. Non-Negotiable Invariants & Rules (MUST PRESERVE)",
    ...invariants.map((r) => `- **\`${r.rule}\`**: ${r.statement} [Severity: ${r.severity}]`),
    "",
    "## 2. Key Architecture Decisions & Rationale",
    ...decisions.map((d) => `- **\`${d.decision}\`**: ${d.rationale}`),
    "",
    "## 3. Data Contracts & Schemas",
    ...contracts.map((c) => `- **\`${c.name}\`** (${c.kind}): ${c.description}`),
  ];

  if (blastRadiusWarnings.length > 0) {
    mdSections.push(
      "",
      "## 4. ⚠️ Cascading Blast Radius Warnings (Do Not Break Downstream Consumers)",
      ...blastRadiusWarnings.map((b) => `- Modifying **\`${b.target}\`** impacts: \`${b.dependents.join("`, `")}\` [Risk: ${b.risk}]`)
    );
  }

  if (antiPatterns.length > 0) {
    mdSections.push(
      "",
      "## 5. 🚫 Deprecated Anti-Patterns (DO NOT USE)",
      ...antiPatterns.map((a) => `- ❌ Avoid **\`${a.deprecated}\`**: Superseded by **\`${a.supersededBy}\`** (${a.warning})`)
    );
  }

  if (executableContracts.length > 0) {
    mdSections.push(
      "",
      "## 6. ⚡ Active Executable Verification Contracts (Run `bkn_verify_workspace` Before Completion)",
      ...executableContracts.map((c) => `- **\`${c.node_name}\`** [${c.check_type.toUpperCase()}]: ${c.summary}`)
    );
  }

  return {
    success: true,
    task: task || "General Code Task",
    workspace_id: workspaceId,
    governing_invariants: invariants,
    decisions,
    contracts,
    executable_contracts: executableContracts,
    blast_radius_warnings: blastRadiusWarnings,
    deprecated_anti_patterns: antiPatterns,
    prompt_injection_markdown: mdSections.join("\n")
  };
}

/**
 * Universal execution runner for node verification contracts.
 */
export async function runVerificationSpec(spec, context = {}) {
  const startTime = Date.now();
  const root = context.rootDir || repoRoot;
  const ctx = { ...context, rootDir: root };

  let normalized;
  try {
    normalized = normalizeSpec(spec);
  } catch (err) {
    return {
      passed: false,
      durationMs: Date.now() - startTime,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      results: [{ checkType: "command", passed: false, durationMs: 0, error: String(err?.message || err) }],
      diagnostics: `[Verification Engine] Spec syntax error: ${err?.message || err}`
    };
  }

  const results = [];
  const checkPassed = await dispatchCheck(normalized, ctx, results);

  const durationMs = Date.now() - startTime;
  const passedChecks = results.filter((r) => r.passed).length;
  const failedChecks = results.filter((r) => !r.passed).length;
  const totalChecks = results.length;
  const passed = totalChecks > 0 && checkPassed;

  let diagnostics = "";
  if (passed) {
    diagnostics = `✓ All ${totalChecks} verification checks passed in ${durationMs}ms.`;
  } else {
    const failureSummaries = results
      .filter((r) => !r.passed)
      .map((r, idx) => {
        const desc = r.description ? ` (${r.description})` : "";
        const details = r.error ? `\n    Error: ${r.error}` : "";
        const cmd = r.command ? `\n    Command: ${r.command}` : "";
        const output = r.output ? `\n    Output:\n      ${r.output.trim().split("\n").join("\n      ")}` : "";
        return `  [${idx + 1}] [${r.checkType.toUpperCase()}]${desc}${cmd}${details}${output}`;
      })
      .join("\n");
    diagnostics = `✗ Verification failed: ${failedChecks} of ${totalChecks} checks failed in ${durationMs}ms.\n${failureSummaries}`;
  }

  return {
    passed,
    durationMs,
    totalChecks,
    passedChecks,
    failedChecks,
    results,
    diagnostics
  };
}

function normalizeSpec(raw) {
  if (!raw) throw new Error("Verification spec cannot be empty.");
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return { type: "http", url: trimmed };
    }
    return { type: "command", command: trimmed };
  }
  if (Array.isArray(raw)) {
    return {
      type: "composite",
      checks: raw.map(normalizeSpec),
      mode: "all",
      bailFast: true
    };
  }
  if (typeof raw === "object" && raw !== null) {
    if (raw.type === "composite" || Array.isArray(raw.checks)) {
      const resolvedBail =
        typeof raw.bailFast === "boolean"
          ? raw.bailFast
          : typeof raw.failFast === "boolean"
            ? raw.failFast
            : true;
      return {
        type: "composite",
        checks: (raw.checks || []).map(normalizeSpec),
        mode: raw.mode || raw.operator || "all",
        bailFast: resolvedBail,
        description: raw.description
      };
    }
    if (raw.type === "command" || typeof raw.command === "string") {
      return {
        type: "command",
        command: String(raw.command || "").trim(),
        cwd: raw.cwd,
        timeoutMs: raw.timeoutMs || 30000,
        env: raw.env,
        expectedExitCode: raw.expectedExitCode !== undefined ? raw.expectedExitCode : 0,
        stdoutPattern: raw.stdoutPattern,
        stderrPattern: raw.stderrPattern,
        prohibitedPattern: raw.prohibitedPattern,
        description: raw.description
      };
    }
    if (raw.type === "eval" || raw.script || raw.code) {
      return {
        type: "eval",
        script: String(raw.script || raw.code || "").trim(),
        timeoutMs: raw.timeoutMs || 10000,
        description: raw.description
      };
    }
    if (raw.type === "file_pattern" || raw.files || raw.mustContain || raw.mustNotContain) {
      return {
        type: "file_pattern",
        files: raw.files || "**/*",
        mustContain: raw.mustContain,
        mustNotContain: raw.mustNotContain,
        minMatches: raw.minMatches,
        maxMatches: raw.maxMatches,
        description: raw.description
      };
    }
    if (raw.type === "http" || (typeof raw.url === "string" && raw.url.startsWith("http"))) {
      return {
        type: "http",
        url: String(raw.url),
        method: raw.method || "GET",
        headers: raw.headers,
        body: raw.body,
        expectedStatus: raw.expectedStatus || 200,
        expectedBodyPattern: raw.expectedBodyPattern,
        timeoutMs: raw.timeoutMs || 10000,
        description: raw.description
      };
    }
  }
  throw new Error(`Unrecognized verification spec format: ${JSON.stringify(raw)}`);
}

async function dispatchCheck(check, ctx, results) {
  switch (check.type) {
    case "command": {
      const res = await execCommandCheck(check, ctx);
      results.push(res);
      return res.passed;
    }
    case "eval": {
      const res = await execEvalCheck(check, ctx);
      results.push(res);
      return res.passed;
    }
    case "file_pattern": {
      const res = await execFilePatternCheck(check, ctx);
      results.push(res);
      return res.passed;
    }
    case "http": {
      const res = await execHttpCheck(check, ctx);
      results.push(res);
      return res.passed;
    }
    case "composite": {
      const mode = check.mode || "all";
      const bailFast = check.bailFast !== false;
      if (mode === "any") {
        let anyPassed = false;
        for (const child of (check.checks || [])) {
          const pass = await dispatchCheck(child, ctx, results);
          if (pass) { anyPassed = true; if (bailFast) break; }
        }
        return anyPassed;
      }
      let allPassed = true;
      for (const child of (check.checks || [])) {
        const pass = await dispatchCheck(child, ctx, results);
        if (!pass) { allPassed = false; if (bailFast) break; }
      }
      return allPassed;
    }
    default:
      results.push({ checkType: "command", passed: false, durationMs: 0, error: `Unknown type: ${check.type}` });
      return false;
  }
}

async function execCommandCheck(check, ctx) {
  const start = Date.now();
  const cwd = check.cwd ? (path.isAbsolute(check.cwd) ? check.cwd : path.join(ctx.rootDir, check.cwd)) : ctx.rootDir;
  const timeoutMs = check.timeoutMs || 30000;
  const expectedExitCode = check.expectedExitCode !== undefined ? check.expectedExitCode : 0;

  return new Promise((resolve) => {
    childProcess.exec(check.command, {
      cwd,
      env: { ...process.env, ...(check.env || {}) },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const out = `${stdout || ""}\n${stderr || ""}`.trim();
      const exitCode = error && typeof error.code === "number" ? error.code : (error ? 1 : 0);

      if (exitCode !== expectedExitCode) {
        return resolve({
          checkType: "command",
          command: check.command,
          description: check.description,
          passed: false,
          durationMs,
          exitCode,
          output: out,
          error: `Expected exit code ${expectedExitCode}, got ${exitCode}`
        });
      }

      try {
        if (check.stdoutPattern && !new RegExp(check.stdoutPattern).test(stdout || "")) {
          return resolve({
            checkType: "command",
            command: check.command,
            description: check.description,
            passed: false,
            durationMs,
            exitCode,
            output: out,
            error: `stdout failed to match required pattern /${check.stdoutPattern}/`
          });
        }

        if (check.stderrPattern && !new RegExp(check.stderrPattern).test(stderr || "")) {
          return resolve({
            checkType: "command",
            command: check.command,
            description: check.description,
            passed: false,
            durationMs,
            exitCode,
            output: out,
            error: `stderr failed to match required pattern /${check.stderrPattern}/`
          });
        }

        if (check.prohibitedPattern && new RegExp(check.prohibitedPattern).test(out)) {
          return resolve({
            checkType: "command",
            command: check.command,
            description: check.description,
            passed: false,
            durationMs,
            exitCode,
            output: out,
            error: `Output contained prohibited pattern /${check.prohibitedPattern}/`
          });
        }
      } catch (regexErr) {
        return resolve({
          checkType: "command",
          command: check.command,
          description: check.description,
          passed: false,
          durationMs,
          exitCode,
          output: out,
          error: `Invalid regex pattern in command check: ${regexErr?.message || regexErr}`
        });
      }

      resolve({
        checkType: "command",
        command: check.command,
        description: check.description,
        passed: true,
        durationMs,
        exitCode,
        output: out
      });
    });
  });
}

async function execEvalCheck(check, ctx) {
  const start = Date.now();
  try {
    const sandbox = {
      fs,
      path,
      rootDir: ctx.rootDir,
      filesChanged: ctx.filesChanged || [],
      node: ctx.node || {},
      env: process.env
    };
    const fn = new Function("ctx", `return (async () => { ${check.script} })();`);
    const result = await fn(sandbox);
    const durationMs = Date.now() - start;

    if (result === true || (typeof result === "object" && result !== null && (result.pass === true || result.ok === true))) {
      return {
        checkType: "eval",
        description: check.description,
        passed: true,
        durationMs,
        output: typeof result === "object" ? JSON.stringify(result) : "true",
        details: typeof result === "object" ? (result.details || result) : undefined
      };
    }
    const message = (typeof result === "object" && result !== null && (result.message || result.error)) || `Script returned false: ${JSON.stringify(result)}`;
    return {
      checkType: "eval",
      description: check.description,
      passed: false,
      durationMs,
      error: String(message)
    };
  } catch (err) {
    return {
      checkType: "eval",
      description: check.description,
      passed: false,
      durationMs: Date.now() - start,
      error: `Eval thrown: ${err?.message || err}`
    };
  }
}

function scanDirPattern(rootDir, pattern) {
  const results = [];
  const wildcardIdx = pattern.search(/[*?{[]/);
  const searchBase = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
  const baseDir = path.isAbsolute(searchBase) ? path.dirname(searchBase) : path.join(rootDir, path.dirname(searchBase));
  if (!fs.existsSync(baseDir)) return [];

  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*\//g, '(?:/.+/|/)')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  const matcher = new RegExp(`^${regexPattern}$`);

  function walk(currentDir) {
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '.next', 'out', 'dist'].includes(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (matcher.test(relPath) || relPath.endsWith(pattern) || relPath === pattern) {
          results.push(fullPath);
        }
      }
    }
  }
  walk(baseDir);
  return results;
}

async function execFilePatternCheck(check, ctx) {
  const start = Date.now();
  const root = ctx.rootDir;
  const patterns = Array.isArray(check.files) ? check.files : [check.files];
  const files = [];

  for (const pat of patterns) {
    const candidate = path.isAbsolute(pat) ? pat : path.join(root, pat);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      files.push(candidate);
      continue;
    }
    const scanned = scanDirPattern(root, pat);
    files.push(...scanned);
  }

  const uniqueFiles = Array.from(new Set(files));
  if (uniqueFiles.length === 0) {
    return {
      checkType: "file_pattern",
      description: check.description,
      passed: false,
      durationMs: Date.now() - start,
      error: `No files matched pattern(s): ${JSON.stringify(check.files)}`
    };
  }

  const mustContain = check.mustContain ? (Array.isArray(check.mustContain) ? check.mustContain : [check.mustContain]) : [];
  const mustNotContain = check.mustNotContain ? (Array.isArray(check.mustNotContain) ? check.mustNotContain : [check.mustNotContain]) : [];
  const violations = [];
  let totalMatches = 0;

  for (const file of uniqueFiles) {
    try {
      const content = fs.readFileSync(file, "utf8");
      for (const pat of mustContain) {
        try {
          const matches = content.match(new RegExp(pat, "g"));
          if (!new RegExp(pat).test(content) || !matches || matches.length === 0) {
            violations.push(`${path.relative(root, file)} missing /${pat}/`);
          } else {
            totalMatches += matches.length;
          }
        } catch (regexErr) {
          violations.push(`Invalid regex /${pat}/: ${regexErr?.message || regexErr}`);
        }
      }
      for (const pat of mustNotContain) {
        try {
          if (new RegExp(pat).test(content)) violations.push(`${path.relative(root, file)} contains prohibited /${pat}/`);
        } catch (regexErr) {
          violations.push(`Invalid regex /${pat}/: ${regexErr?.message || regexErr}`);
        }
      }
    } catch (err) {
      violations.push(`Failed reading ${file}: ${err?.message || err}`);
    }
  }

  if (check.minMatches !== undefined && totalMatches < check.minMatches) {
    violations.push(`Expected at least ${check.minMatches} pattern matches, found ${totalMatches}`);
  }
  if (check.maxMatches !== undefined && totalMatches > check.maxMatches) {
    violations.push(`Expected at most ${check.maxMatches} pattern matches, found ${totalMatches}`);
  }

  const durationMs = Date.now() - start;
  if (violations.length > 0) {
    return {
      checkType: "file_pattern",
      description: check.description,
      passed: false,
      durationMs,
      error: violations.join("; ")
    };
  }

  return {
    checkType: "file_pattern",
    description: check.description,
    passed: true,
    durationMs,
    output: `File pattern invariant satisfied across ${uniqueFiles.length} files.`
  };
}

async function execHttpCheck(check) {
  const start = Date.now();
  const method = check.method || "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs || 10000);

  try {
    const res = await fetch(check.url, {
      method,
      headers: check.headers,
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    const durationMs = Date.now() - start;
    const expected = Array.isArray(check.expectedStatus) ? check.expectedStatus : [check.expectedStatus || 200];

    if (!expected.includes(res.status)) {
      return {
        checkType: "http",
        description: check.description,
        passed: false,
        durationMs,
        error: `Expected HTTP ${expected.join(" or ")}, got ${res.status}`
      };
    }

    const bodyPat = check.expectedBodyPattern || check.bodyPattern;
    if (bodyPat) {
      if (!new RegExp(bodyPat).test(text)) {
        return {
          checkType: "http",
          description: check.description,
          passed: false,
          durationMs,
          error: `HTTP response body failed to match required pattern /${bodyPat}/`
        };
      }
    }

    return {
      checkType: "http",
      description: check.description,
      passed: true,
      durationMs,
      output: `HTTP ${res.status} OK`
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      checkType: "http",
      description: check.description,
      passed: false,
      durationMs: Date.now() - start,
      error: `HTTP probe failed: ${err?.message || err}`
    };
  }
}

export async function verifyNode(supabase, workspaceIdInput, nodeIdentifier, filesChanged = [], customSpec = null) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const node = await resolveNode(supabase, workspaceId, nodeIdentifier);

  const props = node.properties || {};
  const spec = customSpec || props.verification || props.executable_contract || props.rule_details?.verification;

  if (!spec) {
    return {
      success: true,
      node_name: node.name,
      node_uuid: node.uuid,
      verified: false,
      duration_ms: 0,
      diagnostics: `Node '${node.name}' (${node.label}) has no executable verification contract defined. Set 'properties.verification' to enable automated verification.`,
      result: null
    };
  }

  const vResult = await runVerificationSpec(spec, {
    rootDir: repoRoot,
    filesChanged: Array.isArray(filesChanged) ? filesChanged : [],
    node: {
      uuid: node.uuid,
      name: node.name,
      label: node.label,
      properties: props
    }
  });

  return {
    success: true,
    node_name: node.name,
    node_uuid: node.uuid,
    verified: vResult.passed,
    duration_ms: vResult.durationMs,
    diagnostics: vResult.diagnostics,
    result: vResult
  };
}

export async function verifyWorkspace(supabase, workspaceIdInput, label = null, limit = 20) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);

  let query = supabase
    .from("bkn_nodes")
    .select("uuid, name, label, properties")
    .eq("blueprint_id", workspaceId)
    .or("is_archived.is.null,is_archived.eq.false")
    .limit(limit);

  if (label) {
    query = query.ilike("label", label);
  }

  const { data: nodes, error } = await query;
  if (error) throw error;

  const results = [];
  let totalContracts = 0;
  let passedContracts = 0;
  let failedContracts = 0;

  for (const node of (nodes || [])) {
    const props = node.properties || {};
    const spec = props.verification || props.executable_contract || props.rule_details?.verification;
    if (!spec) continue;

    totalContracts++;
    const vResult = await runVerificationSpec(spec, {
      rootDir: repoRoot,
      node: {
        uuid: node.uuid,
        name: node.name,
        label: node.label,
        properties: props
      }
    });

    if (vResult.passed) {
      passedContracts++;
    } else {
      failedContracts++;
    }

    results.push({
      node_name: node.name,
      node_uuid: node.uuid,
      label: node.label,
      verified: vResult.passed,
      duration_ms: vResult.durationMs,
      diagnostics: vResult.diagnostics
    });
  }

  const allPassed = totalContracts > 0 && failedContracts === 0;
  const diagnostics = totalContracts === 0
    ? "No nodes with executable verification contracts found in workspace."
    : `${passedContracts} of ${totalContracts} verification contracts passed (${failedContracts} failed).`;

  return {
    success: true,
    all_passed: allPassed,
    total_contracts: totalContracts,
    passed_contracts: passedContracts,
    failed_contracts: failedContracts,
    diagnostics,
    node_results: results
  };
}

const CORE_COMPOSIO_SHORTHANDS = {
  "gmail.list_emails": "GMAIL_FETCH_EMAILS",
  "gmail.fetch_emails": "GMAIL_FETCH_EMAILS",
  "gmail.create_draft": "GMAIL_CREATE_EMAIL_DRAFT",
  "gmail.send_email": "GMAIL_SEND_EMAIL",
  "gmail.reply": "GMAIL_REPLY_TO_THREAD",
  "outlook.list_messages": "OUTLOOK_LIST_MESSAGES",
  "outlook.create_draft": "OUTLOOK_CREATE_DRAFT",
  "outlook.send_email": "OUTLOOK_SEND_EMAIL",
  "slack.list_channels": "SLACK_LIST_ALL_CHANNELS",
  "slack.read_channel": "SLACK_FETCH_CONVERSATION_HISTORY",
  "slack.search_messages": "SLACK_SEARCH_MESSAGES",
  "slack.send_message": "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
  "slack.post": "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
  "discord.list_channels": "DISCORD_LIST_MY_CHANNELS",
  "discord.read_messages": "DISCORD_GET_CHANNEL_MESSAGES",
  "discord.send_message": "DISCORD_SEND_MESSAGE",
  "telegram.get_updates": "TELEGRAM_GET_UPDATES",
  "telegram.send_message": "TELEGRAM_SEND_MESSAGE",
  "googlecalendar.list_events": "GOOGLECALENDAR_EVENTS_LIST",
  "googlecalendar.create_event": "GOOGLECALENDAR_CREATE_EVENT",
  "github.list_repos": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
  "github.create_issue": "GITHUB_CREATE_AN_ISSUE",
  "github.create_pr": "GITHUB_CREATE_A_PULL_REQUEST",
  "linear.list_issues": "LINEAR_LIST_LINEAR_ISSUES",
  "linear.create_issue": "LINEAR_CREATE_LINEAR_ISSUE",
  "linear.list_teams": "LINEAR_GET_ALL_LINEAR_TEAMS",
  "notion.search": "NOTION_SEARCH_NOTION_PAGE",
  "notion.create_page": "NOTION_CREATE_NOTION_PAGE"
};

const CORE_INTEGRATIONS_CATALOG = [
  { slug: "gmail", name: "Gmail", category: "Communication", actions: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"] },
  { slug: "outlook", name: "Microsoft Outlook", category: "Communication", actions: ["OUTLOOK_LIST_MESSAGES", "OUTLOOK_CREATE_DRAFT", "OUTLOOK_SEND_EMAIL"] },
  { slug: "slack", name: "Slack", category: "Communication", actions: ["SLACK_LIST_ALL_CHANNELS", "SLACK_FETCH_CONVERSATION_HISTORY", "SLACK_SEARCH_MESSAGES", "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL"] },
  { slug: "discord", name: "Discord", category: "Communication", actions: ["DISCORD_LIST_MY_CHANNELS", "DISCORD_GET_CHANNEL_MESSAGES", "DISCORD_SEND_MESSAGE"] },
  { slug: "telegram", name: "Telegram", category: "Communication", actions: ["TELEGRAM_GET_UPDATES", "TELEGRAM_SEND_MESSAGE"] },
  { slug: "github", name: "GitHub", category: "Developer Tools", actions: ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "GITHUB_CREATE_AN_ISSUE", "GITHUB_CREATE_A_PULL_REQUEST", "GITHUB_GET_REPOSITORY_CONTENT"] },
  { slug: "linear", name: "Linear", category: "Developer Tools", actions: ["LINEAR_LIST_LINEAR_ISSUES", "LINEAR_CREATE_LINEAR_ISSUE", "LINEAR_GET_ALL_LINEAR_TEAMS"] },
  { slug: "notion", name: "Notion", category: "Productivity", actions: ["NOTION_SEARCH_NOTION_PAGE", "NOTION_CREATE_NOTION_PAGE", "NOTION_ADD_PAGE_CONTENT"] },
  { slug: "googlecalendar", name: "Google Calendar", category: "Productivity", actions: ["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_QUICK_ADD_EVENT"] },
  { slug: "googledocs", name: "Google Docs", category: "Productivity", actions: ["GOOGLEDOCS_GET_DOCUMENT_BY_ID", "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN"] },
  { slug: "googlesheets", name: "Google Sheets", category: "Productivity", actions: ["GOOGLESHEETS_BATCH_GET", "GOOGLESHEETS_CREATE_GOOGLE_SHEET1", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"] },
  { slug: "googledrive", name: "Google Drive", category: "Productivity", actions: ["GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT"] },
  { slug: "jira", name: "Jira", category: "Developer Tools", actions: ["JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET", "JIRA_CREATE_ISSUE"] },
  { slug: "hubspot", name: "HubSpot", category: "CRM", actions: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"] }
];

function normalizeMcpIntegrationSlug(rawAction) {
  const trimmed = String(rawAction || "").trim().replace(/^composio\./i, "");
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (CORE_COMPOSIO_SHORTHANDS[lower]) {
    return CORE_COMPOSIO_SHORTHANDS[lower];
  }
  return trimmed
    .replace(/[./-]/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

export async function listIntegrations(
  supabase,
  workspaceIdInput,
  query = "",
  category = "",
  includeRecipes = true
) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  let connectedIntegrations = [];
  let entityCache = {};

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, email, preferences")
      .limit(1)
      .maybeSingle();
    const prefs = profile?.preferences || {};
    if (Array.isArray(prefs.connected_integrations)) {
      connectedIntegrations = prefs.connected_integrations.map((s) => String(s).toLowerCase());
    }
    if (prefs.integration_entities && typeof prefs.integration_entities === "object") {
      entityCache = prefs.integration_entities;
    }
  } catch {}

  const q = String(query || "").trim().toLowerCase();
  const cat = String(category || "").trim().toLowerCase();
  const connectedSet = new Set(connectedIntegrations);

  const catalogMatches = CORE_INTEGRATIONS_CATALOG.filter((item) => {
    if (cat && !item.category.toLowerCase().includes(cat)) return false;
    if (!q) return true;
    return (
      item.slug.includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.actions.some((a) => a.toLowerCase().includes(q))
    );
  }).map((item) => ({
    slug: item.slug,
    name: item.name,
    category: item.category,
    connected: connectedSet.has(item.slug),
    actions: item.actions
  }));

  const recipes = includeRecipes
    ? CORE_INTEGRATIONS_CATALOG.filter(
        (item) => connectedSet.size === 0 || connectedSet.has(item.slug) || (q && item.slug.includes(q))
      ).map((item) => ({
        toolkit: item.slug,
        label: item.name,
        actions: item.actions
      }))
    : [];

  return {
    success: true,
    workspace_id: workspaceId,
    connected_integrations: connectedIntegrations,
    count: connectedIntegrations.length,
    recipes,
    catalog_matches: catalogMatches,
    cached_entities: entityCache
  };
}

export async function executeIntegration(
  supabase,
  workspaceIdInput,
  action,
  rawArgs = {},
  options = {}
) {
  const workspaceId = await resolveWorkspaceId(supabase, workspaceIdInput);
  const resolvedSlug = normalizeMcpIntegrationSlug(action);
  if (!resolvedSlug) {
    throw new Error("Missing required parameter: 'action'");
  }

  const effectiveArgs = { ...(rawArgs || {}) };
  if (resolvedSlug.startsWith("GITHUB_")) {
    const repoVal = typeof effectiveArgs.repo === "string" ? effectiveArgs.repo.trim() : "";
    if (repoVal.includes("/")) {
      const [ownerPart, repoPart] = repoVal.split("/", 2);
      if (ownerPart && repoPart) {
        if (!effectiveArgs.owner) effectiveArgs.owner = ownerPart.trim();
        effectiveArgs.repo = repoPart.trim();
      }
    }
  }
  if (resolvedSlug.startsWith("GMAIL_") && !effectiveArgs.user_id) {
    effectiveArgs.user_id = "me";
  }
  if (resolvedSlug.startsWith("GOOGLECALENDAR_") && !effectiveArgs.calendar_id) {
    effectiveArgs.calendar_id = "primary";
  }

  let targetUserId = options.userId || null;
  if (!targetUserId) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .limit(1)
        .maybeSingle();
      if (profile?.id) targetUserId = profile.id;
    } catch {}
  }

  const composioApiKey = process.env.COMPOSIO_API_KEY || "";
  if (!composioApiKey) {
    return {
      success: false,
      action,
      resolved_slug: resolvedSlug,
      data: null,
      ingested_nodes_count: 0,
      message: `COMPOSIO_API_KEY is not configured in environment; cannot execute external action '${resolvedSlug}'.`
    };
  }

  const reqBody = {
    arguments: effectiveArgs,
    ...(targetUserId ? { user_id: targetUserId } : {}),
    ...(options.connectedAccountId ? { connected_account_id: options.connectedAccountId } : {})
  };

  const res = await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${encodeURIComponent(resolvedSlug)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": composioApiKey
    },
    body: JSON.stringify(reqBody)
  });

  const payload = await res.json().catch(() => ({}));
  const ok = res.ok && payload?.successful !== false;
  const data = payload?.data ?? payload ?? null;
  let ingestedNodesCount = 0;

  if (ok && options.ingestToGraph && data) {
    try {
      const created = await createNode(
        supabase,
        workspaceId,
        `${resolvedSlug} Output`,
        "Insight",
        typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500),
        { source: "composio_mcp", action: resolvedSlug }
      );
      if (created?.success) ingestedNodesCount = 1;
    } catch {}
  }

  return {
    success: ok,
    action,
    resolved_slug: resolvedSlug,
    data,
    ingested_nodes_count: ingestedNodesCount,
    message: ok
      ? `Executed Composio action '${resolvedSlug}' successfully.`
      : String(payload?.error?.message || payload?.message || `Composio action '${resolvedSlug}' failed (${res.status}).`)
  };
}

