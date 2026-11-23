import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_ADVERTISED_TOOLS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from "../contract";

/**
 * End-to-end parity for `--local`, driven the way a real MCP client drives it:
 * spawn the shipped binary and speak JSON-RPC over stdio.
 *
 * The unit tests above check the bundle's dispatch table; this checks the thing
 * an agent actually talks to, including the handshake it answers with and the
 * error codes it returns. It needs no database: every request here is settled
 * before the graph is touched.
 */

const BIN = fileURLToPath(new URL("../../bin/blueprint-mcp.js", import.meta.url));

interface JsonRpcMessage {
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string };
}

function runStdioSession(requests: unknown[], timeoutMs = 20_000): Promise<JsonRpcMessage[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        // Keep the handshake independent of any developer machine state.
        BLUEPRINT_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
        BLUEPRINT_API_KEY: "",
        BSC_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`local server timed out.\nstderr: ${stderr}`));
    }, timeoutMs);

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

    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as JsonRpcMessage)
        );
      } catch (err) {
        reject(new Error(`unparseable stdio output: ${stdout}\nstderr: ${stderr}`));
      }
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    child.stdin.end();
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "parity-test", version: "1.0.0" },
  },
};

describe("--local speaks the same contract as the hosted endpoint", () => {
  it("announces the contract identity and advertises the contract's tools", async () => {
    const messages = await runStdioSession([
      INITIALIZE,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const initialize = messages.find((message) => message.id === 1);
    expect(initialize?.result.serverInfo).toEqual({
      name: MCP_SERVER_INFO.name,
      version: MCP_SERVER_INFO.version,
    });
    expect(initialize?.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initialize?.result.capabilities).toEqual({ tools: {}, resources: {} });

    const list = messages.find((message) => message.id === 2);
    // Byte-for-byte the same registry the hosted endpoint serves, including the
    // JSON Schema each tool validates against.
    expect(list?.result.tools).toEqual(MCP_ADVERTISED_TOOLS);
  });

  it("answers an unknown tool with the protocol's not-found code", async () => {
    const messages = await runStdioSession([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "bkn_not_a_tool", arguments: {} },
      },
    ]);

    const response = messages.find((message) => message.id === 3);
    expect(response?.error?.code).toBe(-32601);
    expect(response?.error?.message).toContain("Tool not found: bkn_not_a_tool");
  });

  it("rejects missing required arguments the way the hosted handler does", async () => {
    const messages = await runStdioSession([
      INITIALIZE,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "bkn_create_node", arguments: { name: "Only a name" } },
      },
    ]);

    const response = messages.find((message) => message.id === 4);
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("Missing required parameter: 'label'");
  });
});
