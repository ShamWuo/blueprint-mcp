import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { MCP_TOOLS } from "../tools";
import pkg from "../../package.json";

/**
 * The README is the npm landing page for this package, and `server.json` is the
 * metadata the MCP Registry publishes — both are read by agents and developers
 * who never open the source. They had already drifted from the registry the
 * server actually executes (the tool table listed 9 of 16 tools, the SDK import
 * named a package that does not exist, and the key preview showed a prefix the
 * API never issues), so this pins them to `MCP_TOOLS` and `package.json`.
 */

const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const serverJson = JSON.parse(
  fs.readFileSync(new URL("../../server.json", import.meta.url), "utf8")
) as {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string; subfolder?: string };
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
  }>;
};

describe("README parity with the tool registry", () => {
  it("documents every tool and nothing else", () => {
    const documented = new Set(
      [...readme.matchAll(/^\|\s*`((?:bkn_|agent_)[a-z_]+)`/gm)].map((match) => match[1])
    );
    const registered = new Set(MCP_TOOLS.map((tool) => tool.name));

    expect([...documented].sort()).toEqual([...registered].sort());
  });

  it("points the SDK import at the published package name", () => {
    expect(readme).toContain('from "@blueprint-nexus/mcp-server"');
    // `blueprint-nexus-mcp` is a bin, not a package: importing it resolves to nothing.
    expect(readme).not.toContain('from "blueprint-nexus-mcp"');
  });

  it("never shows an API key prefix the API does not issue", () => {
    expect(pkg.name).toBe("@blueprint-nexus/mcp-server");
    expect(readme).not.toContain("bpk_");
    expect(readme).toContain("bsc_live_");
  });

  it("installs through the npx specifier that actually resolves", () => {
    // A package with several bins only resolves `npx <pkg>` when one bin is named
    // after the unscoped package, which is why the alias exists.
    expect(Object.keys(pkg.bin)).toContain("mcp-server");
    expect(readme).toContain("@blueprint-nexus/mcp-server --key");
    expect(readme).not.toContain("blueprint-nexus-mcp@latest");
  });

  it("names the real settings path for minting a key", () => {
    expect(readme).toContain("Settings → MCP & API Keys");
  });
});

describe("registry metadata parity", () => {
  it("keeps server.json, mcpName, and the package version in sync", () => {
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].identifier).toBe(pkg.name);
    expect(serverJson.packages[0].version).toBe(pkg.version);
  });

  /**
   * The rules the official registry schema enforces, asserted offline so CI does
   * not depend on fetching it. `description` maxLength 100 is the one that bites:
   * the marketing paragraph that used to be here was 441 characters and the
   * registry rejects the publish outright (`scripts/validate-server-json.mjs`
   * checks the whole document against the live schema).
   */
  it("satisfies the registry schema's field rules", () => {
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    expect(serverJson.title.length).toBeLessThanOrEqual(100);
    expect(serverJson.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(serverJson.repository.url).toContain("github.com");
    expect(serverJson.repository.source).toBe("github");
    expect(serverJson.packages[0].registryType).toBe("npm");
    expect(serverJson.packages[0].transport.type).toBe("stdio");
  });

  it("advertises only endpoints that exist", () => {
    // Both hosts must be the canonical (www) one: the apex 308-redirects, so a
    // packaged default pointing at it costs a redirect on every single call.
    expect(serverJson.websiteUrl).toBe("https://www.bluesc.org");
    expect(pkg.homepage).toBe("https://www.bluesc.org");
    expect(JSON.stringify(serverJson)).not.toContain("https://bluesc.org");
  });
});
