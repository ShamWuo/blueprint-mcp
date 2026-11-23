#!/usr/bin/env node
/**
 * blueprint-mcp — the self-hosted (`--local`) MCP server over stdio.
 *
 * This is the same server as the hosted endpoint, reached without a Blueprint
 * Nexus account: same identity, same advertised tool set, same result and error
 * shapes. Those three things come from `src/contract.ts`, serialized into
 * `tool-contract.json` by `npm run build:tool-contract` so this plain-JS bundle
 * can read the contract without importing TypeScript or shipping a compiler.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { getSupabaseClient, getWorkspaceContext, listWorkspaces, getHotPath, stripEmbeddingsFromPayload } from "./core.js";
import { LOCAL_TOOL_EXECUTORS } from "./executors.js";
import { createLocalStoreExecutors } from "./local-executors.js";

const CONTRACT = JSON.parse(
  readFileSync(new URL("./tool-contract.json", import.meta.url), "utf8")
);
const TOOLS = CONTRACT.tools;
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

let localDir = process.env.BKN_LOCAL_STORE || ".bkn";
let explicitLocalPath = Boolean(process.env.BKN_LOCAL_STORE);
let isLocalStoreRequested = process.env.BKN_LOCAL_MODE === "1";

// Parse CLI arguments (--key, --api-key, --workspace, --path, --folder, --local)
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if ((arg === "--key" || arg === "--api-key") && process.argv[i + 1]) {
    process.env.BLUEPRINT_API_KEY = process.argv[i + 1];
    process.env.BSC_API_KEY = process.argv[i + 1];
    i++;
  } else if (arg.startsWith("--key=")) {
    const val = arg.split("=").slice(1).join("=");
    process.env.BLUEPRINT_API_KEY = val;
    process.env.BSC_API_KEY = val;
  } else if (arg.startsWith("--api-key=")) {
    const val = arg.split("=").slice(1).join("=");
    process.env.BLUEPRINT_API_KEY = val;
    process.env.BSC_API_KEY = val;
  } else if (arg === "--workspace" && process.argv[i + 1]) {
    process.env.BLUEPRINT_WORKSPACE_ID = process.argv[i + 1];
    i++;
  } else if (arg.startsWith("--workspace=")) {
    process.env.BLUEPRINT_WORKSPACE_ID = arg.split("=").slice(1).join("=");
  } else if ((arg === "--path" || arg === "--local-path" || arg === "--store") && process.argv[i + 1]) {
    localDir = process.argv[++i];
    explicitLocalPath = true;
    isLocalStoreRequested = true;
  } else if (arg.startsWith("--path=") || arg.startsWith("--local-path=") || arg.startsWith("--store=")) {
    localDir = arg.split("=").slice(1).join("=");
    explicitLocalPath = true;
    isLocalStoreRequested = true;
  } else if ((arg === "--folder" || arg === "--cwd") && process.argv[i + 1]) {
    const folder = process.argv[++i];
    if (!explicitLocalPath) {
      localDir = path.join(path.resolve(folder), ".bkn");
    }
  } else if (arg.startsWith("--folder=") || arg.startsWith("--cwd=")) {
    const folder = arg.split("=").slice(1).join("=");
    if (!explicitLocalPath) {
      localDir = path.join(path.resolve(folder), ".bkn");
    }
  } else if (arg === "--local" || arg === "--local-store") {
    isLocalStoreRequested = true;
  }
}

let supabase = null;
try {
  supabase = getSupabaseClient();
} catch (err) {
  // If Supabase credentials are not present, we cleanly fall back to local file store
}

const isLocalMode = isLocalStoreRequested || (!supabase && existsSync(localDir));
const localExecutors = isLocalMode ? createLocalStoreExecutors(localDir) : null;
if (isLocalMode) {
  console.error(`[blueprint-mcp] Local-First mode active (backing store: ${localDir})`);
}

const server = new Server(
  { name: CONTRACT.serverInfo.name, version: CONTRACT.serverInfo.version },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);

/**
 * Same check, same wording as the hosted handler (`validateToolArguments`), so a
 * client that sends a tool call without its required arguments is corrected
 * identically in either mode.
 */
function validateToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "Arguments must be a valid JSON object";
  }
  for (const field of tool?.inputSchema?.required || []) {
    const value = args[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return `Missing required parameter: '${field}'`;
    }
  }
  return null;
}

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "blueprint://workspace/context",
        name: "Active Workspace Context",
        description: "Summary and tech docs for the active workspace.",
        mimeType: "application/json"
      },
      {
        uri: "blueprint://workspace/list",
        name: "Workspace Directory",
        description: "List of all blueprints and workspaces in the project.",
        mimeType: "application/json"
      },
      {
        uri: "kernel://config/agents",
        name: "Kernel instructions (AGENTS.md)",
        mimeType: "text/markdown",
        description: "Safety-critical instructions and guardrails for code modification."
      },
      {
        uri: "kernel://notes/notes",
        name: "Daily session logs (notes.md)",
        mimeType: "text/markdown",
        description: "Daily session decisions log."
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  try {
    if (uri === "blueprint://workspace/context") {
      if (isLocalMode && localExecutors) {
        const localCtx = await localExecutors.bkn_get_workspace_context();
        return {
          contents: [{ uri, text: typeof localCtx === "string" ? localCtx : JSON.stringify(localCtx, null, 2), mimeType: "application/json" }]
        };
      }
      const ctx = await getWorkspaceContext(supabase, null, true, true);
      return {
        contents: [{ uri, text: JSON.stringify(ctx, null, 2), mimeType: "application/json" }]
      };
    }
    if (uri === "blueprint://workspace/list") {
      if (isLocalMode && localExecutors) {
        const localList = await localExecutors.bkn_list_workspaces();
        return {
          contents: [{ uri, text: JSON.stringify(localList, null, 2), mimeType: "application/json" }]
        };
      }
      const list = await listWorkspaces(supabase, 20);
      return {
        contents: [{ uri, text: JSON.stringify(list, null, 2), mimeType: "application/json" }]
      };
    }
    if (uri === "kernel://config/agents") {
      const hp = await getHotPath();
      return {
        contents: [{ uri, text: hp.agents, mimeType: "text/markdown" }]
      };
    }
    if (uri === "kernel://notes/notes") {
      const hp = await getHotPath();
      return {
        contents: [{ uri, text: hp.identity, mimeType: "text/markdown" }]
      };
    }
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read resource ${uri}: ${err.message}`
    );
  }
  throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
});

/** Tools Listing — the advertised set, identical to the hosted endpoint's. */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

/** Tool Call Execution — every advertised tool plus the local extras. */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const executor = LOCAL_TOOL_EXECUTORS[name];
  if (!executor) {
    // Same code the hosted handler returns for a name outside the contract.
    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
  }

  const validationError = validateToolArguments(TOOLS_BY_NAME.get(name), args);
  if (validationError) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid params for tool '${name}': ${validationError}`
    );
  }

  try {
    let result;
    if (isLocalMode && localExecutors && localExecutors[name]) {
      result = await localExecutors[name](supabase, args || {});
    } else {
      if (!supabase && name.startsWith("bkn_")) {
        try {
          supabase = getSupabaseClient();
        } catch (subErr) {
          if (localExecutors && localExecutors[name]) {
            result = await localExecutors[name](null, args || {});
          } else {
            throw subErr;
          }
        }
      }
      if (result === undefined) {
        result = await executor(supabase, args || {});
      }
    }

    const sanitized =
      typeof result === "string" ? result : stripEmbeddingsFromPayload(result ?? {});

    return {
      content: [
        {
          type: "text",
          text: typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized, null, 2)
        }
      ]
    };
  } catch (error) {
    // Preserve the executor's own message: the hosted handler answers a failing
    // tool with `-32603` and `err.message`, and a bare throw here would be
    // flattened into a generic "Internal error".
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error?.message || "Internal server error");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[blueprint-mcp] ${CONTRACT.serverInfo.name} ${CONTRACT.serverInfo.version} running on stdio (${TOOLS.length} tools)`
  );
}

main().catch((error) => {
  console.error("[blueprint-mcp] Fatal error:", error);
  process.exit(1);
});
