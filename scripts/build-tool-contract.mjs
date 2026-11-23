#!/usr/bin/env node
/**
 * Generate `bin/tool-contract.json` from `src/contract.ts` + `src/tools.ts`.
 *
 * The self-hosted server (`bin/blueprint-mcp.js`) and the tool runner
 * (`bin/blueprint-cli.js`) ship as plain JavaScript, so they cannot import the
 * TypeScript contract (and must not gain a compiler or runtime dependency to do
 * it). This script serializes the contract once into a JSON file that both the
 * bundle and the tests read, which is what makes "one tool set in both modes" a
 * fact rather than a promise.
 *
 * Run it after changing the tool list, identity, or version:
 *
 *   npm run build:tool-contract
 *
 * `src/__tests__/contract.test.ts` fails when the checked-in JSON does not match
 * the contract, so a missed run is caught rather than shipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Node strips the types but keeps the TypeScript resolution rules out of scope:
 * `src/contract.ts` imports `./tools` the way the rest of the repo does (no
 * extension), which Node's ESM resolver cannot find. Retry extensionless
 * relative specifiers with `.ts` instead of teaching every source file a
 * `.js` suffix purely for this one script's benefit.
 */
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw err;
      }
    },
  });
}

const { MCP_ADVERTISED_TOOLS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } = await import(
  "../src/contract.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
export const TOOL_CONTRACT_PATH = resolve(here, "../bin/tool-contract.json");

/** The exact payload the bundle reads, and the exact payload the tests expect. */
export function buildToolContract() {
  return {
    serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: MCP_ADVERTISED_TOOLS,
  };
}

export function serializeToolContract() {
  return `${JSON.stringify(buildToolContract(), null, 2)}\n`;
}

function main() {
  mkdirSync(dirname(TOOL_CONTRACT_PATH), { recursive: true });
  writeFileSync(TOOL_CONTRACT_PATH, serializeToolContract(), "utf8");
  process.stdout.write(
    `[build-tool-contract] wrote ${TOOL_CONTRACT_PATH} (${MCP_ADVERTISED_TOOLS.length} tools)\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
