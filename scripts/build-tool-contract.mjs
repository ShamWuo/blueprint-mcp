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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

/**
 * Node 22.6+ strips types but keeps TypeScript extensionless resolution out of
 * scope: `src/contract.ts` imports `./tools` without an extension. Register a
 * lightweight hook when available, and fall back to transpiling with the
 * package's own `typescript` devDependency on Node 18/20 where `.ts` imports
 * throw `ERR_UNKNOWN_FILE_EXTENSION`.
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

async function loadContractModule() {
  try {
    return await import("../src/contract.ts");
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : undefined;
    if (code !== "ERR_UNKNOWN_FILE_EXTENSION" && code !== "ERR_MODULE_NOT_FOUND") {
      throw err;
    }
    const tsMod = await import("typescript");
    const ts = tsMod.default ?? tsMod;
    const workDir = mkdtempSync(join(tmpdir(), "blueprint-tool-contract-"));
    try {
      const files = [
        { src: "src/tools.ts", out: "tools.mjs", rewrites: [] },
        {
          src: "src/contract.ts",
          out: "contract.mjs",
          rewrites: [
            ['from "./tools"', 'from "./tools.mjs"'],
            ["from './tools'", "from './tools.mjs'"],
          ],
        },
      ];
      for (const file of files) {
        const raw = readFileSync(join(pkgRoot, file.src), "utf8");
        let output = ts.transpileModule(raw, {
          fileName: file.src,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
        for (const [from, to] of file.rewrites) {
          output = output.split(from).join(to);
        }
        writeFileSync(join(workDir, file.out), output, "utf8");
      }
      return await import(pathToFileURL(join(workDir, "contract.mjs")).href);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

const { MCP_ADVERTISED_TOOLS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } =
  await loadContractModule();

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
