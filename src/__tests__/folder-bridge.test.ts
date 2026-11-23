import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectFolder,
  disconnectFolder,
  listConnectedFolders,
  resolveFolderConnection,
  scanFolderFiles,
  syncFolderToWorkspace,
} from "../../bin/folder-bridge.js";

const PROXY_BIN = fileURLToPath(new URL("../../bin/blueprint-nexus-mcp.js", import.meta.url));

let tempRoot: string;
let projectDir: string;
let configDir: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bkn-folder-bridge-"));
  projectDir = path.join(tempRoot, "project");
  configDir = path.join(tempRoot, "config");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("folder-bridge", () => {
  it("connects, resolves from nested paths, lists, and disconnects folders", async () => {
    const wsId = "11111111-1111-4111-8111-111111111111";
    const conn = await connectFolder({
      folderPath: projectDir,
      workspaceId: wsId,
      workspaceName: "Demo Repo",
      configDir,
    });

    expect(conn.success).toBe(true);
    expect(conn.workspace_id).toBe(wsId);
    expect(fs.existsSync(conn.config_path)).toBe(true);

    const nested = path.join(projectDir, "src", "components");
    fs.mkdirSync(nested, { recursive: true });
    const resolved = await resolveFolderConnection(nested, { configDir });
    expect(resolved?.workspaceId).toBe(wsId);

    const listed = await listConnectedFolders({ configDir });
    expect(listed.count).toBe(1);
    expect(listed.folders[0].workspace_id).toBe(wsId);
    expect(listed.folders[0].workspace_name).toBe("Demo Repo");

    const disc = await disconnectFolder({ folderPath: projectDir, configDir });
    expect(disc.success).toBe(true);
    expect(disc.disconnected).toBe(true);

    const listedAfter = await listConnectedFolders({ configDir });
    expect(listedAfter.count).toBe(0);
  });

  it("filters secrets, .gitignore, binaries, oversized files, and symlink escapes", async () => {
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "ignored-dir"), { recursive: true });

    fs.writeFileSync(path.join(projectDir, "README.md"), "# Hello\n");
    fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(projectDir, ".env"), "SECRET=123\n");
    fs.writeFileSync(path.join(projectDir, ".env.local"), "SECRET=456\n");
    fs.writeFileSync(path.join(projectDir, "private.pem"), "KEYDATA\n");
    fs.writeFileSync(path.join(projectDir, "node_modules", "pkg", "index.js"), "module.exports={};\n");
    fs.writeFileSync(path.join(projectDir, "ignored-dir", "notes.md"), "ignore me\n");
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "ignored-dir/\n*.log\n");
    fs.writeFileSync(path.join(projectDir, "app.log"), "log line\n");
    fs.writeFileSync(path.join(projectDir, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fs.writeFileSync(path.join(projectDir, "big.txt"), "a".repeat(2048));

    const outsideFile = path.join(tempRoot, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "top secret");
    fs.symlinkSync(outsideFile, path.join(projectDir, "escape.txt"));

    const { files, skipped } = await scanFolderFiles(projectDir, {
      maxFileSizeBytes: 1024,
    });

    const paths = files.map((f: { path: string }) => f.path);
    expect(paths).toEqual([".gitignore", "README.md", "src/index.ts"]);
    expect(skipped.some((s: { reason: string }) => s.reason === "exceeds_max_size")).toBe(true);
    expect(skipped.some((s: { reason: string }) => s.reason === "binary_file")).toBe(true);
    expect(skipped.some((s: { reason: string }) => s.reason === "outside_root")).toBe(true);
  });

  it("performs incremental SHA-256 sync with dry_run and force support", async () => {
    const wsId = "22222222-2222-4222-8222-222222222222";
    fs.writeFileSync(path.join(projectDir, "a.md"), "# A\n");
    fs.writeFileSync(path.join(projectDir, "b.ts"), "export const b = 2;\n");

    await connectFolder({ folderPath: projectDir, workspaceId: wsId, configDir });

    const written: Array<{ path: string; workspace_id: string }> = [];
    const writeFileFn = async (args: { path: string; workspace_id: string }) => {
      written.push({ path: args.path, workspace_id: args.workspace_id });
      return { success: true };
    };

    const dry = await syncFolderToWorkspace({
      folderPath: projectDir,
      dryRun: true,
      writeFileFn,
      configDir,
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.synced_count).toBe(2);
    expect(written).toHaveLength(0);

    const first = await syncFolderToWorkspace({
      folderPath: projectDir,
      writeFileFn,
      configDir,
    });
    expect(first.synced_count).toBe(2);
    expect(written).toHaveLength(2);
    expect(written[0].workspace_id).toBe(wsId);

    // Second run with no edits skips everything
    const second = await syncFolderToWorkspace({
      folderPath: projectDir,
      writeFileFn,
      configDir,
    });
    expect(second.synced_count).toBe(0);
    expect(second.unchanged_count).toBe(2);

    // Edit one file -> only that file syncs
    fs.writeFileSync(path.join(projectDir, "a.md"), "# A updated\n");
    const third = await syncFolderToWorkspace({
      folderPath: projectDir,
      writeFileFn,
      configDir,
    });
    expect(third.synced_count).toBe(1);
    expect(third.synced_files[0].path).toBe("a.md");

    // Force re-syncs all
    const forced = await syncFolderToWorkspace({
      folderPath: projectDir,
      force: true,
      writeFileFn,
      configDir,
    });
    expect(forced.synced_count).toBe(2);
  });

  it("injects workspace_id from --folder and executes bkn_sync_folder over hosted stdio proxy", async () => {
    const wsId = "33333333-3333-4333-8333-333333333333";
    fs.writeFileSync(path.join(projectDir, "spec.md"), "# Spec\n");
    await connectFolder({ folderPath: projectDir, workspaceId: wsId, configDir });

    const receivedCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const msg = JSON.parse(body);
        if (msg.method === "tools/call") {
          receivedCalls.push(msg.params);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ success: true }) }],
            },
          })
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const responses = await new Promise<any[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [PROXY_BIN, "--key", "bsc_live_test", "--base-url", baseUrl, "--folder", projectDir],
          {
            env: { ...process.env, BLUEPRINT_CONFIG_DIR: configDir },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", () => {
          try {
            const parsed = stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => JSON.parse(l));
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Invalid JSON output: ${stdout}\nstderr: ${stderr}`));
          }
        });

        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "bkn_sync_folder", arguments: { path: projectDir } },
          }) + "\n"
        );
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "bkn_query_graph", arguments: { query: "spec" } },
          }) + "\n"
        );
        child.stdin.end();
      });

      const syncResp = responses.find((r) => r.id === 1);
      const syncPayload = JSON.parse(syncResp.result.content[0].text);
      expect(syncPayload.success).toBe(true);
      expect(syncPayload.synced_count).toBe(1);
      expect(syncPayload.workspace_id).toBe(wsId);

      // Verify bkn_write_file and bkn_query_graph both received injected workspace_id
      const writeCall = receivedCalls.find((c) => c.name === "bkn_write_file");
      expect(writeCall?.arguments.path).toBe("spec.md");
      expect(writeCall?.arguments.workspace_id).toBe(wsId);

      const queryCall = receivedCalls.find((c) => c.name === "bkn_query_graph");
      expect(queryCall?.arguments.workspace_id).toBe(wsId);
    } finally {
      server.close();
    }
  });
});
