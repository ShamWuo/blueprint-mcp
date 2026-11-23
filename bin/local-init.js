import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { LocalBKNStore, slugify, toNodeKey } from "./local-store.generated.js";

const MAX_EXCERPT_CHARS = 3500;
const MAX_ADR_FILES = 10;
const MAX_CURSOR_RULES = 10;

const GUARDRAIL_CANDIDATES = [
  { relPath: "AGENTS.md", label: "Rule", edgeType: "governs", tag: "agents" },
  { relPath: "CLAUDE.md", label: "Rule", edgeType: "governs", tag: "claude" },
  { relPath: ".cursorrules", label: "Rule", edgeType: "governs", tag: "cursor" },
  { relPath: ".github/copilot-instructions.md", label: "Rule", edgeType: "governs", tag: "copilot" },
  { relPath: "CONTRIBUTING.md", label: "Rule", edgeType: "governs", tag: "contributing" },
];

const ARCHITECTURE_CANDIDATES = [
  { relPath: "ARCHITECTURE.md", label: "Decision", edgeType: "documents", tag: "architecture" },
  { relPath: "MAP.md", label: "Resource", edgeType: "documents", tag: "map" },
  { relPath: "DESIGN.md", label: "Decision", edgeType: "documents", tag: "design" },
  { relPath: "README.md", label: "Resource", edgeType: "documents", tag: "readme" },
];

const VERIFICATION_SCRIPT_CANDIDATES = ["typecheck", "lint", "test", "build"];

const CLIENT_CONFIG_TARGETS = {
  cursor: {
    relPath: path.join(".cursor", "mcp.json"),
    rootKey: "mcpServers",
  },
  claude: {
    relPath: ".mcp.json",
    rootKey: "mcpServers",
  },
  mcp: {
    relPath: ".mcp.json",
    rootKey: "mcpServers",
  },
  vscode: {
    relPath: path.join(".vscode", "mcp.json"),
    rootKey: "servers",
  },
};

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractHeadings(markdown, limit = 12) {
  const headings = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (match) {
      headings.push(match[2].trim());
      if (headings.length >= limit) break;
    }
  }
  return headings;
}

