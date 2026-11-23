import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 256 * 1024; // 256 KB
export const CONNECTION_DIR_NAME = ".bkn";
export const CONNECTION_FILE_NAME = "connection.json";
export const SYNC_STATE_FILE_NAME = "sync-state.json";

export const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  ".bkn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".DS_Store",
  ".venv",
  "venv",
  "__pycache__",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa(?:\..+)?$/i,
  /^id_ed25519(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

const EXTENSION_LANGUAGE_MAP = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".txt": "text",
};

export function getGlobalConfigDir(configDir) {
  return (
    configDir ||
    process.env.BLUEPRINT_CONFIG_DIR ||
    path.join(os.homedir(), ".blueprint")
  );
}

function getRegistryPath(configDir) {
  return path.join(getGlobalConfigDir(configDir), "folder-connections.json");
}

function toPosixPath(relPath) {
  return relPath.split(path.sep).join("/");
}

function inferLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] || "text";
}

function globToRegex(pattern) {
  let normalized = pattern.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized) return null;
  const hasSlash = normalized.includes("/");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR__/g, ".*");
  if (hasSlash) {
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }
  return new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
}

function compilePatternList(patterns = []) {
  return patterns
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p && !p.startsWith("#"))
    .map((p) => ({ raw: p, regex: globToRegex(p) }))
    .filter((entry) => entry.regex !== null);
}

async function readIgnoreFile(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

function isSecretOrDefaultIgnored(relPosixPath) {
  const segments = relPosixPath.split("/");
  for (const seg of segments) {
    if (DEFAULT_IGNORED_SEGMENTS.has(seg)) return true;
  }
  const baseName = segments[segments.length - 1] || "";
  return SECRET_FILE_PATTERNS.some((rx) => rx.test(baseName));
}

function isBinaryBuffer(buf) {
  const sampleLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmpPath, filePath);
}

