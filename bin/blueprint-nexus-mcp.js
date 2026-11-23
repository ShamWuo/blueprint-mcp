#!/usr/bin/env node
/**
 * blueprint-nexus-mcp — stdio entry point.
 *
 * Three ways to run:
 *  1. Zero-config local mode (no account, no API key, no Supabase):
 *       npx -y @blueprint-nexus/mcp-server init
 *       npx -y @blueprint-nexus/mcp-server --local
 *     Stores portable YAML knowledge nodes in `.bkn/`. When `.bkn/graph.yaml`
 *     exists in the working directory (or `--folder`), running without `--key`
 *     automatically boots in local mode.
 *
 *  2. Hosted cloud sync (team graph, GraphRAG, web/desktop/mobile sync):
 *       npx -y @blueprint-nexus/mcp-server --key <workspace-api-key>
 *     Forwards MCP JSON-RPC over stdio to the Blueprint Nexus hosted endpoint.
 *
 *  3. Self-hosted backend (optional):
 *     Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or ANON_KEY)
 *     in the environment without `.bkn/` to run against your own Supabase stack.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import {
  connectFolder,
  disconnectFolder,
  listConnectedFolders,
  resolveFolderConnection,
  syncFolderToWorkspace,
} from "./folder-bridge.js";
import { initLocalWorkspace } from "./local-init.js";

// The canonical host: `bluesc.org` 308-redirects to `www`, and every published
// machine-readable file (server card, OpenAPI servers[0].url) names the www host,
// so defaulting to the redirect would cost a hop on every single call.
const DEFAULT_BASE_URL = "https://www.bluesc.org";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--key" || arg === "--api-key") {
      args.key = argv[++i];
    } else if (arg.startsWith("--key=") || arg.startsWith("--api-key=")) {
      args.key = arg.split("=").slice(1).join("=");
    } else if (arg === "--base-url") {
      args.baseUrl = argv[++i];
    } else if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.split("=").slice(1).join("=");
    } else if (arg === "--local" || arg === "--local-store") {
      args.local = true;
    } else if (arg === "--path" || arg === "--local-path" || arg === "--store") {
      args.storePath = argv[++i];
    } else if (
      arg.startsWith("--path=") ||
      arg.startsWith("--local-path=") ||
      arg.startsWith("--store=")
    ) {
      args.storePath = arg.split("=").slice(1).join("=");
    } else if (arg === "--folder" || arg === "--cwd") {
      args.folder = argv[++i];
    } else if (arg.startsWith("--folder=") || arg.startsWith("--cwd=")) {
      args.folder = arg.split("=").slice(1).join("=");
    } else if (arg === "--workspace") {
      args.workspace = argv[++i];
    } else if (arg.startsWith("--workspace=")) {
      args.workspace = arg.split("=").slice(1).join("=");
    } else if (arg === "--name") {
      args.name = argv[++i];
    } else if (arg.startsWith("--name=")) {
      args.name = arg.split("=").slice(1).join("=");
    } else if (arg === "--client") {
      args.clients = args.clients || [];
      args.clients.push(argv[++i]);
    } else if (arg.startsWith("--client=")) {
      args.clients = args.clients || [];
      args.clients.push(arg.split("=").slice(1).join("="));
    } else if (arg === "--no-scan") {
      args.noScan = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--include") {
      args.include = argv[++i];
    } else if (arg === "--ignore") {
      args.ignore = argv[++i];
    } else if (arg === "--sync") {
      args.sync = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`blueprint-nexus-mcp — Blueprint Nexus MCP server (stdio)

Usage:
  npx -y @blueprint-nexus/mcp-server init [folder] [options]        # Zero-config local .bkn/ setup
  npx -y @blueprint-nexus/mcp-server --local [--path <dir>]         # Local-first MCP server (no key)
  npx -y @blueprint-nexus/mcp-server --key <workspace-api-key>      # Hosted cloud sync (${DEFAULT_BASE_URL})

Options:
  --local             Run the local-first file-backed MCP server (.bkn/ YAML store,
                      no API key or Supabase required). Auto-selected when .bkn/graph.yaml
                      exists and no --key is provided.
  --path <dir>        Path to the local .bkn store directory (default: <cwd>/.bkn)
  --key <api-key>     Blueprint Nexus workspace API key (or set BLUEPRINT_API_KEY /
                      BSC_API_KEY in the environment) for hosted cloud sync.
  --base-url <url>    Hosted endpoint base URL (default: ${DEFAULT_BASE_URL})
  --folder <path>     Bind stdio session to a local folder (auto-resolves .bkn/ in
                      local mode or workspace_id from .bkn/connection.json in hosted mode)
  --sync              Sync the connected --folder to its workspace on startup
  --client <name>     With 'init': write MCP config for cursor, claude, mcp, or vscode
  --no-scan           With 'init': create an empty .bkn/ store without scanning repo docs
  --json              With 'init': output machine-readable JSON summary
  -h, --help          Show this help
  -v, --version       Show version

Commands:
  blueprint-nexus-mcp init [folder] [--name <label>] [--client cursor|claude|mcp|vscode]
  blueprint-nexus-mcp connect <folder> --workspace <id> [--name <label>]
  blueprint-nexus-mcp disconnect <folder>
  blueprint-nexus-mcp folders
  blueprint-nexus-mcp sync [folder] --key <api-key> [--dry-run] [--force]

Client configuration (zero-config local mode):
  {
    "mcpServers": {
      "blueprint": {
        "command": "npx",
        "args": ["-y", "--package", "@blueprint-nexus/mcp-server", "blueprint-nexus-mcp", "--local"]
      }
    }
  }
`);
}

/**
 * Minimal JSON-RPC over stdio loop (one request per line, newline-delimited).
 *
 * Exit is deferred while a request is in flight. A stdio client that closes
 * stdin right after its last message (a scripted smoke test, or any client
 * shutting down mid-call) used to lose the answer: readline fired `close`, the
 * process exited, and the pending fetch was never written. Draining first costs
 * nothing for a long-lived client and makes one-shot use correct.
 */
