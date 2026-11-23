/**
 * GENERATED FILE — do not edit.
 *
 * Source: packages/shared/src/lib/bkn-local-store.ts
 * Regenerate: npm run generate:local-store --workspace @blueprint-nexus/mcp-server
 */
/**
 * Local `.bkn` filesystem adapter.
 *
 * `.bkn/` has exactly one on-disk format: the Portable Knowledge Graph defined
 * in `graph-format.ts` and written by `scripts/bkn-graph.ts`. This module is the
 * *editor* for that format — the MCP `--local` server, the workstation sandbox
 * sync, and the workspace sync route all read and write the same files the CLI
 * exports, so a committed directory and a locally edited one are the same
 * artifact and `bkn-graph plan` can gate either.
 *
 * Layout:
 *
 *   .bkn/graph.yaml        portable envelope (format version, workspace, counts)
 *   .bkn/nodes/<key>.yaml  one node per file, outbound edges inline
 *   .bkn/config.json       workspace binding for this checkout (local metadata)
 *   .bkn/context.md        advisory workspace context (not graph data)
 *
 * `LocalBKNNode` keeps the display-oriented field names (`id`, `title`,
 * `content`) that the MCP tools and the sync routes speak; they map onto the
 * portable fields (`key`, `name`, `description`) on the way in and out.
 * `confidence` and `tags` have no portable field of their own, so they ride in
 * node `properties` — which is where the canonical graph keeps everything that
 * is not one of the nine portable attributes.
 *
 * Node files are byte-stable: re-saving an unchanged node produces the same
 * bytes the CLI export wrote, so ordinary edits show up in `git diff` as the
 * field that changed and nothing else.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { NODES_DIR, PORTABLE_GRAPH_META_FILE, PORTABLE_GRAPH_VERSION, PortableNodeSchema, canonicalizeValue, } from "./graph-format.generated.js";
/** Portable-node property keys that `LocalBKNNode` exposes as fields. */
const TAGS_PROPERTY = "tags";
const CONFIDENCE_PROPERTY = "confidence";
/** Name used for `.bkn/graph.yaml` when no `config.json` names the workspace. */
const DEFAULT_WORKSPACE_NAME = "Local Workspace";
/** Keys are lowercase alphanumerics with `.`, `_` or `-`, capped at 72 chars. */
const MAX_KEY_LENGTH = 72;
const NODE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const NODE_FILE_PATTERN = /\.ya?ml$/;
function dumpYaml(value) {
    // Matches `graph-format.ts` so a store write and a CLI export of the same
    // node are byte-identical.
    return stringifyYaml(value, { lineWidth: 0 });
}
export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
/**
 * Normalizes any id or title into a portable node key. An input that is
 * already a valid key is returned untouched: keys are identity, so a pinned
 * `graph_key` containing `.` or `_` must not be re-slugged into a different
 * node.
 */
export function toNodeKey(input) {
    const raw = String(input ?? "");
    if (raw.length > 0 && raw.length <= MAX_KEY_LENGTH && NODE_KEY_PATTERN.test(raw))
        return raw;
    const slug = slugify(raw)
        .slice(0, MAX_KEY_LENGTH)
        .replace(/[-._]+$/, "");
    return slug || "node";
}
export function nodeFilePath(key) {
    return `${NODES_DIR}/${key}.yaml`;
}
/** Deterministic edge id, matching the shape the previous store defaulted to. */
export function edgeId(source, target, type) {
    return `edge-${source}-${target}-${type}`;
}
function edgeRefFromEdge(edge) {
    const ref = { type: edge.type, to: toNodeKey(edge.target) };
    const weight = edge.properties?.weight;
    if (typeof weight === "number")
        ref.weight = weight;
    const note = edge.properties?.note;
    if (typeof note === "string" && note.trim())
        ref.note = note.trim();
    return ref;
}
function edgeFromRef(source, ref) {
    const properties = {};
    if (typeof ref.weight === "number")
        properties.weight = ref.weight;
    if (typeof ref.note === "string")
        properties.note = ref.note;
    return {
        id: edgeId(source, ref.to, ref.type),
        source,
        target: ref.to,
        type: ref.type,
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
    };
}
function portableToLocal(node) {
    const properties = { ...(node.properties ?? {}) };
    const tags = properties[TAGS_PROPERTY];
    const confidence = properties[CONFIDENCE_PROPERTY];
    delete properties[TAGS_PROPERTY];
    delete properties[CONFIDENCE_PROPERTY];
    return {
        id: node.key,
        label: node.label,
        title: node.name,
        status: node.status,
        confidence: typeof confidence === "number" ? confidence : undefined,
        tags: Array.isArray(tags) ? tags.map(String) : [],
        content: node.description ?? "",
        properties: Object.keys(properties).length > 0 ? properties : undefined,
    };
}
function localToPortable(node, edges) {
    const key = toNodeKey(node.id || node.title);
    const properties = { ...(node.properties ?? {}) };
    if (node.tags && node.tags.length > 0)
        properties[TAGS_PROPERTY] = node.tags;
    if (typeof node.confidence === "number")
        properties[CONFIDENCE_PROPERTY] = node.confidence;
    const description = node.content?.trim();
    const portable = {
        key,
        label: node.label,
        name: node.title?.trim() || key,
        ...(description ? { description } : {}),
        ...(node.status ? { status: node.status } : {}),
        ...(Object.keys(properties).length > 0
            ? { properties: canonicalizeValue(properties) }
            : {}),
        ...(edges.length > 0 ? { edges } : {}),
    };
    return portable;
}
/**
 * Parses a portable node file. Structural problems are thrown rather than
 * repaired: a half-understood node silently overwriting a good one is worse
 * than a refused read, and callers that walk a directory report the file.
 */
