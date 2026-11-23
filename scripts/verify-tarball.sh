#!/usr/bin/env bash
#
# verify-tarball.sh — pre-publish gate for @blueprint-nexus/mcp-server.
#
# Works both inside the Blueprint monorepo and in a standalone checkout of
# https://github.com/ShamWuo/blueprint-mcp.
#
# Packs the package exactly as `npm publish` would, installs the tarball into a
# clean throwaway project, and exercises it the way a consumer does:
#
#   1. the packed file list is the intended one (bins + dist + metadata, no src,
#      no tests, no .env),
#   2. `npx @blueprint-nexus/mcp-server` resolves to a bin and runs,
#   3. both bins answer `--help` / `--version`,
#   4. `--local` and `init` zero-config local auto-detect work offline,
#   5. the stdio server completes a JSON-RPC handshake against the hosted
#      endpoint (or MCP_TEST_BASE_URL) — with a real key it must return the tool
#      list; without one it must answer a clean JSON-RPC auth error rather than
#      crashing.
#
# Everything runs in a temp directory and nothing is published.
#
# Usage:
#   bash scripts/verify-tarball.sh
#   MCP_TEST_API_KEY=bsc_live_... bash scripts/verify-tarball.sh
#   MCP_TEST_BASE_URL=http://localhost:3000 bash scripts/verify-tarball.sh
#   MCP_VERIFY_SKIP_NETWORK=1 bash scripts/verify-tarball.sh   # offline steps only
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${MCP_TEST_BASE_URL:-https://www.bluesc.org}"
SKIP_NETWORK="${MCP_VERIFY_SKIP_NETWORK:-0}"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }

[[ -f "$PKG_DIR/package.json" ]] || fail "no package.json at $PKG_DIR"

step "Packing (this runs the prepack build)"
# `npm pack` runs `prepack` → `npm run build`, the same hook `npm publish` runs, so
# the tarball contains the build output a consumer would actually install.
(cd "$PKG_DIR" && npm pack --pack-destination "$WORK_DIR" >/dev/null)
TARBALL="$(find "$WORK_DIR" -maxdepth 1 -name '*.tgz' | head -1)"
[[ -n "$TARBALL" ]] || fail "npm pack produced no tarball"
ok "packed $(basename "$TARBALL") ($(wc -c < "$TARBALL" | tr -d ' ') bytes)"

step "Checking the packed file list"
FILES="$(tar -tzf "$TARBALL" | sed 's|^package/||' | grep -v '/$' | sort)"
echo "$FILES" | sed 's/^/    /'

for required in package.json README.md LICENSE server.json dist/index.js dist/contract.js bin/blueprint-nexus-mcp.js bin/blueprint-cli.js bin/blueprint-mcp.js bin/executors.js bin/local-init.js bin/tool-contract.json; do
  echo "$FILES" | grep -qx "$required" || fail "tarball is missing $required"
done
ok "required entry points and metadata present"

# `--local` reads the generated contract at startup; without it the stdio server
# cannot announce an identity or a tool list, so a missing file must fail the pack
# rather than a user's first connection.
tar -xzf "$TARBALL" -C "$WORK_DIR" package/bin/tool-contract.json
CONTRACT_TOOLS="$(node -e '
  const parsed = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!parsed.serverInfo || !Array.isArray(parsed.tools) || parsed.tools.length === 0) { console.error("tool-contract.json is not a contract"); process.exit(1); }
  console.log(parsed.tools.length);
' "$WORK_DIR/package/bin/tool-contract.json")" || fail "bundled tool-contract.json is not a contract"
ok "bundled contract advertises $CONTRACT_TOOLS tools with an identity"

if echo "$FILES" | grep -qE '(^|/)src/'; then fail "tarball ships src/ (should be dist/ only)"; fi
if echo "$FILES" | grep -qE '(^|/)\.env|\.test\.|__tests__'; then fail "tarball ships tests or env files"; fi
ok "no src/, tests, or env files in the artifact"

