# Publishing @blueprint-nexus/mcp-server

Everything is prepped; these are the steps that need a human (accounts/credentials), in order.

## 0. Preflight (no credentials needed)

```bash
cd packages/mcp-server
npm run build:tool-contract         # re-serialize the contract into bin/ (see below)
npm run test && npm run typecheck   # package suite + types
npm pack --dry-run                  # bins + dist + bin/tool-contract.json only
npm run verify:pack                 # install the tarball in a temp dir and run it
node scripts/validate-server-json.mjs   # registry manifest against the official schema
```

`bin/tool-contract.json` is generated from `src/contract.ts` and is what the plain-JS
`--local` bundle reads for its identity and tool list, so the two modes cannot advertise
different servers. `npm run test` fails if that file is stale — regenerate it whenever the
tool list, the server name, or the version changes, and keep `MCP_SERVER_INFO.version` in
step with `package.json` (a test enforces both).

The tarball check now also asserts that the installed `--local` binary announces the same
identity and the same 30 tools as the bundled contract.

The tarball check is the one that matters: it installs the packed artifact into a clean
project and runs `--help`, `--version`, the `npx @blueprint-nexus/mcp-server` resolution, and a
real JSON-RPC `initialize` handshake, so a broken `files`/`bin` entry or a bad endpoint default
fails before the version number is burned.

The schema check covers step 2: the registry rejects a manifest that violates its schema
(`description` is capped at 100 characters), and that would otherwise surface as a 4xx only after
the npm publish had already consumed the version.

## 1. npm publish (scoped public)

```bash
cd packages/mcp-server
npm login            # npm account with access to the @blueprint-nexus scope
npm publish          # publishConfig.access=public is already set
```

- The `prepack` hook builds `dist/` automatically.
- The scope has to exist and be owned by the logged-in account. If `npm publish` answers
  `404 ... Scope not found`, create the org first (`npm org create blueprint-nexus`, or via
  the npm website) before retrying — logging in alone is not enough.
- Verify: `npx -y @blueprint-nexus/mcp-server --help`

## 2. Official MCP Registry

Ownership is verified via `"mcpName": "org.bluesc/blueprint-nexus-mcp"` in package.json — **it must stay in sync** with `server.json`'s `name` (both already match).

```bash
# Create a registry token first (https://registry.modelcontextprotocol.io)
cd packages/mcp-server
MCP_REGISTRY_TOKEN=... node scripts/publish-registry.mjs
```

Alternatively submit `server.json` manually via the registry's web UI / GitHub PR.

## 3. Anthropic Desktop Extension (.mcpb) — one-click Claude install

```bash
cd packages/mcp-server
npm run pack:mcpb                  # produces a .mcpb bundle via @anthropic-ai/mcpb
```

Distribute the `.mcpb` from GitHub Releases (or attach it to the repo). Claude Desktop users double-click to install; the API key is prompted at install time (`manifest.json` user_config).

**Public mirror repository:** `https://github.com/ShamWuo/blueprint-mcp` is the public MIT
mirror of `packages/mcp-server` (synced from the private Blueprint monorepo via
`npm run mcp:sync-mirror`). Host `.mcpb` bundles as GitHub Releases on `ShamWuo/blueprint-mcp`,
which also backs the public repo links in `package.json`, `server.json`, and directory listings.

## 4. Directory listings (free, manual, 10 min each)

Submit with the npm name + GitHub repo link:
- https://mcp.so
- https://glama.ai/mcp/servers
- https://www.pulsemcp.com
- GitHub topic: add `mcp-server` topic to the repo

## 5. Release cadence

On each release: bump `version` in `package.json`, `server.json`, and `MCP_SERVER_INFO` in
`src/contract.ts` (the registry requires the manifest to match exactly, and the contract test
pins the announced identity to all three), run `npm run build:tool-contract`, then re-run
steps 1–2. Consider a GitHub Action later: tag → npm publish → registry publish.

## Known gap: `dist/` is not loadable by plain Node ESM

`tsc` preserves the source's extensionless specifiers, so `dist/index.js` reads
`export * from "./tools"` and `node -e "import('./dist/index.js')"` fails with
`ERR_MODULE_NOT_FOUND`. Bundler consumers (Next.js, vitest, esbuild) resolve it fine — which
is how every consumer in this repo loads the package — but a plain-Node
`import { BlueprintMCPClient } from "@blueprint-nexus/mcp-server"` does not work. Fixing it
means emitting `.js` in the source specifiers (or compiling with `module: node16`); it is
pre-existing and untouched here.

## What shipped in this prep

- `bin/blueprint-nexus-mcp.js` — new stdio entry point: **hosted proxy mode** (forwards JSON-RPC to `https://bluesc.org/api/mcp/messages` with Bearer auth — no DB credentials exposed) + `--local` mode for self-hosters.
- `tsconfig.build.json` + `dist/` build for the SDK (`BlueprintMCPClient`).
- `server.json` — official MCP Registry metadata (schema 2025-12-11).
- `manifest.json` — Anthropic Desktop Extension manifest.
- `README.md`, `LICENSE` (MIT), `.npmignore`.
- Internal consumers (`apps/web`, mobile) unaffected — package name unchanged; typecheck + 15/15 tests pass.
