#!/usr/bin/env node
/**
 * validate-server-json.mjs — validate server.json against the schema the MCP
 * Registry actually enforces, before spending a publish on it.
 *
 *   node scripts/validate-server-json.mjs
 *
 * The registry rejects a submission whose manifest violates its schema, and the
 * failure only shows up as a 4xx after `npm publish` has already burned the
 * version number. The rule that caught us: `description` is capped at **100
 * characters** (the manifest here carried a 441-character marketing paragraph),
 * and the repository/website fields are named `repository` and `websiteUrl`.
 *
 * Needs `ajv` (present in the monorepo's root node_modules; `npm i -D ajv` in a
 * standalone checkout). Fetches the schema from the URL in `server.json`, so it
 * needs network access.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJsonPath = path.resolve(here, "../server.json");

const manifest = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
const schemaUrl = manifest.$schema;

if (!schemaUrl) {
  console.error("✗ server.json has no $schema — the registry needs the schema URL it was written against.");
  process.exit(1);
}

let Ajv;
try {
  ({ default: Ajv } = await import("ajv"));
} catch {
  console.error("✗ ajv is not installed. Run `npm i -D ajv` (dev dependency, not shipped) and retry.");
  process.exit(1);
}

const res = await fetch(schemaUrl);
if (!res.ok) {
  console.error(`✗ could not fetch the registry schema (${res.status}) from ${schemaUrl}`);
  process.exit(1);
}
const schema = await res.json();

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

if (validate(manifest)) {
  console.log(`✓ server.json is valid against ${schemaUrl}`);
  console.log(`  name:        ${manifest.name}`);
  console.log(`  version:     ${manifest.version}`);
  console.log(`  description: ${manifest.description.length}/100 chars`);
  process.exit(0);
}

console.error(`✗ server.json does not satisfy ${schemaUrl}\n`);
for (const error of validate.errors ?? []) {
  console.error(`  ${error.dataPath || "/"} ${error.message}`);
}
process.exit(1);