step "Declared bins"
BIN_KEYS="$(node -e 'const p=require(process.argv[1]);console.log(Object.keys(p.bin||{}).sort().join(","))' "$PKG_DIR/package.json")"
echo "    bin: $BIN_KEYS"
echo "$BIN_KEYS" | grep -q 'blueprint-nexus-mcp' || fail "bin map lost blueprint-nexus-mcp"
# Without a bin whose name matches the unscoped package name, `npx @blueprint-nexus/mcp-server`
# cannot pick one of the two executables and npm answers "could not determine executable to run".
echo "$BIN_KEYS" | grep -q 'mcp-server' || fail "bin map needs an 'mcp-server' alias for npx resolution"
ok "npx-resolvable bin alias present"

step "Installing the tarball into a clean project"
CONSUMER="$WORK_DIR/consumer"
mkdir -p "$CONSUMER"
(cd "$CONSUMER" && npm init -y >/dev/null && npm install --no-audit --no-fund "$TARBALL" >/dev/null 2>&1)
INSTALLED="$CONSUMER/node_modules/@blueprint-nexus/mcp-server"
[[ -d "$INSTALLED" ]] || fail "installed package not found at node_modules/@blueprint-nexus/mcp-server"
[[ -f "$INSTALLED/dist/index.js" ]] || fail "installed package has no dist/index.js"
[[ -d "$INSTALLED/src" ]] && fail "installed package contains src/"
ok "installed to node_modules/@blueprint-nexus/mcp-server"

step "Self-hosted handshake (no credentials needed)"
LOCAL_OUT="$(printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-mcp-tarball","version":"1.0.0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | "$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" --local 2>/dev/null || true)"
node -e '
  const path = process.argv[1];
  const contract = JSON.parse(require("fs").readFileSync(path, "utf8"));
  const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const msgs = lines.map((l) => JSON.parse(l));
  const init = msgs.find((m) => m.id === 1);
  const list = msgs.find((m) => m.id === 2);
  if (!init || JSON.stringify(init.result.serverInfo) !== JSON.stringify(contract.serverInfo)) {
    console.error("--local announced " + JSON.stringify(init && init.result.serverInfo) + ", contract says " + JSON.stringify(contract.serverInfo));
    process.exit(1);
  }
  const localNames = (list.result.tools || []).map((t) => t.name).sort().join(",");
  const contractNames = contract.tools.map((t) => t.name).sort().join(",");
  if (localNames !== contractNames) {
    console.error("--local advertises a different tool set than tool-contract.json");
    process.exit(1);
  }
  console.log("  identity " + contract.serverInfo.name + "@" + contract.serverInfo.version + " and " + contract.tools.length + " tools match the bundled contract");
' "$INSTALLED/bin/tool-contract.json" <<<"$LOCAL_OUT" || fail "--local did not announce the bundled contract"
ok "--local matches the hosted identity and tool set"

step "Zero-config init + local auto-detect smoke test (no credentials needed)"
INIT_REPO="$WORK_DIR/init-repo"
mkdir -p "$INIT_REPO"
printf '{"name":"tarball-smoke-repo","scripts":{"test":"echo ok"}}\n' > "$INIT_REPO/package.json"
printf '# Guardrails\nNever ship broken tarballs.\n' > "$INIT_REPO/AGENTS.md"
(cd "$INIT_REPO" && "$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" init --json >/dev/null)
[[ -f "$INIT_REPO/.bkn/graph.yaml" ]] || fail "init did not create .bkn/graph.yaml"
INIT_QUERY_OUT="$(cd "$INIT_REPO" && printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-mcp-tarball","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bkn_query_graph","arguments":{"query":"tarballs"}}}' \
  | env BLUEPRINT_API_KEY= BSC_API_KEY= "$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" 2>/dev/null || true)"
node -e '
  const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const msgs = lines.map((l) => JSON.parse(l));
  const resp = msgs.find((m) => m.id === 2);
  if (!resp || resp.result?.isError) { console.error("local query failed:", JSON.stringify(resp)); process.exit(1); }
  const payload = JSON.parse(resp.result.content[0].text);
  if (!Array.isArray(payload.nodes) || !payload.nodes.some((n) => n.name === "AGENTS.md")) {
    console.error("AGENTS.md node missing from local query:", JSON.stringify(payload));
    process.exit(1);
  }