function runStdioLoop(handle) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  let inFlight = 0;
  let stdinClosed = false;
  const maybeExit = () => {
    if (stdinClosed && inFlight === 0) process.exit(0);
  };
  const track = (promise) => {
    inFlight += 1;
    return promise.finally(() => {
      inFlight -= 1;
      maybeExit();
    });
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }
    if (Array.isArray(msg)) {
      // Batch: process sequentially, in order.
      track(
        (async () => {
          const results = [];
          for (const m of msg) {
            const r = await handle(m);
            if (r !== null) results.push(r);
          }
          if (results.length > 0) write(results);
        })().catch((err) => {
          write({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
        })
      );
      return;
    }
    track(
      Promise.resolve(handle(msg))
        .then((result) => {
          if (result !== null) write(result);
        })
        .catch((err) => {
          write({
            jsonrpc: "2.0",
            id: msg?.id ?? null,
            error: { code: -32603, message: err?.message || "Internal error" }
          });
        })
    );
  });

  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}

/**
 * Pull a JSON-RPC error object out of an HTTP error body.
 *
 * The hosted endpoint answers failures with the protocol's own envelope, so the
 * code and message it chose (-32001 for a bad key, -32029 for a rate limit, …)
 * are more useful to the client than a wrapper — and the error contract is only
 * real end to end if the proxy relays it instead of flattening it into a string.
 */
function extractJsonRpcError(body) {
  try {
    const parsed = JSON.parse(body);
    const candidate = Array.isArray(parsed)
      ? parsed.find((m) => m && m.error)?.error
      : parsed && parsed.error;
    if (candidate && typeof candidate.code === "number" && typeof candidate.message === "string") {
      return candidate;
    }
  } catch {
    // Not JSON (an HTML error page, an empty body) — the caller falls back.
  }
  return null;
}