async function resolveCanonicalDirectory(folderPath) {
  if (!folderPath || typeof folderPath !== "string") {
    throw new Error("A valid folder path is required.");
  }
  const resolved = path.resolve(folderPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Folder does not exist or is not a directory: ${resolved}`);
  }
  return await fsp.realpath(resolved);
}

/**
 * Connect a local folder to a Blueprint workspace.
 * Writes `<folder>/.bkn/connection.json` and records the mapping in `<configDir>/folder-connections.json`.
 */
export async function connectFolder({
  folderPath,
  workspaceId,
  workspaceName,
  include,
  ignore,
  maxFileSizeBytes,
  configDir,
}) {
  const canonicalRoot = await resolveCanonicalDirectory(folderPath);
  const resolvedWorkspaceId =
    (typeof workspaceId === "string" && workspaceId.trim()) ||
    process.env.BLUEPRINT_WORKSPACE_ID ||
    "local";

  const now = new Date().toISOString();
  const connectionPath = path.join(canonicalRoot, CONNECTION_DIR_NAME, CONNECTION_FILE_NAME);
  const existing = await readJsonSafe(connectionPath, null);

  const connection = {
    folderPath: canonicalRoot,
    workspaceId: resolvedWorkspaceId,
    workspaceName: workspaceName || existing?.workspaceName || path.basename(canonicalRoot),
    include: Array.isArray(include) ? include : existing?.include || [],
    ignore: Array.isArray(ignore) ? ignore : existing?.ignore || [],
    maxFileSizeBytes:
      typeof maxFileSizeBytes === "number" && maxFileSizeBytes > 0
        ? maxFileSizeBytes
        : existing?.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES,
    connectedAt: existing?.connectedAt || now,
    updatedAt: now,
  };

  await writeJsonAtomic(connectionPath, connection);

  const registryPath = getRegistryPath(configDir);
  const registry = await readJsonSafe(registryPath, { folders: {} });
  if (!registry.folders || typeof registry.folders !== "object") {
    registry.folders = {};
  }
  registry.folders[canonicalRoot] = {
    folderPath: canonicalRoot,
    workspaceId: connection.workspaceId,
    workspaceName: connection.workspaceName,
    connectedAt: connection.connectedAt,
    updatedAt: connection.updatedAt,
  };
  await writeJsonAtomic(registryPath, registry);

  return {
    success: true,
    folder_path: canonicalRoot,
    workspace_id: connection.workspaceId,
    workspace_name: connection.workspaceName,
    config_path: connectionPath,
    message: `Connected folder '${canonicalRoot}' to workspace '${connection.workspaceId}'.`,
  };
}

/**
 * Disconnect a local folder from its Blueprint workspace.
 */
export async function disconnectFolder({ folderPath, configDir }) {
  const resolved = path.resolve(folderPath || ".");
  const canonicalRoot = await fsp.realpath(resolved).catch(() => resolved);

  const connectionPath = path.join(canonicalRoot, CONNECTION_DIR_NAME, CONNECTION_FILE_NAME);
  let removedLocal = false;
  try {
    await fsp.unlink(connectionPath);
    removedLocal = true;
  } catch {
    // Ignore if already removed
  }

  const registryPath = getRegistryPath(configDir);
  const registry = await readJsonSafe(registryPath, { folders: {} });
  let removedRegistry = false;
  if (registry.folders && registry.folders[canonicalRoot]) {
    delete registry.folders[canonicalRoot];
    removedRegistry = true;
    await writeJsonAtomic(registryPath, registry);
  }

  return {
    success: true,
    folder_path: canonicalRoot,
    disconnected: removedLocal || removedRegistry,
    message:
      removedLocal || removedRegistry
        ? `Disconnected folder '${canonicalRoot}'.`
        : `Folder '${canonicalRoot}' was not connected.`,
  };
}

/**
 * List all connected folders from the local registry.
 */
export async function listConnectedFolders({ configDir } = {}) {
  const registryPath = getRegistryPath(configDir);
  const registry = await readJsonSafe(registryPath, { folders: {} });
  const folders = [];

  for (const entry of Object.values(registry.folders || {})) {
    if (!entry || typeof entry !== "object" || !entry.folderPath) continue;
    const exists = fs.existsSync(entry.folderPath);
    const localCfg = exists
      ? await readJsonSafe(
          path.join(entry.folderPath, CONNECTION_DIR_NAME, CONNECTION_FILE_NAME),
          null
        )
      : null;
    folders.push({
      folder_path: entry.folderPath,
      workspace_id: localCfg?.workspaceId || entry.workspaceId,
      workspace_name: localCfg?.workspaceName || entry.workspaceName || path.basename(entry.folderPath),
      connected_at: entry.connectedAt,
      updated_at: localCfg?.updatedAt || entry.updatedAt,
      exists,
    });
  }

  return {
    success: true,
    count: folders.length,
    folders,
  };
}

/**
 * Resolve the connected workspace for `folderPath` (walking up parent directories).
 */
export async function resolveFolderConnection(folderPath, { configDir } = {}) {
  if (!folderPath) return null;
  let current = await resolveCanonicalDirectory(folderPath).catch(() => null);
  if (!current) return null;

  const registry = await readJsonSafe(getRegistryPath(configDir), { folders: {} });

  while (true) {
    const localCfgPath = path.join(current, CONNECTION_DIR_NAME, CONNECTION_FILE_NAME);
    const localCfg = await readJsonSafe(localCfgPath, null);
    if (localCfg && localCfg.workspaceId) {
      return localCfg;
    }
    if (registry.folders && registry.folders[current]) {
      return registry.folders[current];
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Safely scan files inside a connected folder, enforcing root containment,
 * secret exclusions, `.gitignore` / `.bknignore`, binary detection, and size caps.
 */
export async function scanFolderFiles(
  folderPath,
  { include = [], ignore = [], maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES } = {}
) {
  const canonicalRoot = await resolveCanonicalDirectory(folderPath);
  const gitignorePatterns = await readIgnoreFile(path.join(canonicalRoot, ".gitignore"));
  const bknignorePatterns = await readIgnoreFile(path.join(canonicalRoot, ".bknignore"));

  const ignoreMatchers = compilePatternList([
    ...gitignorePatterns,
    ...bknignorePatterns,
    ...(Array.isArray(ignore) ? ignore : []),
  ]);
  const includeMatchers = compilePatternList(Array.isArray(include) ? include : []);

  const discovered = [];
  const skipped = [];

  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      let realEntryPath;
      try {
        realEntryPath = await fsp.realpath(fullPath);
      } catch {
        continue;
      }

      // Prevent symlink escapes outside the connected root
      if (
        realEntryPath !== canonicalRoot &&
        !realEntryPath.startsWith(canonicalRoot + path.sep)
      ) {
        skipped.push({ path: toPosixPath(path.relative(canonicalRoot, fullPath)), reason: "outside_root" });
        continue;
      }

      const relPosix = toPosixPath(path.relative(canonicalRoot, realEntryPath));
      if (!relPosix) continue;

      if (isSecretOrDefaultIgnored(relPosix)) {
        continue;
      }
      if (ignoreMatchers.some((m) => m.regex.test(relPosix))) {
        continue;
      }

      const stat = await fsp.stat(realEntryPath).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory()) {
        await walk(realEntryPath);
        continue;
      }
      if (!stat.isFile()) continue;

      if (includeMatchers.length > 0 && !includeMatchers.some((m) => m.regex.test(relPosix))) {
        continue;
      }

      if (stat.size > maxFileSizeBytes) {
        skipped.push({ path: relPosix, reason: "exceeds_max_size", size_bytes: stat.size });
        continue;
      }

      const buf = await fsp.readFile(realEntryPath);
      if (isBinaryBuffer(buf)) {
        skipped.push({ path: relPosix, reason: "binary_file" });
        continue;
      }

      const content = buf.toString("utf8");
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      discovered.push({
        path: relPosix,
        content,
        language: inferLanguage(relPosix),
        sizeBytes: buf.length,
        sha256,
      });
    }
  }

  await walk(canonicalRoot);
  return { canonicalRoot, files: discovered, skipped };
}

/**
 * Incrementally sync files from a local folder into a Blueprint workspace using `writeFileFn`.
 */
export async function syncFolderToWorkspace({
  folderPath,
  workspaceId,
  dryRun = false,
  force = false,
  include,
  ignore,
  maxFileSizeBytes,
  writeFileFn,
  configDir,
}) {
  if (typeof writeFileFn !== "function") {
    throw new Error("writeFileFn is required to sync files to a workspace.");
  }

  const canonicalRoot = await resolveCanonicalDirectory(folderPath);
  const connection = await resolveFolderConnection(canonicalRoot, { configDir });
  const targetWorkspaceId =
    (typeof workspaceId === "string" && workspaceId.trim()) ||
    connection?.workspaceId ||
    process.env.BLUEPRINT_WORKSPACE_ID ||
    "local";

  const effectiveInclude = include ?? connection?.include ?? [];
  const effectiveIgnore = ignore ?? connection?.ignore ?? [];
  const effectiveMaxSize =
    maxFileSizeBytes ?? connection?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  const { files, skipped } = await scanFolderFiles(canonicalRoot, {
    include: effectiveInclude,
    ignore: effectiveIgnore,
    maxFileSizeBytes: effectiveMaxSize,
  });

  const syncStatePath = path.join(canonicalRoot, CONNECTION_DIR_NAME, SYNC_STATE_FILE_NAME);
  const prevState = await readJsonSafe(syncStatePath, { files: {} });
  const prevFiles = prevState.files || {};
  const nextFiles = { ...prevFiles };

  const syncedFiles = [];
  const unchangedFiles = [];
  const errors = [];

  for (const file of files) {
    const previous = prevFiles[file.path];
    if (!force && previous && previous.sha256 === file.sha256) {
      unchangedFiles.push(file.path);
      continue;
    }

    if (dryRun) {
      syncedFiles.push({ path: file.path, language: file.language, size_bytes: file.sizeBytes, dry_run: true });
      continue;
    }

    try {
      await writeFileFn({
        path: file.path,
        content: file.content,
        language: file.language,
        workspace_id: targetWorkspaceId,
      });
      nextFiles[file.path] = {
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        syncedAt: new Date().toISOString(),
      };
      syncedFiles.push({ path: file.path, language: file.language, size_bytes: file.sizeBytes });
    } catch (err) {
      errors.push({ path: file.path, error: err?.message || String(err) });
    }
  }

  if (!dryRun && syncedFiles.length > 0) {
    await writeJsonAtomic(syncStatePath, {
      workspaceId: targetWorkspaceId,
      updatedAt: new Date().toISOString(),
      files: nextFiles,
    });
  }

  return {
    success: errors.length === 0,
    folder_path: canonicalRoot,
    workspace_id: targetWorkspaceId,
    dry_run: Boolean(dryRun),
    total_scanned: files.length,
    synced_count: syncedFiles.length,
    skipped_count: unchangedFiles.length + skipped.length,
    failed_count: errors.length,
    synced_files: syncedFiles,
    unchanged_count: unchangedFiles.length,
    ignored_or_skipped: skipped,
    errors,
  };
}
