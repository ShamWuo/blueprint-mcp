import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  MCP_ADVERTISED_TOOLS,
  MCP_EXTRA_TOOL_EXECUTORS,
  MCP_PROTOCOL_VERSION,
  MCP_REPO_LOCAL_TOOL_NAMES,
  MCP_SERVER_INFO,
  MCP_TOOL_EXECUTORS,
} from "../contract";
import { handleMCPRequest } from "../handler";
import pkg from "../../package.json";
// The self-hosted bundle is plain JavaScript and reads the generated contract.
import { LOCAL_TOOL_EXECUTORS } from "../../bin/executors.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - the generator is plain ESM JavaScript
import { buildToolContract, serializeToolContract, TOOL_CONTRACT_PATH } from "../../scripts/build-tool-contract.mjs";

/**
 * The package ships one MCP server over two transports. These tests are what
 * keeps that literal: the identity it announces, the tools it advertises, and
 * the executor behind each of them must be the same in both modes.
 *
 * The failure they exist for: `--local` advertised 12 tools of which only 8
 * shared a name with the hosted 16, announced a different server name, and eight
 * advertised tools answered `-32603` or echoed their own arguments.
 */

const advertisedNames = MCP_ADVERTISED_TOOLS.map((tool) => tool.name);

describe("server identity", () => {
  it("is announced identically by the transport that both modes share", async () => {
    const response = await handleMCPRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { workspaceId: "ws", apiKeyId: "key" }
    );

    expect(response?.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    });
  });

  it("names the package it ships as, at the package's version", () => {
    expect(MCP_SERVER_INFO.name).toBe("blueprint-nexus-mcp");
    expect(pkg.bin).toHaveProperty(MCP_SERVER_INFO.name);
    expect(MCP_SERVER_INFO.version).toBe(pkg.version);
  });
});

describe("advertised tool set", () => {
  it("advertises every tool exactly once", () => {
    expect(new Set(advertisedNames).size).toBe(advertisedNames.length);
    expect(advertisedNames).toHaveLength(30);
  });

  it("gives every advertised tool an executor", () => {
    expect(Object.keys(MCP_TOOL_EXECUTORS).sort()).toEqual([...advertisedNames].sort());
  });

  it("keeps the advertised set free of the self-hosted-only tools", () => {
    for (const name of MCP_REPO_LOCAL_TOOL_NAMES) {
      expect(advertisedNames).not.toContain(name);
    }
    // ...but they stay callable here, they just are not promised to hosted users.
    for (const name of MCP_REPO_LOCAL_TOOL_NAMES) {
      expect(LOCAL_TOOL_EXECUTORS).toHaveProperty(name);
    }
  });

  it("dispatches an advertised tool to its own executor, verbatim", async () => {
    const payloads = Object.fromEntries(
      advertisedNames.map((name) => [name, { marker: name }])
    );
    const context: Record<string, unknown> = { workspaceId: "ws", apiKeyId: "key" };
    for (const [tool, executorKey] of Object.entries(MCP_TOOL_EXECUTORS)) {
      context[executorKey] = async (args: unknown) => ({ ...payloads[tool], echo: args });
    }

    for (const tool of MCP_ADVERTISED_TOOLS) {
      const args = Object.fromEntries(
        (tool.inputSchema.required || []).map((field) => [field, `${field}-value`])
      );
      const response = await handleMCPRequest(
        { jsonrpc: "2.0", id: tool.name, method: "tools/call", params: { name: tool.name, arguments: args } },
        context as never
      );

      expect(response?.error, `${tool.name} must not fail at dispatch`).toBeUndefined();
      const text = response?.result?.content?.[0]?.text;
      const parsed = JSON.parse(text);
      // The transport relays the executor's payload; a placeholder here ("… executed")
      // would mean the tool is advertised but not implemented.
      expect(parsed.marker).toBe(tool.name);
      expect(parsed.echo).toEqual(args);
    }
  });

  it("rejects a tool outside the contract with the protocol's not-found code", async () => {
    const response = await handleMCPRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bkn_not_a_tool", arguments: {} } },
      { workspaceId: "ws", apiKeyId: "key" }
    );
    expect(response?.error?.code).toBe(-32601);
  });

  it("dispatches the unadvertised agent_station through the extras map", async () => {
    const seen: unknown[] = [];
    const response = await handleMCPRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_station", arguments: { agent_id: "a1" } } },
      {
        workspaceId: "ws",
        apiKeyId: "key",
        [MCP_EXTRA_TOOL_EXECUTORS.agent_station]: async (args: unknown) => {
          seen.push(args);
          return { success: true };
        },
      } as never
    );

    expect(seen).toEqual([{ agent_id: "a1" }]);
    expect(response?.error).toBeUndefined();
    // Unadvertised means absent from tools/list, not hidden from callers.
    expect(advertisedNames).not.toContain("agent_station");
  });
});

describe("self-hosted bundle parity", () => {
  it("reads a checked-in contract that matches the source contract", () => {
    const onDisk = fs.readFileSync(TOOL_CONTRACT_PATH, "utf8");
    expect(onDisk).toBe(serializeToolContract());
    expect(JSON.parse(onDisk)).toEqual(buildToolContract());
  });

  it("executes exactly the advertised tools plus the documented extras", () => {
    expect(Object.keys(LOCAL_TOOL_EXECUTORS).sort()).toEqual(
      [
        ...advertisedNames,
        ...Object.keys(MCP_EXTRA_TOOL_EXECUTORS),
        ...MCP_REPO_LOCAL_TOOL_NAMES,
      ].sort()
    );
  });

  it("has a function behind every one of them", () => {
    for (const [name, executor] of Object.entries(LOCAL_TOOL_EXECUTORS)) {
      expect(typeof executor, `${name} must be callable`).toBe("function");
    }
  });

  it("ships the contract file in the published tarball", () => {
    // `files` must include it: without it an installed `--local` server cannot
    // read the contract at all.
    expect(pkg.files).toContain("bin/");
    expect(fs.existsSync(TOOL_CONTRACT_PATH)).toBe(true);
  });
});