/** Hosted mode: forward JSON-RPC messages to the hosted MCP endpoint, while handling local folder bridge tools on disk. */
function createHostedHandler({ baseUrl, apiKey, defaultFolder }) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/mcp/messages`;
  let sessionId = null;

  async function forwardToHosted(message) {
    // Notifications (no id) must not receive responses.
    const isNotification = message && message.id === undefined;

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message)
    });

    const newSession = res.headers.get("mcp-session-id");
    if (newSession) sessionId = newSession;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Prefer the endpoint's own JSON-RPC error object verbatim.
      const error =
        extractJsonRpcError(text) || {
          code: res.status === 401 ? -32001 : -32000,
          message: `Hosted endpoint error ${res.status}: ${text.slice(0, 500) || res.statusText}`
        };
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: message?.id ?? null, error };
    }

    // Some notifications yield 202 Accepted with no body.
    if (res.status === 202) return null;

    const contentType = res.headers.get("content-type") || "";
    let result;
    if (contentType.includes("text/event-stream")) {
      result = await parseSseResponse(res);
    } else {
      const text = await res.text();
      result = text ? JSON.parse(text) : null;
    }

    if (isNotification) return null;
    if (!result) return null;
    // Normalize to a single JSON-RPC response object.
    if (Array.isArray(result)) {
      return result.length === 1 ? result[0] : result;
    }
    return result;
  }

  async function callHostedTool(name, toolArgs) {
    const rpcRes = await forwardToHosted({
      jsonrpc: "2.0",
      id: `folder-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: "tools/call",
      params: { name, arguments: toolArgs }
    });
    if (rpcRes?.error) {
      throw new Error(rpcRes.error.message || `Hosted tool '${name}' failed`);
    }
    const text = rpcRes?.result?.content?.[0]?.text;
    if (rpcRes?.result?.isError) {
      throw new Error(text || `Hosted tool '${name}' returned an error`);
    }
    try {
      return text ? JSON.parse(text) : rpcRes?.result;
    } catch {
      return text;
    }
  }

  return async function handle(message) {
    if (message && message.method === "tools/call" && message.params?.name) {
      const toolName = message.params.name;
      const toolArgs = { ...(message.params.arguments || {}) };

      // Resolve workspace_id from connected folder if omitted
      if (!toolArgs.workspace_id && defaultFolder) {
        const conn = await resolveFolderConnection(defaultFolder);
        if (conn?.workspaceId) {
          toolArgs.workspace_id = conn.workspaceId;
        }
      }

      if (
        toolName === "bkn_connect_folder" ||
        toolName === "bkn_disconnect_folder" ||
        toolName === "bkn_list_folders" ||
        toolName === "bkn_sync_folder"
      ) {
        try {
          let payload;
          if (toolName === "bkn_connect_folder") {
            if (!toolArgs.path) {
              throw new Error("Missing required parameter: 'path'");
            }
            payload = await connectFolder({
              folderPath: toolArgs.path,
              workspaceId: toolArgs.workspace_id,
              workspaceName: toolArgs.workspace_name,
              include: toolArgs.include,
              ignore: toolArgs.ignore,
              maxFileSizeBytes: toolArgs.max_file_size_bytes,
            });
          } else if (toolName === "bkn_disconnect_folder") {
            if (!toolArgs.path) {
              throw new Error("Missing required parameter: 'path'");
            }
            payload = await disconnectFolder({ folderPath: toolArgs.path });
          } else if (toolName === "bkn_list_folders") {
            payload = await listConnectedFolders();
          } else if (toolName === "bkn_sync_folder") {
            const targetPath = toolArgs.path || defaultFolder;
            if (!targetPath) {
              throw new Error("Missing required parameter: 'path'");
            }
            payload = await syncFolderToWorkspace({
              folderPath: targetPath,
              workspaceId: toolArgs.workspace_id,
              dryRun: toolArgs.dry_run === true,
              force: toolArgs.force === true,
              writeFileFn: (fileArgs) => callHostedTool("bkn_write_file", fileArgs),
            });
          }

          return {
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            },
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error: ${err?.message || err}` }],
            },
          };
        }
      }

      return forwardToHosted({
        ...message,
        params: { ...message.params, arguments: toolArgs },
      });
    }

    return forwardToHosted(message);
  };
}

/** Read a single JSON-RPC response from an SSE stream. */
async function parseSseResponse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (data) break;
  }
  try {
    reader.cancel();
  } catch {
    // best effort
  }
  return data ? JSON.parse(data) : null;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    // Read rather than `import ... with { type: "json" }`: the import-attributes
    // syntax is a parse error before Node 20.10, and this package declares
    // `engines: node >=18.17`.
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const subcommand = args._[0];
  if (subcommand === "init") {
    const targetFolder = args._[1] || args.folder || process.cwd();
    const res = await initLocalWorkspace({
      rootDir: targetFolder,
      storeDir: args.storePath,
      name: args.name,
      scan: !args.noScan,
      force: Boolean(args.force),
      clients: args.clients || [],
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return;
    }

    const lines = [
      `✓ Initialized local Blueprint knowledge graph for '${res.workspaceName}'`,
      `  Store:              ${res.storeDir}`,
      `  Indexed nodes:      ${res.nodesCreated.length}`,
      `  Linked edges:       ${res.edgesCreated.length}`,
      `  Verification gates: ${res.verificationRules.length}`,
    ];
    if (res.clientConfigs.length > 0) {
      for (const cfg of res.clientConfigs) {
        lines.push(`  Wrote MCP config:   ${cfg.relPath}`);
      }
    }
    lines.push(
      "",
      "Next: add this to Cursor (.cursor/mcp.json), Claude Code (.mcp.json), or Claude Desktop:",
      JSON.stringify(res.mcpConfigSnippet, null, 2),
      "",
      "Or run directly in this repo (auto-detects .bkn/ with zero API key):",
      "  npx -y @blueprint-nexus/mcp-server",
      ""
    );
    process.stdout.write(lines.join("\n"));
    return;
  }
  if (subcommand === "connect") {
    const targetFolder = args._[1] || args.folder || process.cwd();
    const res = await connectFolder({
      folderPath: targetFolder,
      workspaceId: args.workspace || process.env.BLUEPRINT_WORKSPACE_ID,
      workspaceName: args.name,
      include: args.include ? args.include.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      ignore: args.ignore ? args.ignore.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (subcommand === "disconnect") {
    const targetFolder = args._[1] || args.folder || process.cwd();
    const res = await disconnectFolder({ folderPath: targetFolder });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (subcommand === "folders") {
    const res = await listConnectedFolders();
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (subcommand === "sync") {
    const targetFolder = args._[1] || args.folder || process.cwd();
    const apiKey = args.key || process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
    if (!apiKey && !args.local) {
      process.stderr.write("blueprint-nexus-mcp sync: missing API key (--key or BLUEPRINT_API_KEY), or pass --local.\n");
      process.exit(1);
    }
    const baseUrl = args.baseUrl || process.env.BLUEPRINT_BASE_URL || DEFAULT_BASE_URL;
    const hosted = createHostedHandler({ baseUrl, apiKey, defaultFolder: targetFolder });
    const res = await hosted({
      jsonrpc: "2.0",
      id: "cli-sync",
      method: "tools/call",
      params: {
        name: "bkn_sync_folder",
        arguments: {
          path: targetFolder,
          workspace_id: args.workspace,
          dry_run: Boolean(args.dryRun),
          force: Boolean(args.force),
        },
      },
    });
    process.stdout.write((res?.result?.content?.[0]?.text || JSON.stringify(res, null, 2)) + "\n");
    return;
  }

  const apiKey = args.key || process.env.BLUEPRINT_API_KEY || process.env.BSC_API_KEY;
  const activeFolder = args.folder || process.env.BLUEPRINT_FOLDER || null;
  const candidateStoreDir = args.storePath
    ? path.resolve(args.storePath)
    : path.join(path.resolve(activeFolder || process.cwd()), ".bkn");
  const hasLocalGraph = existsSync(path.join(candidateStoreDir, "graph.yaml"));

  if (args.local || args.storePath || (!apiKey && hasLocalGraph)) {
    // Local-first mode: hand off to the bundled local server (blueprint-mcp.js).
    if (args.storePath || hasLocalGraph || activeFolder) {
      process.env.BKN_LOCAL_STORE = candidateStoreDir;
    }
    process.env.BKN_LOCAL_MODE = "1";
    await import("./blueprint-mcp.js");
    return;
  }

  if (!apiKey) {
    process.stderr.write(
      "blueprint-nexus-mcp: no API key and no local .bkn/ graph found in this directory.\n" +
        "  • Zero-config local mode (no account needed): npx -y @blueprint-nexus/mcp-server init\n" +
        "  • Hosted cloud sync:                          npx -y @blueprint-nexus/mcp-server --key <api-key>\n" +
        "    (Get a workspace API key in Blueprint Nexus: Settings → MCP & API Keys.)\n"
    );
    process.exit(1);
  }

  const baseUrl = args.baseUrl || process.env.BLUEPRINT_BASE_URL || DEFAULT_BASE_URL;
  const handle = createHostedHandler({ baseUrl, apiKey, defaultFolder: activeFolder });

  if (args.sync && activeFolder) {
    const syncRes = await handle({
      jsonrpc: "2.0",
      id: "startup-sync",
      method: "tools/call",
      params: { name: "bkn_sync_folder", arguments: { path: activeFolder } },
    });
    process.stderr.write(
      `[blueprint-nexus-mcp] startup sync: ${syncRes?.result?.content?.[0]?.text || "done"}\n`
    );
  }

  process.stderr.write(`[blueprint-nexus-mcp] hosted proxy → ${baseUrl} (stdio)\n`);
  runStdioLoop(handle);
}

main().catch((err) => {
  process.stderr.write(`[blueprint-nexus-mcp] fatal: ${err?.message || err}\n`);
  process.exit(1);
});
