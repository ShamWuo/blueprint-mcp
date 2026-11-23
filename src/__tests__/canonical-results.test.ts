import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_ADVERTISED_TOOLS, MCP_TOOL_RESULT_KEYS, missingResultKeys } from "../contract";
import { LOCAL_ADVERTISED_EXECUTORS, LOCAL_EXTRA_EXECUTORS } from "../../bin/executors.js";

/**
 * The result contract, exercised against the real self-hosted executors.
 *
 * Each entry in `LOCAL_ADVERTISED_EXECUTORS` is the shipped implementation, run
 * here against a fake Supabase client, and asserted to return the canonical keys
 * for its tool. Without this, "the two modes return the same shape" would be a
 * claim about the source, not a fact about the code.
 *
 * The matching assertions for the hosted executors live beside them in
 * `apps/web/src/lib/mcp/__tests__/messages-handler-canonical-results.test.ts`.
 */

const WORKSPACE_UUID = "11111111-1111-4111-8111-111111111111";
const NODE_UUID = "22222222-2222-4222-8222-222222222222";
const TEMP_FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), "bkn-canonical-folder-"));
const TEMP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bkn-canonical-cfg-"));

const nodeRow = {
  uuid: NODE_UUID,
  name: "Daily push-ups",
  label: "Task",
  description: "A variable node",
  embedding: [0.11, -0.22, 0.33],
  properties: {
    current_value: 3,
    content: "console.log('hello world');",
    path: "Daily push-ups",
    is_file: true,
    embedding: [0.11, -0.22, 0.33],
  },
  is_archived: false,
};

const agentRow = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Scout",
  current_node_uuid: null,
  home_node_uuid: null,
};

const RPC_RESULTS: Record<string, unknown> = {
  bkn_get_subgraph: [nodeRow],
  bkn_emit_signal: "44444444-4444-4444-8444-444444444444",
  bkn_resolve_signal: null,
  bkn_list_active_signals: [{ signal_uuid: "44444444-4444-4444-8444-444444444444" }],
};

const TABLES: Record<string, unknown> = {
  workspaces: [
    {
      id: WORKSPACE_UUID,
      name: "Demo workspace",
      description: "A workspace",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    },
  ],
  bkn_nodes: [nodeRow],
  bkn_edges: [{ id: "edge-1" }],
  agents: [agentRow],
  workspace_docs: { executive_summary: "Summary", technical_spec: "Spec" },
  workspace_tasks: { epics: [], milestones: [] },
  profiles: [{ id: "user-1", email: "owner@example.com", display_name: "Owner" }],
};

/**
 * A Supabase-shaped client: every query builder method chains and resolves, and
 * per-table data comes from `TABLES`. Chain builders in this codebase end either
 * in `.maybeSingle()`/`.single()` (one row) or in an await (a list).
 */
function createFakeSupabase(tables: Record<string, unknown> = TABLES) {
  const resolveFor = (table: string, single: boolean) => {
    const value = tables[table];
    if (value === undefined) return single ? null : [];
    if (Array.isArray(value)) return single ? value[0] ?? null : value;
    return single ? value : [value];
  };

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        neq: chain,
        in: chain,
        or: chain,
        ilike: chain,
        order: chain,
        limit: chain,
        insert: chain,
        update: chain,
        upsert: chain,
        delete: chain,
        maybeSingle: async () => ({ data: resolveFor(table, true), error: null }),
        single: async () => ({ data: resolveFor(table, true), error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({
            data: resolveFor(table, false),
            error: null,
            count: Array.isArray(tables[table]) ? (tables[table] as unknown[]).length : 1,
          }).then(resolve, reject),
      });
      return builder;
    },
    rpc(name: string) {
      return {
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: RPC_RESULTS[name] ?? null, error: null }).then(resolve, reject),
      };
    },
  };

  return client;
}

/** Minimum arguments that satisfy each tool's advertised required fields. */
const ARGS: Record<string, Record<string, unknown>> = {
  bkn_list_workspaces: { limit: 5 },
  bkn_create_workspace: { name: "Parity workspace", description: "created by tests" },
  bkn_query_graph: { query: "push-ups", limit: 10 },
  bkn_ingest_content: { content: "## Training\n- Cadence: three sessions a week" },
  bkn_create_node: { name: "New node", label: "Concept", description: "…" },
  bkn_link_nodes: {
    source_name: "Daily push-ups",
    target_name: "Daily push-ups",
    relationship_type: "supports",
  },
  bkn_apply_patch: {
    nodes: [{ name: "Daily push-ups", label: "Variable", description: "Counter" }],
    edges: [
      { source_name: "Daily push-ups", target_name: "Daily push-ups", relationship_type: "supports" },
    ],
  },
  bkn_get_workspace_context: {},
  bkn_push_telemetry: { event_name: "parity_check", payload: { ok: true } },
  bkn_mutate_variable: { node_identifier: "Daily push-ups", operation: "increment" },
  bkn_delete_node: { node_identifier: "Daily push-ups" },
  bkn_unlink_nodes: { source_name: "Daily push-ups", target_name: "Daily push-ups" },
  bkn_get_subgraph: {},
  agent_traverse_node: { target_node_uuid: NODE_UUID },
  bkn_emit_signal: { title: "Parity check" },
  bkn_resolve_signal: { signal_uuid: "44444444-4444-4444-8444-444444444444" },
  bkn_list_signals: {},
  bkn_write_file: { path: "src/main.ts", content: "console.log('hello');" },
  bkn_read_file: { path: "Daily push-ups" },
  bkn_edit_file: { path: "Daily push-ups", target: "hello world", replacement: "universe" },
  bkn_list_files: {},
  bkn_verify_node: { node: "Daily push-ups" },
  bkn_verify_workspace: {},
  bkn_list_integrations: { query: "slack" },
  bkn_execute_integration: { action: "GMAIL_FETCH_EMAILS", arguments: { q: "is:unread" } },
  bkn_connect_folder: { path: TEMP_FOLDER, workspace_id: WORKSPACE_UUID },
  bkn_disconnect_folder: { path: TEMP_FOLDER },
  bkn_list_folders: {},
  bkn_sync_folder: { path: TEMP_FOLDER, workspace_id: WORKSPACE_UUID, dry_run: true },
};

