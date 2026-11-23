#!/usr/bin/env node
/**
 * Ensures the generated local-store modules (`bin/graph-format.generated.js`,
 * `bin/local-store.generated.js`) are present and up to date.
 *
 * - Inside the Blueprint monorepo: delegates to `../../scripts/generate-mcp-local-store.mjs`
 *   so changes in `packages/shared/src/lib/` flow into `bin/` automatically.
 * - Inside the standalone public mirror (`ShamWuo/blueprint-mcp`): verifies that
 *   the pre-generated modules exist and are non-empty, without requiring the
 *   private monorepo's `packages/shared` directory.
 */

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, "..");
const MONOREPO_GENERATOR = path.resolve(PKG_DIR, "../../scripts/generate-mcp-local-store.mjs");
const GENERATED_FILES = [
  path.join(PKG_DIR, "bin", "graph-format.generated.js"),
  path.join(PKG_DIR, "bin", "local-store.generated.js"),
];

if (existsSync(MONOREPO_GENERATOR)) {
  const result = spawnSync(process.execPath, [MONOREPO_GENERATOR, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const missing = GENERATED_FILES.filter((file) => !existsSync(file) || statSync(file).size === 0);
if (missing.length > 0) {
  console.error(
    `[generate-local-store] Missing pre-generated local-store modules in standalone checkout:\n` +
      missing.map((file) => `  - ${path.relative(PKG_DIR, file)}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `[generate-local-store] Standalone checkout: verified ${GENERATED_FILES.length} pre-generated local-store modules.`,
);
