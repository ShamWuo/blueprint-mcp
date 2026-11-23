import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore
import { initLocalWorkspace } from "../../bin/local-init.js";
// @ts-ignore
import { createLocalStoreExecutors } from "../../bin/local-executors.js";

const BIN = fileURLToPath(new URL("../../bin/blueprint-nexus-mcp.js", import.meta.url));

function runCli(args: string[], options: { cwd: string; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        BLUEPRINT_API_KEY: "",
        BSC_API_KEY: "",
        NEXT_PUBLIC_SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out (${args.join(" ")}).\nstderr: ${stderr}`));
    }, 20_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

describe("zero-config local init mode", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "bkn-init-test-"));
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "acme-payments",
          description: "Payments microservice with strict idempotency rules.",
          scripts: {
            typecheck: "tsc --noEmit",
            test: "vitest run",
          },
          dependencies: { next: "^16.0.0" },
          devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" },
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "AGENTS.md"),
      "# Guardrails\n\nAll Stripe webhook handlers MUST verify signatures and enforce idempotency keys.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "README.md"),
      "# Acme Payments\n\nCore billing ledger and webhook processor.\n",
      "utf8"
    );
    await fs.mkdir(path.join(repoDir, "docs", "adr"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "docs", "adr", "001-postgres-rls.md"),
      "# ADR 001: Row-Level Security\n\nEvery tenant table requires RLS bound to auth.uid().\n",
      "utf8"
    );
    await fs.mkdir(path.join(repoDir, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, ".cursor", "rules", "no-raw-sql.mdc"),
      "# Rule\n\nNever interpolate user input into SQL strings.\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("indexes repo docs, ADRs, cursor rules, and verification scripts into .bkn/", async () => {
    const res = await initLocalWorkspace({ rootDir: repoDir });

    expect(res.success).toBe(true);
    expect(res.workspaceName).toBe("acme-payments");
    expect(res.alreadyInitialized).toBe(false);
    expect(res.verificationRules.map((v: any) => v.script)).toEqual(["typecheck", "test"]);

    const graphYaml = await fs.readFile(path.join(repoDir, ".bkn", "graph.yaml"), "utf8");
    expect(graphYaml).toContain("bkn_version: 1");
    expect(graphYaml).toContain("workspace: acme-payments");

    const executors = createLocalStoreExecutors(path.join(repoDir, ".bkn"));
    const rules = await executors.bkn_query_graph(null, { query: "idempotency" });
    expect(rules.nodes.some((n: any) => n.name === "AGENTS.md" && n.label === "Rule")).toBe(true);

    const adr = await executors.bkn_query_graph(null, { query: "Row-Level Security" });
    expect(adr.nodes.some((n: any) => n.label === "Decision")).toBe(true);

    const cursorRule = await executors.bkn_query_graph(null, { query: "SQL strings" });
    expect(cursorRule.nodes.some((n: any) => n.label === "Rule")).toBe(true);
  });

  it("preserves existing config on re-run and merges client MCP configs without clobbering", async () => {
    const cursorConfigPath = path.join(repoDir, ".cursor", "mcp.json");
    await fs.writeFile(
      cursorConfigPath,
      JSON.stringify({ mcpServers: { existingServer: { command: "echo", args: ["hi"] } } }, null, 2),
      "utf8"
    );

    const first = await initLocalWorkspace({ rootDir: repoDir, clients: ["cursor"] });
    expect(first.clientConfigs).toHaveLength(1);

    const merged = JSON.parse(await fs.readFile(cursorConfigPath, "utf8"));
    expect(merged.mcpServers.existingServer).toEqual({ command: "echo", args: ["hi"] });
    expect(merged.mcpServers.blueprint.command).toBe("npx");
    expect(merged.mcpServers.blueprint.args).toContain("--local");

    const second = await initLocalWorkspace({ rootDir: repoDir, name: "ignored-without-force" });
    expect(second.alreadyInitialized).toBe(true);
    expect(second.workspaceName).toBe("acme-payments");
  });

  it("boots stdio server with zero API key once initialized and answers bkn_query_graph", async () => {
    const initRun = await runCli(["init", "--json"], { cwd: repoDir });
    expect(initRun.code).toBe(0);
    const initPayload = JSON.parse(initRun.stdout);
    expect(initPayload.success).toBe(true);

    const sessionInput =
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "init-e2e-test", version: "1.0.0" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "bkn_query_graph",
            arguments: { query: "idempotency" },
          },
        }),
      ].join("\n") + "\n";

    // Run with NO flags and NO API key — must auto-detect .bkn/graph.yaml in cwd!
    const stdioRun = await runCli([], { cwd: repoDir, stdin: sessionInput });
    expect(stdioRun.code).toBe(0);

    const messages = stdioRun.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const queryResp = messages.find((m) => m.id === 2);
    expect(queryResp?.result?.isError).not.toBe(true);
    const payload = JSON.parse(queryResp.result.content[0].text);
    expect(payload.nodes.some((n: any) => n.name === "AGENTS.md")).toBe(true);
  });
});