function truncateExcerpt(text, maxChars = MAX_EXCERPT_CHARS) {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n… (truncated for local graph index)`;
}

async function detectProjectIdentity(rootDir) {
  const detectedStack = [];
  let inferredName = null;
  let inferredDescription = "";
  let packageScripts = {};

  const pkg = await readJsonIfExists(path.join(rootDir, "package.json"));
  if (pkg && typeof pkg === "object") {
    detectedStack.push("Node.js");
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      inferredName = pkg.name.trim();
    }
    if (typeof pkg.description === "string" && pkg.description.trim()) {
      inferredDescription = pkg.description.trim();
    }
    if (pkg.scripts && typeof pkg.scripts === "object") {
      packageScripts = pkg.scripts;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.typescript || fs.existsSync(path.join(rootDir, "tsconfig.json"))) {
      detectedStack.push("TypeScript");
    }
    if (deps.next) detectedStack.push("Next.js");
    else if (deps.react) detectedStack.push("React");
    if (deps.vitest) detectedStack.push("Vitest");
    else if (deps.jest) detectedStack.push("Jest");
  }

  const pyproject = await readTextIfExists(path.join(rootDir, "pyproject.toml"));
  if (pyproject) {
    detectedStack.push("Python");
    if (!inferredName) {
      const m = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) inferredName = m[1].trim();
    }
  }

  const cargoToml = await readTextIfExists(path.join(rootDir, "Cargo.toml"));
  if (cargoToml) {
    detectedStack.push("Rust");
    if (!inferredName) {
      const m = cargoToml.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) inferredName = m[1].trim();
    }
  }

  const goMod = await readTextIfExists(path.join(rootDir, "go.mod"));
  if (goMod) {
    detectedStack.push("Go");
    if (!inferredName) {
      const m = goMod.match(/^\s*module\s+(\S+)/m);
      if (m) inferredName = path.basename(m[1].trim());
    }
  }

  if (fs.existsSync(path.join(rootDir, "Dockerfile")) || fs.existsSync(path.join(rootDir, "docker-compose.yml"))) {
    detectedStack.push("Docker");
  }

  let topLevelDirs = [];
  try {
    const entries = await fsp.readdir(rootDir, { withFileTypes: true });
    topLevelDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
      .map((e) => e.name)
      .sort()
      .slice(0, 15);
  } catch {
    // ignore unreadable directory
  }

  return {
    inferredName: inferredName || path.basename(rootDir) || "local-workspace",
    inferredDescription,
    detectedStack: [...new Set(detectedStack)],
    topLevelDirs,
    packageScripts,
  };
}

async function listMatchingFiles(dirPath, extensions, limit) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && extensions.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .map((e) => e.name)
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function buildMcpClientConfig({ storeDir }) {
  const args = ["-y", "--package", "@blueprint-nexus/mcp-server", "blueprint-nexus-mcp", "--local"];
  if (storeDir) {
    args.push("--path", storeDir);
  }
  return {
    mcpServers: {
      blueprint: {
        command: "npx",
        args,
      },
    },
  };
}

export async function writeClientMcpConfig({ rootDir, storeDir, client }) {
  const key = String(client || "").toLowerCase();
  const target = CLIENT_CONFIG_TARGETS[key];
  if (!target) {
    throw new Error(
      `Unsupported client '${client}'. Supported values: ${Object.keys(CLIENT_CONFIG_TARGETS).join(", ")}.`
    );
  }

  const absPath = path.join(rootDir, target.relPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });

  const existing = (await readJsonIfExists(absPath)) || {};
  const serversBlock =
    existing[target.rootKey] && typeof existing[target.rootKey] === "object"
      ? { ...existing[target.rootKey] }
      : {};

  const entry = {
    command: "npx",
    args: ["-y", "--package", "@blueprint-nexus/mcp-server", "blueprint-nexus-mcp", "--local", "--path", storeDir],
  };
  if (target.rootKey === "servers") {
    entry.type = "stdio";
  }

  serversBlock.blueprint = entry;
  const merged = {
    ...existing,
    [target.rootKey]: serversBlock,
  };

  await fsp.writeFile(absPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return {
    client: key,
    path: absPath,
    relPath: target.relPath,
  };
}

/**
 * Initialize a zero-config local `.bkn/` knowledge graph in a repository.
 * Requires no Blueprint Nexus API key and no Supabase credentials.
 */
export async function initLocalWorkspace(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const storeDir = path.resolve(options.storeDir || path.join(rootDir, ".bkn"));
  const scan = options.scan !== false;
  const force = Boolean(options.force);

  const identity = await detectProjectIdentity(rootDir);
  const workspaceName = (options.name && String(options.name).trim()) || identity.inferredName;
  const workspaceId = slugify(workspaceName) || "local";

  const store = new LocalBKNStore(storeDir);
  const alreadyInitialized = fs.existsSync(store.graphMetaPath);
  await fsp.mkdir(storeDir, { recursive: true });

  const existingConfig = await readJsonIfExists(store.configPath);
  const config =
    existingConfig && !force
      ? existingConfig
      : {
          workspaceId,
          workspaceName,
          description: identity.inferredDescription || `Local architectural memory for ${workspaceName}`,
          mode: "local_filesystem",
          rootDir,
          created_at: existingConfig?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

  await fsp.writeFile(store.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await store.ensureDirectories();

  const nodesCreated = [];
  const edgesCreated = [];
  const verificationRules = [];

  const projectNodeKey = toNodeKey(`project-${workspaceId}`);
  const projectContentLines = [
    identity.inferredDescription || `Root architectural concept for ${workspaceName}.`,
    identity.detectedStack.length > 0 ? `Stack: ${identity.detectedStack.join(", ")}` : null,
    identity.topLevelDirs.length > 0 ? `Top-level directories: ${identity.topLevelDirs.join(", ")}` : null,
  ].filter(Boolean);

  await store.saveNode({
    id: projectNodeKey,
    title: workspaceName,
    label: "Concept",
    status: "active",
    content: projectContentLines.join("\n"),
    tags: ["project", "root", ...identity.detectedStack.map((s) => slugify(s)).filter(Boolean)],
    properties: {
      rootDir,
      stack: identity.detectedStack,
      directories: identity.topLevelDirs,
      indexedBy: "blueprint-nexus-mcp init",
    },
  });
  nodesCreated.push({ key: projectNodeKey, title: workspaceName, label: "Concept" });

  if (scan) {
    const indexDoc = async ({ relPath, label, edgeType, tag }) => {
      const fullPath = path.join(rootDir, relPath);
      const text = await readTextIfExists(fullPath);
      if (!text || !text.trim()) return;

      const headings = extractHeadings(text);
      const baseTitle = path.basename(relPath, path.extname(relPath));
      const title =
        relPath.includes("/") && !relPath.startsWith(".")
          ? `${path.basename(path.dirname(relPath))}/${baseTitle}`
          : path.basename(relPath);
      const nodeKey = toNodeKey(`${tag}-${relPath}`);

      await store.saveNode({
        id: nodeKey,
        title,
        label,
        status: "active",
        content: truncateExcerpt(text),
        tags: [tag, "auto-indexed"],
        properties: {
          source_path: relPath,
          headings,
        },
      });
      nodesCreated.push({ key: nodeKey, title, label, sourcePath: relPath });

      await store.saveEdge({
        id: "",
        source: nodeKey,
        target: projectNodeKey,
        type: edgeType,
        properties: { note: `Indexed from ${relPath}` },
      });
      edgesCreated.push({ source: nodeKey, target: projectNodeKey, type: edgeType });
    };

    for (const candidate of GUARDRAIL_CANDIDATES) {
      await indexDoc(candidate);
    }
    for (const candidate of ARCHITECTURE_CANDIDATES) {
      await indexDoc(candidate);
    }

    // Index .cursor/rules/*.mdc or *.md
    const cursorRulesDir = path.join(rootDir, ".cursor", "rules");
    const cursorRuleFiles = await listMatchingFiles(cursorRulesDir, [".mdc", ".md"], MAX_CURSOR_RULES);
    for (const fileName of cursorRuleFiles) {
      await indexDoc({
        relPath: path.join(".cursor", "rules", fileName),
        label: "Rule",
        edgeType: "governs",
        tag: "cursor-rule",
      });
    }

    // Index docs/adr/*.md or docs/decisions/*.md
    for (const adrRelDir of [path.join("docs", "adr"), path.join("docs", "decisions")]) {
      const adrFiles = await listMatchingFiles(path.join(rootDir, adrRelDir), [".md", ".mdx"], MAX_ADR_FILES);
      for (const fileName of adrFiles) {
        await indexDoc({
          relPath: path.join(adrRelDir, fileName),
          label: "Decision",
          edgeType: "decided_by",
          tag: "adr",
        });
      }
    }

    // Seed executable verification rules from detected package.json scripts
    for (const scriptName of VERIFICATION_SCRIPT_CANDIDATES) {
      if (typeof identity.packageScripts[scriptName] === "string" && identity.packageScripts[scriptName].trim()) {
        const ruleKey = toNodeKey(`verify-${scriptName}`);
        const command = `npm run ${scriptName}`;
        await store.saveNode({
          id: ruleKey,
          title: `Verify: ${scriptName}`,
          label: "Rule",
          status: "active",
          content: `Repository verification gate discovered from package.json script '${scriptName}': \`${identity.packageScripts[scriptName]}\`.`,
          tags: ["verification", "invariant", scriptName],
          properties: {
            source_path: "package.json",
            verification: {
              type: "command",
              command,
              cwd: rootDir,
            },
          },
        });
        nodesCreated.push({ key: ruleKey, title: `Verify: ${scriptName}`, label: "Rule", sourcePath: "package.json" });
        verificationRules.push({ key: ruleKey, script: scriptName, command });

        await store.saveEdge({
          id: "",
          source: ruleKey,
          target: projectNodeKey,
          type: "governs",
          properties: { note: `Executable verification gate (${command})` },
        });
        edgesCreated.push({ source: ruleKey, target: projectNodeKey, type: "governs" });
      }
    }
  }

  // Write concise advisory context.md if missing or forced
  if (force || !fs.existsSync(store.contextPath)) {
    const contextLines = [
      `# ${workspaceName} — Local Knowledge Graph`,
      "",
      identity.inferredDescription || "Initialized with `@blueprint-nexus/mcp-server init` (zero-config local `.bkn/` store).",
      "",
      identity.detectedStack.length > 0 ? `- **Stack:** ${identity.detectedStack.join(", ")}` : null,
      `- **Indexed nodes:** ${nodesCreated.length}`,
      `- **Verification gates:** ${verificationRules.length > 0 ? verificationRules.map((v) => `\`${v.command}\``).join(", ") : "none detected"}`,
      "",
      "Run `bkn_query_graph` to recall repo rules and decisions, or `bkn_verify_workspace` to run executable invariant checks.",
    ].filter((line) => line !== null);
    await fsp.writeFile(store.contextPath, contextLines.join("\n") + "\n", "utf8");
  }

  const clientConfigs = [];
  const requestedClients = Array.isArray(options.clients)
    ? options.clients
    : options.client
      ? [options.client]
      : [];
  for (const client of requestedClients) {
    const written = await writeClientMcpConfig({ rootDir, storeDir, client });
    clientConfigs.push(written);
  }

  return {
    success: true,
    rootDir,
    storeDir,
    workspaceName: config.workspaceName,
    workspaceId: config.workspaceId,
    alreadyInitialized,
    nodesCreated,
    edgesCreated,
    verificationRules,
    clientConfigs,
    mcpConfigSnippet: buildMcpClientConfig({ storeDir }),
  };
}