export function parseNodeDocument(fileContent, defaultKey) {
    let raw;
    try {
        raw = parseYaml(fileContent);
    }
    catch (error) {
        throw new Error(`invalid YAML (${error.message})`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("expected a YAML mapping with key, label and name");
    }
    const document = raw;
    const candidate = {
        ...document,
        key: document.key ?? defaultKey,
        name: document.name ?? document.key ?? defaultKey,
    };
    const result = PortableNodeSchema.safeParse(candidate);
    if (!result.success) {
        throw new Error(result.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; "));
    }
    return {
        node: portableToLocal(result.data),
        edges: result.data.edges ?? [],
    };
}
/** Convenience wrapper when only the node matters. */
export function parseNodeFile(fileContent, defaultKey) {
    return parseNodeDocument(fileContent, defaultKey).node;
}
/**
 * Serializes a node (and its outbound edges) into portable YAML. Edges are
 * inline on the source node, so callers rewriting a node must pass the edges
 * they mean to keep — omitting them unlinks the node.
 */
export function serializeNodeFile(node, edges = []) {
    const portable = localToPortable(node, edges);
    const validated = PortableNodeSchema.safeParse(portable);
    if (!validated.success) {
        throw new Error(`Cannot write node "${node.id}": ` +
            validated.error.issues
                .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
                .join("; "));
    }
    return dumpYaml(validated.data);
}
/**
 * Node.js filesystem implementation of LocalBKNStore.
 * Operates directly on the `.bkn/` directory on disk.
 */
export class LocalBKNStore {
    baseDir;
    nodesDir;
    graphMetaPath;
    contextPath;
    configPath;
    constructor(baseDir = ".bkn") {
        // Standardize path without trailing slash
        this.baseDir = baseDir.replace(/\/+$/, "");
        this.nodesDir = `${this.baseDir}/${NODES_DIR}`;
        this.graphMetaPath = `${this.baseDir}/${PORTABLE_GRAPH_META_FILE}`;
        this.contextPath = `${this.baseDir}/context.md`;
        this.configPath = `${this.baseDir}/config.json`;
    }
    async getFs() {
        return await import("node:fs/promises");
    }
    async readConfig() {
        const fs = await this.getFs();
        try {
            const raw = await fs.readFile(this.configPath, "utf8");
            const parsed = JSON.parse(raw);
            return {
                workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : undefined,
                workspaceName: typeof parsed.workspaceName === "string" ? parsed.workspaceName : undefined,
            };
        }
        catch {
            return null;
        }
    }
    async nodeFileKeys() {
        const fs = await this.getFs();
        let entries;
        try {
            entries = await fs.readdir(this.nodesDir, { withFileTypes: true });
        }
        catch (error) {
            // No checkout here is an empty graph, not an error — and reading it must
            // not create one.
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
        return entries
            .filter((entry) => entry.isFile() && NODE_FILE_PATTERN.test(entry.name))
            .map((entry) => entry.name.replace(NODE_FILE_PATTERN, ""))
            .sort();
    }
    async readNodeDocument(key) {
        const fs = await this.getFs();
        try {
            const raw = await fs.readFile(`${this.nodesDir}/${key}.yaml`, "utf8");
            return parseNodeDocument(raw, key);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    async writeNodeDocument(key, node, edges) {
        const fs = await this.getFs();
        await fs.mkdir(this.nodesDir, { recursive: true });
        await fs.writeFile(`${this.nodesDir}/${key}.yaml`, serializeNodeFile(node, edges), "utf8");
    }
    async ensureDirectories() {
        const fs = await this.getFs();
        await fs.mkdir(this.nodesDir, { recursive: true });
        // Initialize graph.yaml if it doesn't exist, using the workspace binding
        // recorded in config.json so the envelope names the right workspace.
        try {
            await fs.access(this.graphMetaPath);
        }
        catch {
            const config = await this.readConfig();
            const meta = {
                bkn_version: PORTABLE_GRAPH_VERSION,
                workspace: config?.workspaceName || DEFAULT_WORKSPACE_NAME,
                ...(config?.workspaceId ? { blueprint_id: config.workspaceId } : {}),
            };
            await fs.writeFile(this.graphMetaPath, dumpYaml(meta), "utf8");
        }
    }
    async listNodes() {
        const fs = await this.getFs();
        const nodes = [];
        for (const key of await this.nodeFileKeys()) {
            const raw = await fs.readFile(`${this.nodesDir}/${key}.yaml`, "utf8");
            try {
                nodes.push(parseNodeFile(raw, key));
            }
            catch (error) {
                // One malformed file must not hide the rest of the graph, but it must
                // not pass silently either.
                console.warn(`[LocalBKNStore] Skipped ${key}.yaml: ${error.message}`);
            }
        }
        return nodes;
    }
    async getNode(id) {
        const key = toNodeKey(id);
        const document = await this.readNodeDocument(key);
        return document?.node ?? null;
    }
    async saveNode(node) {
        await this.ensureDirectories();
        const key = toNodeKey(node.id || node.title || "node");
        // Edges live inside the node file; rewriting a node without them would
        // silently drop every link it owns.
        const existing = await this.readNodeDocument(key);
        const updatedNode = {
            ...node,
            id: key,
            updated_at: new Date().toISOString(),
        };
        await this.writeNodeDocument(key, updatedNode, existing?.edges ?? []);
        return updatedNode;
    }
    /**
     * Removes a node file and every edge that pointed at it. The portable form
     * rejects dangling edges, so inbound links are stripped from their sources
     * rather than left to fail the next parse.
     */
    async deleteNode(id) {
        const fs = await this.getFs();
        const key = toNodeKey(id);
        try {
            await fs.unlink(`${this.nodesDir}/${key}.yaml`);
        }
        catch {
            return false;
        }
        for (const otherKey of await this.nodeFileKeys()) {
            try {
                const document = await this.readNodeDocument(otherKey);
                if (!document)
                    continue;
                const kept = document.edges.filter((edge) => edge.to !== key);
                if (kept.length !== document.edges.length) {
                    await this.writeNodeDocument(otherKey, document.node, kept);
                }
            }
            catch (error) {
                console.warn(`[LocalBKNStore] Could not unlink "${key}" from ${otherKey}.yaml: ${error.message}`);
            }
        }
        return true;
    }
    /** Synthesized index over the files; there is no separate graph.json. */
    async readGraphIndex() {
        const config = await this.readConfig();
        return {
            version: PORTABLE_GRAPH_VERSION,
            workspace_id: config?.workspaceId,
            workspace_name: config?.workspaceName,
            edges: await this.listEdges(),
            layout: {},
            updated_at: new Date().toISOString(),
        };
    }
    /**
     * The whole directory as one portable graph, for callers that apply it
     * (plan/apply) rather than read it node by node.
     *
     * `hasMeta` reports whether `graph.yaml` exists. Callers pass it as the
     * completeness signal for pruning: a `nodes/` directory without its envelope
     * is a partial checkout (a failed sync, a hand-copied subset), and deleting
     * everything absent from a partial checkout is how a workspace disappears.
     */
    async exportPortableGraph() {
        const [nodes, edges, index] = await Promise.all([
            this.listNodes(),
            this.listEdges(),
            this.readGraphIndex(),
        ]);
        const outbound = new Map();
        for (const edge of edges) {
            const weight = edge.properties?.weight;
            const note = edge.properties?.note;
            const ref = {
                type: edge.type,
                to: edge.target,
                ...(typeof weight === "number" ? { weight } : {}),
                ...(typeof note === "string" && note ? { note } : {}),
            };
            const list = outbound.get(edge.source) ?? [];
            list.push(ref);
            outbound.set(edge.source, list);
        }
        const portableNodes = nodes
            .map((node) => localToPortable(node, outbound.get(node.id) ?? []))
            .sort((a, b) => a.key.localeCompare(b.key));
        let hasMeta = true;
        try {
            const fs = await this.getFs();
            await fs.access(this.graphMetaPath);
        }
        catch {
            hasMeta = false;
        }
        return {
            graph: {
                meta: {
                    bkn_version: PORTABLE_GRAPH_VERSION,
                    workspace: index.workspace_name || DEFAULT_WORKSPACE_NAME,
                    ...(index.workspace_id ? { blueprint_id: index.workspace_id } : {}),
                    node_count: portableNodes.length,
                    edge_count: portableNodes.reduce((total, node) => total + (node.edges?.length ?? 0), 0),
                },
                nodes: portableNodes,
            },
            hasMeta,
        };
    }
    async listEdges() {
        const edges = [];
        for (const key of await this.nodeFileKeys()) {
            const document = await this.readNodeDocument(key);
            if (!document)
                continue;
            for (const ref of document.edges)
                edges.push(edgeFromRef(key, ref));
        }
        return edges;
    }
    async saveEdge(edge) {
        await this.ensureDirectories();
        const source = toNodeKey(edge.source);
        const target = toNodeKey(edge.target);
        const sourceDocument = await this.readNodeDocument(source);
        if (!sourceDocument) {
            throw new Error(`Cannot link: source node "${edge.source}" has no file in ${this.nodesDir}.`);
        }
        if (!(await this.readNodeDocument(target))) {
            throw new Error(`Cannot link: target node "${edge.target}" has no file in ${this.nodesDir}.`);
        }
        const ref = edgeRefFromEdge(edge);
        const kept = sourceDocument.edges.filter((existing) => !(existing.type === ref.type && existing.to === ref.to));
        await this.writeNodeDocument(source, sourceDocument.node, [...kept, ref]);
        // Edge ids are derived, not stored: the portable form keys an edge by
        // (source, type, target), so a caller-supplied id could never round-trip.
        return {
            ...edge,
            id: edgeId(source, target, edge.type),
            source,
            target,
        };
    }
    async deleteEdge(id) {
        await this.ensureDirectories();
        for (const key of await this.nodeFileKeys()) {
            const document = await this.readNodeDocument(key);
            if (!document)
                continue;
            const kept = document.edges.filter((ref) => edgeId(key, ref.to, ref.type) !== id);
            if (kept.length !== document.edges.length) {
                await this.writeNodeDocument(key, document.node, kept);
                return true;
            }
        }
        return false;
    }
    async queryGraph(query, label, limit = 50) {
        const allNodes = await this.listNodes();
        const allEdges = await this.listEdges();
        let matched = allNodes;
        if (label) {
            const targetLabel = label.toLowerCase();
            matched = matched.filter((n) => n.label.toLowerCase() === targetLabel);
        }
        if (query && query.trim()) {
            const q = query.toLowerCase().trim();
            matched = matched.filter((n) => n.title.toLowerCase().includes(q) ||
                n.content.toLowerCase().includes(q) ||
                (n.tags && n.tags.some((t) => t.toLowerCase().includes(q))));
        }
        const slicedNodes = matched.slice(0, limit);
        const nodeIds = new Set(slicedNodes.map((n) => n.id));
        // Return edges connecting the matched nodes
        const relatedEdges = allEdges.filter((e) => nodeIds.has(e.source) || nodeIds.has(e.target));
        return {
            nodes: slicedNodes,
            edges: relatedEdges,
        };
    }
    async getWorkspaceContext() {
        const fs = await this.getFs();
        try {
            const content = await fs.readFile(this.contextPath, "utf8");
            return content;
        }
        catch {
            // Fallback: auto-generate context from top nodes
            const nodes = await this.listNodes();
            const summary = nodes
                .slice(0, 10)
                .map((n) => `- **[${n.label}] ${n.title}**: ${n.content.slice(0, 120).replace(/\n/g, " ")}...`)
                .join("\n");
            return `# Local Blueprint Workspace Context\n\n## Key Architectural Nodes\n${summary || "No nodes indexed yet."}\n`;
        }
    }
}
