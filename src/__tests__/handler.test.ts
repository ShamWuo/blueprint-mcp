import { describe, it, expect, vi } from "vitest";
import { handleMCPRequest, MCPRequest, MCPHandlerContext } from "../handler";
import { MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from "../contract";
import { MCP_TOOLS } from "../tools";

describe("MCP Server Handler", () => {
  const defaultContext: MCPHandlerContext = {
    workspaceId: "test-workspace-uuid",
    apiKeyId: "test-key-uuid",
    clientName: "test-client",
  };

  it("handles initialize method and returns protocol version & capabilities", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.jsonrpc).toBe("2.0");
    expect(response?.id).toBe(1);
    // Identity comes from the contract, not from this transport: the hosted
    // endpoint and the self-hosted bundle must announce the same server.
    expect(response?.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
      },
    });
  });

  it("handles notifications/initialized method and returns null (no response payload)", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response).toBeNull();
  });

  it("lists all registered MCP tools", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.result?.tools).toHaveLength(MCP_TOOLS.length);
    expect(response?.result?.tools).toEqual(MCP_TOOLS);
  });

  it("executes tools/call with custom context executor for bkn_query_graph", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ nodes: [{ id: "node-1", name: "Auth" }] });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeQueryGraph: mockQuery,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "bkn_query_graph",
        arguments: { query: "Auth" },
      },
    };

    const response = await handleMCPRequest(request, context);
    expect(mockQuery).toHaveBeenCalledWith({ query: "Auth" });
    expect(response?.result?.content[0]?.type).toBe("text");
    expect(response?.result?.content[0]?.text).toContain("node-1");
  });

  it("returns error code -32603 when backend handler is unconfigured", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "bkn_query_graph",
        arguments: { query: "Auth" },
      },
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.error?.code).toBe(-32603);
    expect(response?.error?.message).toContain("Backend handler for tool 'bkn_query_graph' is not configured");
  });

  it("returns error code -32601 when calling an unknown tool", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "unknown_nonexistent_tool",
      },
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.error?.code).toBe(-32601);
    expect(response?.error?.message).toContain("Tool not found: unknown_nonexistent_tool");
  });

  it("lists resources including workspace BKN graph export", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 8,
      method: "resources/list",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.result?.resources[0]?.uri).toBe(`blueprint://workspace/test-workspace-uuid/bkn`);
  });

  it("lists available MCP prompt templates", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 9,
      method: "prompts/list",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.result?.prompts[0]?.name).toBe("ingest_app_state");
  });

  it("returns error code -32601 for unknown jsonrpc methods", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 10,
      method: "unknown/method",
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.error?.code).toBe(-32601);
  });

  it("returns error code -32602 when required tool parameters are missing", async () => {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "bkn_ingest_content",
        arguments: {}, // missing required 'content'
      },
    };

    const response = await handleMCPRequest(request, defaultContext);
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("Missing required parameter: 'content'");
  });

  it("executes bkn_create_workspace with custom context executor", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      success: true,
      workspace: { id: "new-ws-id", name: "Growth Engine" },
    });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeCreateWorkspace: mockCreate,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "bkn_create_workspace",
        arguments: { name: "Growth Engine", description: "Marketing" },
      },
    };

    const response = await handleMCPRequest(request, context);
    expect(mockCreate).toHaveBeenCalledWith({ name: "Growth Engine", description: "Marketing" });
    expect(response?.result?.content[0]?.type).toBe("text");
    expect(response?.result?.content[0]?.text).toContain("new-ws-id");
  });

  it("executes bkn_list_workspaces with custom context executor", async () => {
    const mockList = vi.fn().mockResolvedValue({
      workspaces: [{ id: "ws-1", name: "Alpha", node_count: 5 }],
      count: 1,
    });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeListWorkspaces: mockList,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "bkn_list_workspaces",
        arguments: { limit: 5 },
      },
    };

    const response = await handleMCPRequest(request, context);
    expect(mockList).toHaveBeenCalledWith({ limit: 5 });
    expect(response?.result?.content[0]?.type).toBe("text");
    expect(response?.result?.content[0]?.text).toContain("ws-1");
  });

  it("executes bkn_delete_node with custom context executor", async () => {
    const mockDelete = vi.fn().mockResolvedValue({ success: true, message: "Node deleted" });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeDeleteNode: mockDelete,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "bkn_delete_node",
        arguments: { node_identifier: "node-to-delete" },
      },
    };

    const response = await handleMCPRequest(request, context);
    expect(mockDelete).toHaveBeenCalledWith({ node_identifier: "node-to-delete" });
    expect(response?.result?.content[0]?.text).toContain("Node deleted");
  });

  it("executes bkn_unlink_nodes with custom context executor", async () => {
    const mockUnlink = vi.fn().mockResolvedValue({ success: true, message: "Edge removed" });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeUnlinkNodes: mockUnlink,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "bkn_unlink_nodes",
        arguments: { source_name: "A", target_name: "B" },
      },
    };

    const response = await handleMCPRequest(request, context);
    expect(mockUnlink).toHaveBeenCalledWith({ source_name: "A", target_name: "B" });
    expect(response?.result?.content[0]?.text).toContain("Edge removed");
  });

  it("filters out top-level and nested embedding fields before returning JSON to the AI agent", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      nodes: [
        {
          uuid: "node-1",
          name: "Auth Token Rule",
          label: "Rule",
          description: "Rotate tokens every 15 minutes",
          embedding: [0.012, -0.044, 0.918],
          properties: {
            enforcement: "strict",
            embedding: [0.012, -0.044, 0.918],
          },
        },
      ],
      relationships: [],
      count: 1,
      relationship_count: 0,
    });
    const context: MCPHandlerContext = {
      ...defaultContext,
      executeQueryGraph: mockQuery,
    };

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "bkn_query_graph",
        arguments: { query: "Auth" },
      },
    };

    const response = await handleMCPRequest(request, context);
    const payloadText = response?.result?.content[0]?.text ?? "";
    const parsed = JSON.parse(payloadText);

    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].name).toBe("Auth Token Rule");
    expect(parsed.nodes[0].properties.enforcement).toBe("strict");
    expect(parsed.nodes[0]).not.toHaveProperty("embedding");
    expect(parsed.nodes[0].properties).not.toHaveProperty("embedding");
    expect(payloadText).not.toContain('"embedding"');
  });
});
