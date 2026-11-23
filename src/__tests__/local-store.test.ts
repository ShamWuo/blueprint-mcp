import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
// @ts-ignore
import { createLocalStoreExecutors } from "../../bin/local-executors.js";
// @ts-ignore
import { LocalBKNStore } from "../../bin/local-store.generated.js";

describe("MCP Local-First File Store Executors", () => {
  let tmpDir: string;
  let bknDir: string;
  let executors: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bkn-mcp-test-"));
    bknDir = path.join(tmpDir, ".bkn");
    executors = createLocalStoreExecutors(bknDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("lists local workspace and creates new nodes", async () => {
    const wsList = await executors.bkn_list_workspaces();
    expect(wsList).toHaveLength(1);
    expect(wsList[0].mode).toBe("local_filesystem");

    const created = await executors.bkn_create_node(null, {
      name: "Authentication Engine",
      label: "Decision",
      description: "JWT and SSR session verification logic.",
      metadata: { priority: "high" },
    });

    expect(created.success).toBe(true);
    expect(created.name).toBe("Authentication Engine");

    // Check the node file is the portable YAML the CLI also writes
    const nodeFile = path.join(bknDir, "nodes", "authentication-engine.yaml");
    const content = await fs.readFile(nodeFile, "utf8");
    expect(content).toContain("key: authentication-engine");
    expect(content).toContain("label: Decision");
    expect(content).toContain("JWT and SSR session verification logic.");
    expect(await fs.readFile(path.join(bknDir, "graph.yaml"), "utf8")).toContain("bkn_version: 1");
  });

  it("links nodes and queries the local graph", async () => {
    await executors.bkn_create_node(null, {
      name: "API Gateway",
      label: "Architecture",
      description: "Routes incoming requests to microservices.",
    });

    await executors.bkn_create_node(null, {
      name: "Billing Pipeline",
      label: "Workflow",
      description: "Stripe webhook and subscription reconciler.",
    });

    const link = await executors.bkn_link_nodes(null, {
      source_name: "api-gateway",
      target_name: "billing-pipeline",
      relationship_type: "depends_on",
      description: "Routes payment webhooks",
    });

    expect(link.success).toBe(true);
    expect(link.type).toBe("depends_on");

    // Query graph
    const queryRes = await executors.bkn_query_graph(null, {
      query: "billing",
    });

    expect(queryRes.nodes).toHaveLength(1);
    expect(queryRes.nodes[0].name).toBe("Billing Pipeline");
    expect(queryRes.relationships).toHaveLength(1);
  });

  it("writes, reads, and edits files in the project", async () => {
    const testFilePath = path.join(tmpDir, "config.ts");
    await executors.bkn_write_file(null, {
      path: testFilePath,
      content: "export const API_VERSION = 'v1';",
    });

    const read = await executors.bkn_read_file(null, { path: testFilePath });
    expect(read.content).toBe("export const API_VERSION = 'v1';");

    await executors.bkn_edit_file(null, {
      path: testFilePath,
      old_str: "'v1'",
      new_str: "'v2'",
    });

    const updated = await executors.bkn_read_file(null, { path: testFilePath });
    expect(updated.content).toBe("export const API_VERSION = 'v2';");
  });

  it("supports bkn_get_related_nodes and bkn_agent_boost in local mode with canonical result keys", async () => {
    const { missingResultKeys } = await import("../contract");
    const { logDecision } = await import("../../bin/core.js");

    await executors.bkn_create_node(null, {
      name: "Opaque Surface Rule",
      label: "Rule",
      description: "Never use transparent icon backgrounds.",
      verification: "npm run lint",
    });

    await executors.bkn_create_node(null, {
      name: "Sidebar Component",
      label: "Concept",
      description: "Primary workspace navigation rail.",
    });

    await executors.bkn_link_nodes(null, {
      source_name: "Opaque Surface Rule",
      target_name: "Sidebar Component",
      relationship_type: "governs",
    });

    const related = await executors.bkn_get_related_nodes(null, {
      node: "Opaque Surface Rule",
    });
    expect(missingResultKeys("bkn_get_related_nodes", related)).toEqual([]);
    expect(related.count).toBe(1);
    expect(related.related[0].name).toBe("Sidebar Component");

    const boost = await executors.bkn_agent_boost(null, {
      task: "Refactor Sidebar",
    });
    expect(missingResultKeys("bkn_agent_boost", boost)).toEqual([]);
    expect(boost.prompt_injection_markdown).toContain("Opaque Surface Rule");

    // Verify logDecision mirrors Decision node to .bkn when graph.yaml exists
    const logged = await logDecision(
      "Use Portable YAML for Local Memory",
      "Ensures zero-latency git-tracked agent recall",
      "Antigravity",
      { rootDir: tmpDir }
    );
    expect(logged.bknNodeKey).toBe("use-portable-yaml-for-local-memory");
    const mirrored = await executors.bkn_query_graph(null, {
      query: "Portable YAML",
    });
    expect(missingResultKeys("bkn_query_graph", mirrored)).toEqual([]);
    expect(mirrored.nodes.some((n: any) => n.name === "Use Portable YAML for Local Memory")).toBe(true);
  });
});
