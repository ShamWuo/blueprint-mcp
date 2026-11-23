import {
  MCP_ADVERTISED_TOOLS,
  MCP_EXTRA_TOOL_EXECUTORS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_TOOL_EXECUTORS,
  type MCPExecutorKey,
  type MCPExecutorMap,
} from "./contract";

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Executors are optional so a deployment can wire a subset; the transport answers
 * `-32603` for a tool whose executor is genuinely absent. Every tool the server
 * *advertises* must have one (see `MCP_TOOL_EXECUTORS` and the contract test).
 */
export type MCPHandlerContext = {
  workspaceId: string;
  apiKeyId: string;
  clientName?: string;
  isAdmin?: boolean;
} & Partial<MCPExecutorMap>;

function validateToolArguments(toolName: string, args: any): string | null {
  const def = MCP_ADVERTISED_TOOLS.find((t: any) => t.name === toolName);
  if (!def) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "Arguments must be a valid JSON object";
  }
  const required = def.inputSchema?.required || [];
  for (const field of required) {
    if (
      args[field] === undefined ||
      args[field] === null ||
      (typeof args[field] === "string" && args[field].trim() === "")
    ) {
      return `Missing required parameter: '${field}'`;
    }
  }
  return null;
}

/**
 * Resolve the executor for a tool name across the advertised set and the
 * callable-but-unadvertised extras. Kept in one place so a tool can never be
 * dispatched by a branch that does not exist in the contract.
 */
function executorKeyFor(toolName: string): MCPExecutorKey | undefined {
  return MCP_TOOL_EXECUTORS[toolName] || MCP_EXTRA_TOOL_EXECUTORS[toolName];
}

function isKnownTool(toolName: string): boolean {
  return Boolean(executorKeyFor(toolName));
}

/**
 * Recursively strips `embedding` vector fields from any MCP tool payload before
 * serializing it to the AI agent. Embeddings stay inside the database for ANN/HNSW
 * search and must never be returned in LLM tool outputs.
 */
export function stripEmbeddingsFromMcpPayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripEmbeddingsFromMcpPayload(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "embedding") continue;
      out[k] = stripEmbeddingsFromMcpPayload(v);
    }
    return out as T;
  }
  return value;
}

export async function handleMCPRequest(
  request: MCPRequest,
  context: MCPHandlerContext
): Promise<MCPResponse | null> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              resources: {},
              prompts: {}
            },
            serverInfo: {
              name: MCP_SERVER_INFO.name,
              version: MCP_SERVER_INFO.version
            }
          }
        };

      case "notifications/initialized":
        return null;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_ADVERTISED_TOOLS
          }
        };

      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};

        if (!name || typeof name !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Tool name is required and must be a string"
            }
          };
        }

        if (!isKnownTool(name)) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool not found: ${name}`
            }
          };
        }

        const validationError = validateToolArguments(name, args);
        if (validationError) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Invalid params for tool '${name}': ${validationError}`
            }
          };
        }

        const key = executorKeyFor(name) as MCPExecutorKey;
        const executor = context[key] as ((params: any) => Promise<any>) | undefined;
        if (!executor) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: `Backend handler for tool '${name}' is not configured on this MCP server context`
            }
          };
        }

        const toolResult = await executor(args);
        const sanitizedResult =
          typeof toolResult === "string"
            ? toolResult
            : stripEmbeddingsFromMcpPayload(toolResult ?? {});

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  typeof sanitizedResult === "string"
                    ? sanitizedResult
                    : JSON.stringify(sanitizedResult, null, 2)
              }
            ],
            isError: false
          }
        };
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              {
                uri: `blueprint://workspace/${context.workspaceId}/bkn`,
                name: "Workspace Knowledge Network",
                description: "Complete graph export of workspace entities, relationships, and knowledge nodes.",
                mimeType: "application/json"
              }
            ]
          }
        };

      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: [
              {
                name: "ingest_app_state",
                description: "Ingest and analyze current application state into the workspace Knowledge Graph.",
                arguments: [
                  {
                    name: "app_state_json",
                    description: "JSON dump of current app state",
                    required: true
                  }
                ]
              }
            ]
          }
        };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err.message || "Internal server error"
      }
    };
  }
}
