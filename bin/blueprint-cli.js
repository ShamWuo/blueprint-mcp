#!/usr/bin/env node
/**
 * blueprint-cli — run one MCP tool from the shell.
 *
 * Tool names, arguments and results are the same contract the `--local` server
 * and the hosted endpoint speak: dispatch comes from `executors.js` (the local
 * mirror of the hosted context) and the help text is generated from
 * `tool-contract.json`, so a third hand-maintained tool list cannot appear here.
 */
import { readFileSync } from "node:fs";
import { getSupabaseClient, stripEmbeddingsFromPayload } from "./core.js";
import { LOCAL_TOOL_EXECUTORS } from "./executors.js";

const CONTRACT = JSON.parse(
  readFileSync(new URL("./tool-contract.json", import.meta.url), "utf8")
);
const ADVERTISED = new Set(CONTRACT.tools.map((tool) => tool.name));

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if ((arg === "--key" || arg === "--api-key") && process.argv[i + 1]) {
    process.env.BLUEPRINT_API_KEY = process.argv[i + 1];
    process.env.BSC_API_KEY = process.argv[i + 1];
    process.argv.splice(i, 2);
    i--;
  } else if (arg.startsWith("--key=") || arg.startsWith("--api-key=")) {
    const val = arg.split("=").slice(1).join("=");
    process.env.BLUEPRINT_API_KEY = val;
    process.env.BSC_API_KEY = val;
    process.argv.splice(i, 1);
    i--;
  }
}

const toolName = process.argv[2];
const rawArgs = process.argv[3] || "{}";

if (!toolName || toolName === "--help" || toolName === "-h") {
  const advertised = Object.keys(LOCAL_TOOL_EXECUTORS).filter((name) => ADVERTISED.has(name));
  const localOnly = Object.keys(LOCAL_TOOL_EXECUTORS).filter((name) => !ADVERTISED.has(name));
  const render = (names, indent) =>
    names.map((name) => `${indent}- ${name}`).join("\n");

  console.log(`Blueprint MCP CLI Runner
Usage: node blueprint-cli.js <tool_name> [json_args]

Advertised tools (identical to the MCP server's tools/list):
${render(advertised, "  ")}

Callable in self-hosted mode, not advertised:
${render(localOnly, "  ")}

Example:
  node blueprint-cli.js bkn_query_graph '{"query": "Auth", "limit": 10}'
`);
  process.exit(0);
}

let args = {};
try {
  args = JSON.parse(rawArgs);
} catch (err) {
  console.error("Error parsing JSON arguments:", err.message);
  process.exit(1);
}

async function run() {
  const executor = LOCAL_TOOL_EXECUTORS[toolName];
  if (!executor) {
    console.error(`Unknown tool: ${toolName}`);
    process.exit(1);
  }

  // Only the graph tools need a database connection; `get_hot_path` and friends
  // read the local checkout and must keep working without Supabase credentials.
  const needsDatabase =
    toolName.startsWith("bkn_") || toolName.startsWith("agent_") || toolName === "submit_proposal";
  const supabase = needsDatabase ? getSupabaseClient() : null;

  const result = await executor(supabase, args || {});
  const sanitized = typeof result === "string" ? result : stripEmbeddingsFromPayload(result);
  console.log(JSON.stringify(sanitized, null, 2));
}

run().catch((err) => {
  console.error("Execution error:", err);
  process.exit(1);
});