' <<<"$INIT_QUERY_OUT" || fail "zero-key auto-detected local query failed"
ok "init + zero-key local auto-detect query succeeded"

step "Running the installed binaries"
HELP="$("$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" --help)"
echo "$HELP" | grep -q 'blueprint-nexus-mcp' || fail "--help does not name the server"
echo "$HELP" | grep -q 'https://www.bluesc.org' || fail "--help does not state the hosted default"
ok "blueprint-nexus-mcp --help"
VERSION="$("$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" --version)"
echo "    version: $VERSION"
grep -q "$(node -e 'console.log(require(process.argv[1]).version)' "$PKG_DIR/package.json")" <<<"$VERSION" \
  || fail "--version does not match package.json"
ok "blueprint-nexus-mcp --version"
"$CONSUMER/node_modules/.bin/blueprint-cli" --help | grep -q 'Blueprint MCP CLI Runner' \
  || fail "blueprint-cli --help failed"
ok "blueprint-cli --help"

step "Resolving the package the way the README documents (npx @blueprint-nexus/mcp-server)"
if (cd "$CONSUMER" && npx --no-install @blueprint-nexus/mcp-server --version >/dev/null 2>"$WORK_DIR/npx.err"); then
  ok "npx @blueprint-nexus/mcp-server resolves and runs"
else
  cat "$WORK_DIR/npx.err" >&2
  fail "npx @blueprint-nexus/mcp-server could not resolve an executable"
fi

if [[ "$SKIP_NETWORK" == "1" ]]; then
  step "Skipping the JSON-RPC handshake (MCP_VERIFY_SKIP_NETWORK=1)"
  printf '\n✓ tarball verified (offline: pack, bins, npx resolution)\n'
  exit 0
fi

step "JSON-RPC handshake against $BASE_URL"
KEY="${MCP_TEST_API_KEY:-bsc_live_invalid_key_for_verification}"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-mcp-tarball","version":"1.0.0"}}}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
OUT="$(printf '%s\n%s\n' "$INIT" "$LIST" \
  | "$CONSUMER/node_modules/.bin/blueprint-nexus-mcp" --key "$KEY" --base-url "$BASE_URL" || true)"

printf '%s\n' "$OUT" | sed 's/^/    /'
[[ -n "$OUT" ]] || fail "stdio server produced no output"
if grep -qE '^\s+at .*\(|UnhandledPromiseRejection|Error: ' <<<"$OUT"; then
  fail "stdio server crashed instead of answering JSON-RPC"
fi

if [[ -n "${MCP_TEST_API_KEY:-}" ]]; then
  TOOLS="$(node -e '
    const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const list = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
    if (!list || !list.result || !Array.isArray(list.result.tools)) { console.error("tools/list did not return a tool array"); process.exit(1); }
    console.log(list.result.tools.length);
  ' <<<"$OUT")" || fail "tools/list with a real key did not return tools"
  [[ "$TOOLS" == "$CONTRACT_TOOLS" ]] || fail "expected $CONTRACT_TOOLS tools, got $TOOLS"
  ok "initialize + tools/list returned $TOOLS tools with the supplied key"
else
  node -e '
    const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l));
    if (msgs.length < 2) { console.error("expected a response per request"); process.exit(1); }
    for (const m of msgs) {
      if (m.jsonrpc !== "2.0") { console.error("missing jsonrpc envelope"); process.exit(1); }
      if (!m.error || m.error.code !== -32001) {
        console.error("expected a JSON-RPC -32001 auth error, got: " + JSON.stringify(m));
        process.exit(1);
      }
    }
  ' <<<"$OUT" || fail "handshake without a key was not a clean protocol-level auth error"
  ok "handshake without a key answered clean JSON-RPC -32001 errors (no crash)"
  printf '    Set MCP_TEST_API_KEY=bsc_live_... to verify the full tool list.\n'
fi

printf '\n✓ tarball verified: pack, install, bins, npx resolution, JSON-RPC handshake\n'
