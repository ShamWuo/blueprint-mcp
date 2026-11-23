#!/usr/bin/env node
/**
 * publish-registry.mjs — submits server.json to the official MCP Registry.
 *
 * Prerequisites:
 *   1. `npm publish` succeeded (package + mcpName must be live on npm).
 *   2. MCP_REGISTRY_TOKEN env var set (registry account token):
 *        MCP_REGISTRY_TOKEN=... node scripts/publish-registry.mjs
 *
 * Docs: https://modelcontextprotocol.io/registry/publishing
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverJsonPath = path.resolve(__dirname, "../server.json");

if (!process.env.MCP_REGISTRY_TOKEN) {
  console.error("Missing MCP_REGISTRY_TOKEN env var. Create a token at the MCP Registry, then:");
  console.error("  MCP_REGISTRY_TOKEN=... node scripts/publish-registry.mjs");
  process.exit(1);
}

const body = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
body._meta = {
  "io.modelcontextprotocol.registry/official": {
    publisher_facade: true
  }
};

const res = await fetch(`${REGISTRY_URL}/v0/servers/publish`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.MCP_REGISTRY_TOKEN}`
  },
  body: JSON.stringify(body)
});

if (!res.ok) {
  const text = await res.text().catch(() => "");
  console.error(`Registry publish failed (${res.status}): ${text}`);
  process.exit(1);
}

const result = await res.json().catch(() => ({}));
console.log("✅ Published to MCP Registry:", result.server?.id || result.id || "ok");
