import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore - generated ESM module, not part of the TS program
import * as generatedStore from "../../bin/local-store.generated.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(HERE, "../../../..");
const MONOREPO_GENERATOR = path.join(REPO_ROOT, "scripts/generate-mcp-local-store.mjs");
const IN_MONOREPO = existsSync(MONOREPO_GENERATOR);

const REGENERATE = "npm run generate:local-store --workspace @blueprint-nexus/mcp-server";

describe("MCP local store is generated from the shared implementation", () => {
  it("matches the checked-in output byte for byte (monorepo) or ships non-empty generated modules (standalone)", async () => {
    if (!IN_MONOREPO) {
      for (const file of ["graph-format.generated.js", "local-store.generated.js"]) {
        const content = await fs.readFile(path.join(PKG_ROOT, "bin", file), "utf8");
        expect(content.length).toBeGreaterThan(0);
        expect(content).toContain("GENERATED FILE");
      }
      return;
    }

    // @ts-ignore - plain JS build script, outside the TS program
    const { buildLocalStoreArtifacts } = await import(/* @vite-ignore */ MONOREPO_GENERATOR);

    const artifacts = await buildLocalStoreArtifacts();
    expect(artifacts).toHaveLength(2);

    const stale: string[] = [];
    for (const artifact of artifacts) {
      const committed = await fs.readFile(artifact.path, "utf8").catch(() => "");
      if (committed !== artifact.content) stale.push(path.basename(artifact.path));
    }

    expect(stale, `Generated MCP modules are stale (${stale.join(", ")}). Run: ${REGENERATE}`).toEqual([]);
  });

  it("leaves no hand-written duplicate in the package", async () => {
    await expect(fs.access(path.join(PKG_ROOT, "bin/local-store.js"))).rejects.toThrow();
  });

  it("exposes the portable store from the generated module", () => {
    expect(typeof generatedStore.LocalBKNStore).toBe("function");
    expect(typeof generatedStore.toNodeKey).toBe("function");
    expect(generatedStore.toNodeKey("API Gateway")).toBe("api-gateway");
  });
});
