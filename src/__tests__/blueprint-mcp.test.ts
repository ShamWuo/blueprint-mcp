import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { getHotPath, logDecision, updateKnowledge } from "../../bin/core.js";

/**
 * The kernel tools write into the checkout's `kernel/` directory. These tests
 * used to call them without a root, so every `npm test` run appended a
 * "Test MCP Decision" block to the real `kernel/notes/notes.md` (and wrote a
 * throwaway markdown file into `kernel/knowledge/`). They now target a temp
 * directory, and the assertions below pin that: the repository's audit log must
 * be byte-identical after the suite has run.
 */

const REPO_NOTES_PATH = fileURLToPath(new URL("../../../../kernel/notes/notes.md", import.meta.url));
const HAS_MONOREPO_KERNEL = existsSync(REPO_NOTES_PATH);

let rootDir: string;
let notesBefore: string | null = null;

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "blueprint-kernel-"));
  if (HAS_MONOREPO_KERNEL) {
    notesBefore = await readFile(REPO_NOTES_PATH, "utf-8");
  }
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("Blueprint MCP Kernel & Workspace Operations", () => {
  it("retrieves hot path rules and agent instructions", async () => {
    const hotPath = await getHotPath();
    expect(hotPath).toBeDefined();
    expect(typeof hotPath.agents).toBe("string");
    if (HAS_MONOREPO_KERNEL) {
      expect(hotPath.agents).toContain("Repository Guidelines");
    }
    expect(hotPath.summary).toContain("Tier 1 Safety Guardrails");
  });

  it("updates knowledge file cleanly without traversal", async () => {
    const testFile = "test-mcp-verification.md";
    const testContent = "# MCP Verification\nOperational and verified.";
    const res = await updateKnowledge(testFile, testContent, { rootDir });
    expect(res.success).toBe(true);
    expect(res.file).toBe(testFile);

    const readBack = await readFile(res.path, "utf-8");
    expect(readBack).toBe(testContent);

    // Clean up test file
    await rm(res.path, { force: true });
  });

  it("keeps a traversal-shaped filename inside the target root", async () => {
    const res = await updateKnowledge("../../escape.md", "should stay inside", { rootDir });
    expect(res.file).toBe("escape.md");
    expect(res.path.startsWith(path.join(rootDir, "kernel/knowledge"))).toBe(true);
    await rm(res.path, { force: true });
  });

  it("logs architectural decisions into the injected root", async () => {
    const res = await logDecision("Injected-root decision", "Written to a temp dir", "Vitest", {
      rootDir,
    });
    expect(res.success).toBe(true);
    expect(res.decision).toBe("Injected-root decision");
    expect(res.notesPath.startsWith(rootDir)).toBe(true);

    const written = await readFile(res.notesPath, "utf-8");
    expect(written).toContain("## [");
    expect(written).toContain("Injected-root decision");
  });

  it("refuses to write into the checkout when a test forgets to inject a root", async () => {
    await expect(
      logDecision("Leak check", "must never reach the repository", "Vitest")
    ).rejects.toThrow(/Refusing to write into the checkout during a test run/);

    await expect(updateKnowledge("leak-check.md", "nope")).rejects.toThrow(
      /Refusing to write into the checkout during a test run/
    );
  });

  it("leaves the repository's own audit log untouched", async () => {
    if (!HAS_MONOREPO_KERNEL) {
      expect(notesBefore).toBeNull();
      return;
    }
    // `files_to_modify`-style guards are only real if the repo is compared, not
    // the temp dir: re-read the real notes after every write above.
    const notesAfter = await readFile(REPO_NOTES_PATH, "utf-8");
    expect(notesAfter).toBe(notesBefore);
    expect(notesAfter).not.toContain("Injected-root decision");
  });
});
