# @blueprint-nexus/mcp-server

**Persistent architectural memory and invariant verification for AI coding agents.**

Stop AI coding agents from forgetting repo rules, duplicating logic, or breaking architectural decisions across sessions. Connect **Cursor, Claude Code, Antigravity, Windsurf, or Claude Desktop** to your [Blueprint Nexus](https://www.bluesc.org) knowledge graph to query architectural decisions, sync local codebases, and verify invariants before code lands.

<!-- mcp-name: org.bluesc/blueprint-nexus-mcp -->

## Why devs use it

- **Architectural memory across sessions:** Store `Rule`, `Decision`, and `Concept` nodes so every agent starts with your repo's real constraints instead of guessing from grep.
- **Live codebase sync:** Connect any local repository (`bkn_connect_folder` / `bkn_sync_folder` or `--folder <path> --sync`) to keep graph nodes aligned with your files.
- **Executable invariant checks:** Run `bkn_verify_node` and `bkn_verify_workspace` to validate commands, scripts, patterns, and endpoints against your architecture rules.

## Quick start (zero-config local mode — no account needed)

Run `init` inside any repository to index `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `README.md`, ADRs, and `package.json` verification scripts into a portable `.bkn/` YAML graph:

```bash
npx -y @blueprint-nexus/mcp-server init --client cursor   # or --client claude / --client vscode
```

Once `.bkn/` exists, starting the server with no API key automatically boots in local-first mode:

```bash
npx -y @blueprint-nexus/mcp-server --local
```

### Hosted cloud sync (team graph, GraphRAG, multi-device sync)

Connect to [bluesc.org](https://www.bluesc.org) when you want shared team rules, semantic GraphRAG, and cloud sync:

```bash
npx -y @blueprint-nexus/mcp-server --key <your-workspace-api-key>
```

Get a workspace API key in Blueprint Nexus → **Settings → MCP & API Keys** (or `POST /api/mcp/keys`
while signed in). Keys are sent as `Authorization: Bearer bsc_live_…`.

To bind a hosted session directly to a local repository and sync on startup:

```bash
npx -y @blueprint-nexus/mcp-server --key <your-workspace-api-key> --folder . --sync
```

## Client configuration

### Zero-config local mode (Cursor / Claude Code / Claude Desktop / Antigravity)

```json
{
  "mcpServers": {
    "blueprint": {
      "command": "npx",
      "args": ["-y", "--package", "@blueprint-nexus/mcp-server", "blueprint-nexus-mcp", "--local"]
    }
  }
}
```

### Hosted cloud sync

```json
{
  "mcpServers": {
    "blueprint": {
      "command": "npx",
      "args": ["-y", "--package", "@blueprint-nexus/mcp-server", "blueprint-nexus-mcp", "--key", "bsc_live_..."]
    }
  }
}
```

### Environment variables (alternative to `--key`)

| Variable | Description |
|---|---|
| `BLUEPRINT_API_KEY` | Workspace API key (required) |
| `BSC_API_KEY` | Alias for `BLUEPRINT_API_KEY` |
| `BLUEPRINT_WORKSPACE_ID` | Pin the server to one workspace UUID |
| `BLUEPRINT_BASE_URL` | Override the hosted endpoint (default: `https://www.bluesc.org`) |

## Tools

Thirty tools are exposed. This table mirrors the registry the server actually executes
(`src/tools.ts`), which is also what `/mcp.json`, `/.well-known/mcp/server-card.json`, and
`/openapi.json` publish — a test in this package fails if they drift apart.

Both transports serve this same contract: the hosted endpoint (`--key`) and the self-hosted
bundle (`--local`) announce the same `serverInfo` (`blueprint-nexus-mcp`), advertise the same
tools, and return the same result keys per tool. Identity, the tool list, the executor behind
each tool, and the canonical result keys all live in [`src/contract.ts`](src/contract.ts);
the plain-JavaScript bundle reads them through a generated [`bin/tool-contract.json`](bin/tool-contract.json)
(`npm run build:tool-contract`), and tests in this package fail if the file, the advertised
set, or the two modes' result shapes drift apart.

| Tool | Description |
|---|---|
| `bkn_list_workspaces` | List workspaces with node counts |
| `bkn_create_workspace` | Create a workspace with seeded knowledge graph |
| `bkn_get_workspace_context` | Full context: docs, tasks, graph summary |
| `bkn_query_graph` | Search nodes and typed relationships (scoped by `workspace_id`) |
| `bkn_get_subgraph` | Retrieve nodes scoped to a parent node (fractal subgraph) |
| `bkn_get_related_nodes` | List the nodes directly connected to one anchor node, with edge type and direction |
| `bkn_create_node` | Create or update a knowledge node |
| `bkn_link_nodes` | Create a typed or reactive edge between nodes |
| `bkn_apply_patch` | Create/update multiple nodes and link typed/reactive edges in a single call |
| `bkn_unlink_nodes` | Delete a typed edge between nodes |
| `bkn_delete_node` | Delete or archive a node and sever its edges |
| `bkn_ingest_content` | Ingest unstructured text into the graph |
| `bkn_mutate_variable` | Mutate variable nodes and fire reactive triggers |
| `bkn_push_telemetry` | Stream events into the workspace audit log |
| `bkn_emit_signal` | Emit a graph signal onto a node or the workspace |
| `bkn_resolve_signal` | Mark a signal resolved with notes and a timestamp |
| `bkn_list_signals` | List active signals for the workspace or a node |
| `agent_traverse_node` | Move an agent along an edge to a neighbouring node |
| `bkn_write_file` | Create or overwrite a code or text file node |
| `bkn_read_file` | Read a file node's content and metadata by path |
| `bkn_edit_file` | Surgically edit a file node using exact search-and-replace |
| `bkn_list_files` | List all file nodes in the workspace |
| `bkn_verify_node` | Execute a node's verification harness (command, script, pattern, HTTP) to validate invariants |
| `bkn_verify_workspace` | Scan and execute all verification contracts across the workspace |
| `bkn_list_integrations` | List connected SaaS integrations (Composio), 1-turn recipes, and search the 800+ app catalog |
| `bkn_execute_integration` | Execute a Composio SaaS integration action with argument aliasing, `#channel`/`owner/repo` resolution, and optional graph ingestion |
| `bkn_connect_folder` | Connect a local folder to a Blueprint workspace |
| `bkn_disconnect_folder` | Disconnect a local folder from its Blueprint workspace |
| `bkn_list_folders` | List local folders connected to Blueprint workspaces |
| `bkn_sync_folder` | Incrementally sync files from a connected folder into the workspace graph |

`agent_station` is callable in both modes but deliberately unadvertised (the SDK's
`client.stationAgent()` is its caller).

## SDK usage (TypeScript)

```ts
import { BlueprintMCPClient } from "@blueprint-nexus/mcp-server";

// Talks to https://www.bluesc.org by default; pass `baseUrl` to target a self-hosted stack.
const client = new BlueprintMCPClient({ apiKey: process.env.BLUEPRINT_API_KEY! });
const graph = await client.queryGraph("architecture decisions");
await client.ingestContent("# Meeting notes\n- Decision: adopt Postgres RLS");
```

## Registries

This server is submitted to the MCP directories (see `PUBLISH.md` for the checklist):

- **PulseMCP / mcp.so / Glama**: search "Blueprint Nexus" once listed
- **Smithery**: `npx -y @smithery/cli install @blueprint-nexus/mcp-server` after the Smithery listing is live

Works with: **Claude Desktop, Cursor, Windsurf, Cline, Devin, and any MCP-compatible agent.**

## Local-first & self-hosting

Run completely offline against a git-tracked `.bkn/` YAML knowledge graph (no API key or database required):

```bash
npx -y @blueprint-nexus/mcp-server init
npx -y @blueprint-nexus/mcp-server --local
```

If you also want to self-host the full Postgres/Supabase backend, set `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`) without a local `.bkn/` directory.

The same 30 tools are served, with the same identity, arguments and result keys, so an
agent can switch between `--key` and `--local` without changing its prompts.

Self-hosted mode additionally accepts four **repo-local** tools that read the checkout rather
than the graph — `get_hot_path`, `log_decision`, `update_knowledge`, `submit_proposal`. They
are callable by name and never advertised, which is what keeps the advertised set identical
to the hosted endpoint's.

One behavioural difference is inherent: `bkn_mutate_variable` writes the new value in both
modes, but only the hosted endpoint also runs the workspace app's reactive edge triggers
(`resolveEdgeTriggerActions` lives in the app's private `@blueprint-nexus/shared` package,
which this published bundle does not depend on).

## License

MIT