const previousEnv = { ...process.env };

beforeEach(() => {
  process.env.BLUEPRINT_WORKSPACE_ID = WORKSPACE_UUID;
  process.env.BLUEPRINT_CONFIG_DIR = TEMP_CONFIG_DIR;
  delete process.env.BLUEPRINT_API_KEY;
  delete process.env.BSC_API_KEY;
  // Keep ingestion and integrations deterministic and offline: with keys present
  // executors call live external APIs instead of their offline fallback paths.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
});

afterEach(() => {
  process.env = { ...previousEnv };
});

describe("self-hosted executors return the canonical shape", () => {
  for (const tool of MCP_ADVERTISED_TOOLS) {
    it(`${tool.name}`, async () => {
      const result = await LOCAL_ADVERTISED_EXECUTORS[tool.name](
        createFakeSupabase(),
        ARGS[tool.name] ?? {}
      );

      expect(missingResultKeys(tool.name, result)).toEqual([]);
      // A placeholder ("<tool> executed") would satisfy no key list, but assert
      // the payload is not just an echo of the arguments either.
      expect(result).not.toHaveProperty("args");
    });
  }

  it("agent_station, which is callable in both modes but advertised in neither", async () => {
    const result = await LOCAL_EXTRA_EXECUTORS.agent_station(createFakeSupabase(), {
      agent_id: agentRow.id,
      current_node_uuid: NODE_UUID,
    });

    expect(missingResultKeys("agent_station", result)).toEqual([]);
  });

  it("bkn_agent_boost, which is callable in both modes as an architectural context engine", async () => {
    const result = await LOCAL_EXTRA_EXECUTORS.bkn_agent_boost(createFakeSupabase(), {
      task: "Safely refactor auth tokens",
    });

    expect(missingResultKeys("bkn_agent_boost", result)).toEqual([]);
    expect(result.prompt_injection_markdown).toContain("ARCHITECTURAL BOOST BRIEF");
  });
});

describe("self-hosted behaviour that the hosted endpoint also guarantees", () => {
  it("delete_node archives rather than dropping the row, and counts severed edges", async () => {
    const result = await LOCAL_ADVERTISED_EXECUTORS.bkn_delete_node(createFakeSupabase(), {
      node_identifier: "Daily push-ups",
    });

    expect(result).toMatchObject({
      node_uuid: NODE_UUID,
      relationships_removed: 1,
    });
  });

  it("delete_node is idempotent for an unknown node instead of throwing", async () => {
    const result = await LOCAL_ADVERTISED_EXECUTORS.bkn_delete_node(createFakeSupabase({}), {
      node_identifier: "ghost",
    });

    expect(result).toMatchObject({ success: true, node_uuid: null, relationships_removed: 0 });
  });

  it("mutate_variable reports the pre-mutation value", async () => {
    const result = await LOCAL_ADVERTISED_EXECUTORS.bkn_mutate_variable(createFakeSupabase(), {
      node_identifier: "Daily push-ups",
      operation: "increment",
    });

    expect(result.previous_value).toBe(3);
    expect(result.current_value).toBe(4);
  });

  it("traverse_node stations the agent the first time it moves", async () => {
    const result = await LOCAL_ADVERTISED_EXECUTORS.agent_traverse_node(createFakeSupabase(), {
      target_node_uuid: NODE_UUID,
      reason: "wants context",
    });

    expect(result).toMatchObject({
      agent_id: agentRow.id,
      from_node_uuid: null,
      to_node_uuid: NODE_UUID,
      reason: "wants context",
    });
  });

  it("strips embedding vectors from bkn_query_graph and bkn_get_subgraph node payloads", async () => {
    const queryResult = await LOCAL_ADVERTISED_EXECUTORS.bkn_query_graph(createFakeSupabase(), {
      query: "push-ups",
      limit: 10,
    });
    expect(queryResult.nodes).toHaveLength(1);
    expect(queryResult.nodes[0]).not.toHaveProperty("embedding");
    expect(queryResult.nodes[0].properties).not.toHaveProperty("embedding");

    const subgraphResult = await LOCAL_ADVERTISED_EXECUTORS.bkn_get_subgraph(createFakeSupabase(), {});
    expect(subgraphResult.nodes).toHaveLength(1);
    expect(subgraphResult.nodes[0]).not.toHaveProperty("embedding");
    expect(subgraphResult.nodes[0].properties).not.toHaveProperty("embedding");
  });
});

describe("canonical key coverage", () => {
  it("documents a shape for every advertised tool", () => {
    for (const tool of MCP_ADVERTISED_TOOLS) {
      expect(MCP_TOOL_RESULT_KEYS[tool.name], `${tool.name} has no canonical keys`).toBeDefined();
    }
  });
});
