/**
 * GENERATED FILE — do not edit.
 *
 * Source: packages/shared/src/lib/graph-format.ts
 * Regenerate: npm run generate:local-store --workspace @blueprint-nexus/mcp-server
 */
/**
 * Portable Knowledge Graph Format (`.bkn/`)
 *
 * The database stays canonical. This module projects a workspace graph into a
 * deterministic text directory that can be committed to git, reviewed as a
 * diff, copied between workspaces, or edited by an agent with ordinary file
 * tools, then reconciled back with an explicit plan/apply step.
 *
 * Layout (all paths relative to the graph directory):
 *
 *   .bkn/graph.yaml        → metadata envelope (version, workspace, counts)
 *   .bkn/nodes/<key>.yaml  → one durable node per file, outbound edges inline
 *
 * Design rules:
 *  - Node identity is `key`, never `uuid`. `uuid` is instance-local and must
 *    not leak into the portable form, or copies of a graph fork on import.
 *  - Derived state (embeddings, mastery, confidence, reinforcement counters,
 *    timestamps in the future) never round-trips; it is recomputed locally.
 *  - Outbound edges live on the source node so a rename of a target touches
 *    only the files that actually reference it.
 *  - Output is byte-stable for identical input: nodes sorted by key, edges
 *    sorted by (type, target), property keys sorted recursively. Re-exporting
 *    an unchanged graph produces an empty git diff, which is what makes the
 *    directory usable as version control.
 */
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
export const PORTABLE_GRAPH_VERSION = 1;
export const PORTABLE_GRAPH_DIR = ".bkn";
export const PORTABLE_GRAPH_META_FILE = "graph.yaml";
export const NODES_DIR = "nodes";
/** Property bag key that pins a node's portable identity in the database. */
export const GRAPH_KEY_PROPERTY = "graph_key";
/** Edge weight written to the database when the portable form omits one. */
export const DEFAULT_EDGE_WEIGHT = 1;
/** Node columns that are derived or instance-local and never serialized. */
export const DERIVED_NODE_FIELDS = [
    "uuid",
    "blueprint_id",
    "embedding",
    "current_mastery",
    "confidence",
    "last_active",
    "last_validated_at",
    "created_at",
    "reinforcement_count",
    "is_provisional",
    "child_count",
    "significance_score",
    "resolution_tier",
    "source_type",
    "created_by",
    "context_snapshot",
];
const MAX_KEY_LENGTH = 72;
const NODE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────
export const PortableEdgeRefSchema = z.object({
    type: z.string().min(1),
    to: z.string().min(1),
    weight: z.number().optional(),
    note: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
});
export const PortableNodeSchema = z.object({
    key: z
        .string()
        .min(1)
        .max(MAX_KEY_LENGTH)
        .regex(NODE_KEY_PATTERN, "keys are lowercase alphanumerics with . _ or -"),
    label: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.string().optional(),
    parent: z.string().optional(),
    domain: z.string().optional(),
    assignee: z.string().optional(),
    archived: z.boolean().optional(),
    properties: z.record(z.unknown()).optional(),
    edges: z.array(PortableEdgeRefSchema).optional(),
});
export const PortableGraphMetaSchema = z.object({
    bkn_version: z.number().int().positive(),
    workspace: z.string().min(1),
    blueprint_id: z.string().optional(),
    exported_at: z.string().optional(),
    node_count: z.number().int().nonnegative().optional(),
    edge_count: z.number().int().nonnegative().optional(),
});
export const PortableGraphSchema = z.object({
    meta: PortableGraphMetaSchema,
    nodes: z.array(PortableNodeSchema),
});
// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization helpers
// ─────────────────────────────────────────────────────────────────────────────
/** Recursively sorts object keys and drops `undefined` so dumps are byte-stable. */
export function canonicalizeValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalizeValue);
    if (value && typeof value === "object") {
        const source = value;
        const out = {};
        for (const key of Object.keys(source).sort()) {
            const next = canonicalizeValue(source[key]);
            if (next !== undefined)
                out[key] = next;
        }
        return out;
    }
    return value;
}
/** Deterministic slug used when a node has no pinned `graph_key`. */
export function slugifyGraphKey(input) {
    const slug = String(input ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_KEY_LENGTH)
        .replace(/-+$/g, "");
    return slug;
}
/**
 * Node identity resolution order: pinned `properties.graph_key` first, then a
 * slug of the display name, then a uuid-derived last resort. A pinned key
 * survives renames; a slug-derived key does not, which is why `apply` writes
 * the resolved key back into the database.
 */
export function deriveNodeKey(node) {
    const pinned = node.properties?.[GRAPH_KEY_PROPERTY];
    if (typeof pinned === "string" && NODE_KEY_PATTERN.test(pinned))
        return pinned;
    const slug = slugifyGraphKey(node.name ?? "");
    if (slug)
        return slug;
    const suffix = typeof node.uuid === "string" ? node.uuid.replace(/-/g, "").slice(0, 8) : "00000000";
    return `node-${suffix}`;
}
/**
 * Maps `uuid → key` for a node set, disambiguating slug collisions with a
 * numeric suffix. Order is deterministic (name, then uuid) so two exports of
 * the same graph always agree on who gets the bare slug.
 */
export function resolveNodeKeys(nodes) {
    const keys = new Map();
    const taken = new Map();
    const warnings = [];
    const ordered = [...nodes].sort((a, b) => {
        const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
        return byName !== 0 ? byName : String(a.uuid).localeCompare(String(b.uuid));
    });
    for (const node of ordered) {
        const base = deriveNodeKey(node);
        let candidate = base;
        let counter = 2;
        while (taken.has(candidate)) {
            const suffix = `-${counter}`;
            candidate = `${base.slice(0, MAX_KEY_LENGTH - suffix.length)}${suffix}`;
            counter += 1;
        }
        if (candidate !== base) {
            warnings.push(`Key collision on "${base}": "${node.name}" stored as "${candidate}".`);
        }
        taken.set(candidate, node.uuid);
        keys.set(node.uuid, candidate);
    }
    return { keys, warnings };
}
function normalizeWeight(weight) {
    const numeric = typeof weight === "number" ? weight : Number(weight);
    if (!Number.isFinite(numeric))
        return undefined;
    return numeric === DEFAULT_EDGE_WEIGHT ? undefined : numeric;
}
function stripEmpty(value) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || entry === null)
            continue;
        if (typeof entry === "string" && entry.trim() === "")
            continue;
        out[key] = entry;
    }
    return out;
}
function dumpYaml(value) {
    return stringifyYaml(value, { lineWidth: 0 });
}
export function serializeGraph(nodes, edges, options) {
    const dir = options.dir ?? PORTABLE_GRAPH_DIR;
    const { keys, warnings } = resolveNodeKeys(nodes);
    const byUuid = new Map();
    for (const node of nodes)
        byUuid.set(node.uuid, node);
    const outbound = new Map();
    for (const edge of edges) {
        const sourceKey = keys.get(edge.source_uuid);
        const targetKey = keys.get(edge.target_uuid);
        if (!sourceKey || !targetKey) {
            warnings.push(`Dropped edge "${edge.type}" — endpoint outside this graph (${edge.source_uuid} → ${edge.target_uuid}).`);
            continue;
        }
        const edgeProps = edge.properties
            ? canonicalizeValue(Object.fromEntries(Object.entries(edge.properties).filter(([k]) => k !== "is_provisional" &&
                k !== "sandbox_id" &&
                k !== "last_triggered_at" &&
                k !== "source_snippet")))
            : {};
        const ref = stripEmpty({
            type: String(edge.type ?? "").trim(),
            to: targetKey,
            weight: normalizeWeight(edge.weight),
            note: edge.source_snippet?.trim() || undefined,
            properties: Object.keys(edgeProps).length > 0 ? edgeProps : undefined,
        });
        if (!ref.type)
            continue;
        const list = outbound.get(edge.source_uuid) ?? [];
        list.push(ref);
        outbound.set(edge.source_uuid, list);
    }
    const portableNodes = [];
    for (const node of nodes) {
        const key = keys.get(node.uuid);
        if (!key)
            continue;
        const properties = canonicalizeValue(Object.fromEntries(Object.entries(node.properties ?? {}).filter(([property]) => property !== GRAPH_KEY_PROPERTY && property !== "embedding")));
        const refs = (outbound.get(node.uuid) ?? []).sort((a, b) => {
            const byType = a.type.localeCompare(b.type);
            return byType !== 0 ? byType : a.to.localeCompare(b.to);
        });
        portableNodes.push(stripEmpty({
            key,
            label: node.label,
            name: node.name,
            // Trailing whitespace would otherwise churn every diff.
            description: node.description?.replace(/\s+$/, "") || undefined,
            status: node.status || undefined,
            parent: node.parent_uuid ? keys.get(node.parent_uuid) : undefined,
            domain: node.domain_namespace || undefined,
            assignee: node.assignee || undefined,
            archived: node.is_archived ? true : undefined,
            properties: Object.keys(properties).length > 0 ? properties : undefined,
            edges: refs.length > 0 ? refs : undefined,
        }));
    }
    portableNodes.sort((a, b) => a.key.localeCompare(b.key));
    const graph = {
        meta: stripEmpty({
            bkn_version: PORTABLE_GRAPH_VERSION,
            workspace: options.workspace,
            blueprint_id: options.blueprintId,
            exported_at: options.exportedAt,
            node_count: portableNodes.length,
            edge_count: portableNodes.reduce((total, node) => total + (node.edges?.length ?? 0), 0),
        }),
        nodes: portableNodes,
    };
    const files = [
        { path: `${dir}/${PORTABLE_GRAPH_META_FILE}`, content: dumpYaml(graph.meta) },
        ...portableNodes.map((node) => ({
            path: `${dir}/${NODES_DIR}/${node.key}.yaml`,
            content: dumpYaml(node),
        })),
    ];
    return { graph, files, warnings };
}
function normalizeFileEntries(files) {
    const entries = Array.isArray(files)
        ? files.map((file) => ({ path: file.path, content: file.content }))
        : Object.entries(files).map(([path, content]) => ({ path, content }));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
}
/**
 * Reads a `.bkn` directory back into a validated portable graph. Structural
 * problems (bad version, duplicate keys, dangling edges) are reported as
 * errors rather than repaired: a silently lossy import is worse than none.
 */
export function parsePortableGraph(files) {
    const errors = [];
    const warnings = [];
    const entries = normalizeFileEntries(files);
    const nodes = [];
    const seen = new Map();
    let meta;
    for (const entry of entries) {
        const base = entry.path.split("/").pop() ?? entry.path;
        if (!base.endsWith(".yaml") && !base.endsWith(".yml")) {
            warnings.push(`Ignored non-YAML file "${entry.path}".`);
            continue;
        }
        let parsed;
        try {
            parsed = parseYaml(entry.content);
        }
        catch (error) {
            errors.push(`"${entry.path}": invalid YAML (${error.message}).`);
            continue;
        }
        const isNodeFile = /(^|\/)nodes\//.test(entry.path);
        if (!isNodeFile) {
            const result = PortableGraphMetaSchema.safeParse(parsed);
            if (!result.success) {
                errors.push(`"${entry.path}": ${formatIssues(result.error)}`);
                continue;
            }
            if (result.data.bkn_version !== PORTABLE_GRAPH_VERSION) {
                errors.push(`"${entry.path}": unsupported bkn_version ${result.data.bkn_version} (this build reads ${PORTABLE_GRAPH_VERSION}).`);
                continue;
            }
            if (meta) {
                warnings.push(`Multiple graph envelopes found; using "${entry.path}".`);
                continue;
            }
            meta = result.data;
            continue;
        }
        const result = PortableNodeSchema.safeParse(parsed);
        if (!result.success) {
            errors.push(`"${entry.path}": ${formatIssues(result.error)}`);
            continue;
        }
        const node = result.data;
        const existing = seen.get(node.key);
        if (existing) {
            errors.push(`Duplicate node key "${node.key}" in "${entry.path}" and "${existing}".`);
            continue;
        }
        seen.set(node.key, entry.path);
        nodes.push(node);
    }
    if (!meta) {
        errors.push(`Missing graph envelope "${PORTABLE_GRAPH_META_FILE}".`);
        meta = { bkn_version: PORTABLE_GRAPH_VERSION, workspace: "unknown" };
    }
    nodes.sort((a, b) => a.key.localeCompare(b.key));
    const keys = new Set(nodes.map((node) => node.key));
    for (const node of nodes) {
        if (node.parent && !keys.has(node.parent)) {
            errors.push(`Node "${node.key}" has unknown parent "${node.parent}".`);
        }
        for (const edge of node.edges ?? []) {
            if (!keys.has(edge.to)) {
                errors.push(`Node "${node.key}" points at unknown node "${edge.to}" via "${edge.type}".`);
            }
            if (edge.to === node.key) {
                errors.push(`Node "${node.key}" links to itself via "${edge.type}".`);
            }
        }
    }
    const edgeCount = nodes.reduce((total, node) => total + (node.edges?.length ?? 0), 0);
    if (meta.node_count !== undefined && meta.node_count !== nodes.length) {
        warnings.push(`Envelope claims ${meta.node_count} nodes, found ${nodes.length}.`);
    }
    if (meta.edge_count !== undefined && meta.edge_count !== edgeCount) {
        warnings.push(`Envelope claims ${meta.edge_count} edges, found ${edgeCount}.`);
    }
    return {
        graph: { meta, nodes },
        errors,
        warnings,
        fileCount: entries.length,
    };
}
function formatIssues(error) {
    return error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
}
/** Edges are keyed `from|type|to`; BKN edges carry no primary key of their own. */
export function edgeIdentity(edge) {
    return `${edge.from}|${String(edge.type).toLowerCase()}|${edge.to}`;
}
function flattenEdges(graph) {
    const map = new Map();
    for (const node of graph.nodes) {
        for (const edge of node.edges ?? []) {
            const identity = edgeIdentity({ from: node.key, type: edge.type, to: edge.to });
            map.set(identity, { kind: "add", from: node.key, type: edge.type, to: edge.to });
        }
    }
    return map;
}
const COMPARED_NODE_FIELDS = [
    "label",
    "name",
    "description",
    "status",
    "parent",
    "domain",
    "assignee",
    "archived",
    "properties",
];
function stableString(value) {
    return JSON.stringify(canonicalizeValue(value) ?? null);
}
export function planGraphChanges(current, incoming, options = {}) {
    const warnings = [];
    const currentByKey = new Map(current.nodes.map((node) => [node.key, node]));
    const incomingByKey = new Map(incoming.nodes.map((node) => [node.key, node]));
    const nodeChanges = [];
    let unchanged = 0;
    for (const node of incoming.nodes) {
        const existing = currentByKey.get(node.key);
        if (!existing) {
            nodeChanges.push({
                key: node.key,
                kind: "create",
                name: node.name,
                changes: COMPARED_NODE_FIELDS.map((field) => ({ field, before: undefined, after: node[field] })),
            });
            continue;
        }
        const changes = [];
        for (const field of COMPARED_NODE_FIELDS) {
            if (stableString(existing[field]) !== stableString(node[field])) {
                changes.push({ field, before: existing[field], after: node[field] });
            }
        }
        if (changes.length > 0) {
            nodeChanges.push({ key: node.key, kind: "update", name: node.name, changes });
        }
        else {
            unchanged += 1;
        }
    }
    for (const node of current.nodes) {
        if (incomingByKey.has(node.key))
            continue;
        if (!options.pruneMissing) {
            warnings.push(`Node "${node.key}" is absent from the files and was left untouched.`);
            continue;
        }
        nodeChanges.push({ key: node.key, kind: "delete", name: node.name, changes: [] });
    }
    const currentEdges = flattenEdges(current);
    const incomingEdges = flattenEdges(incoming);
    const edgeChanges = [];
    for (const [identity, edge] of incomingEdges) {
        if (!currentEdges.has(identity))
            edgeChanges.push({ ...edge, kind: "add" });
    }
    for (const [identity, edge] of currentEdges) {
        if (incomingEdges.has(identity))
            continue;
        // A node that is absent from the files and not being pruned is left wholly
        // alone, edges included. Only a node whose file is present can express an
        // intentional unlink by omitting one of its edges.
        if (!incomingByKey.has(edge.from))
            continue;
        edgeChanges.push({ ...edge, kind: "remove" });
    }
    edgeChanges.sort((a, b) => edgeIdentity(a).localeCompare(edgeIdentity(b)) || a.kind.localeCompare(b.kind));
    const isEmpty = nodeChanges.length === 0 && edgeChanges.length === 0;
    return { nodes: nodeChanges, edges: edgeChanges, unchanged, warnings, isEmpty };
}
/**
 * Turns a plan into a two-phase batch: nodes must exist before edges can point
 * at them, so callers upsert first, resolve keys → uuids, then link.
 */
export function planToApplyBatch(plan, incoming) {
    const incomingByKey = new Map(incoming.nodes.map((node) => [node.key, node]));
    const changed = new Set(plan.nodes.filter((node) => node.kind === "create" || node.kind === "update").map((node) => node.key));
    const upsertNodes = incoming.nodes.filter((node) => changed.has(node.key));
    const ordered = orderByParent(upsertNodes);
    const linkEdges = [];
    for (const change of plan.edges) {
        if (change.kind !== "add")
            continue;
        const source = incomingByKey.get(change.from);
        const ref = source?.edges?.find((edge) => edge.to === change.to && edgeIdentity({ from: change.from, type: edge.type, to: edge.to }) === edgeIdentity(change));
        linkEdges.push({
            from: change.from,
            type: change.type,
            to: change.to,
            weight: ref?.weight,
            note: ref?.note,
        });
    }
    return {
        upsertNodes: ordered,
        deleteNodeKeys: plan.nodes.filter((node) => node.kind === "delete").map((node) => node.key),
        linkEdges,
        unlinkEdges: plan.edges
            .filter((change) => change.kind === "remove")
            .map(({ from, type, to }) => ({ from, type, to })),
    };
}
/** Stable topological pass so `parent` targets are written before their children. */
function orderByParent(nodes) {
    const byKey = new Map(nodes.map((node) => [node.key, node]));
    const result = [];
    const placed = new Set();
    const visit = (node, trail) => {
        if (placed.has(node.key))
            return;
        if (trail.has(node.key))
            return;
        trail.add(node.key);
        const parent = node.parent ? byKey.get(node.parent) : undefined;
        if (parent)
            visit(parent, trail);
        placed.add(node.key);
        result.push(node);
    };
    for (const node of [...nodes].sort((a, b) => a.key.localeCompare(b.key))) {
        visit(node, new Set());
    }
    return result;
}
/**
 * Pins a node's portable key into its database properties so a later rename
 * does not change identity on the next export.
 */
export function withGraphKeyProperty(node) {
    return canonicalizeValue({
        ...(node.properties ?? {}),
        [GRAPH_KEY_PROPERTY]: node.key,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Human-readable diff
// ─────────────────────────────────────────────────────────────────────────────
export function formatGraphPlan(plan) {
    if (plan.isEmpty)
        return "No changes.";
    const lines = [];
    const creates = plan.nodes.filter((node) => node.kind === "create");
    const updates = plan.nodes.filter((node) => node.kind === "update");
    const deletes = plan.nodes.filter((node) => node.kind === "delete");
    const added = plan.edges.filter((edge) => edge.kind === "add");
    const removed = plan.edges.filter((edge) => edge.kind === "remove");
    lines.push(`Plan: ${creates.length} to create, ${updates.length} to update, ${deletes.length} to delete, ` +
        `${added.length} edges to add, ${removed.length} edges to remove (${plan.unchanged} unchanged).`);
    for (const node of creates)
        lines.push(`  + ${node.key}  (${node.name})`);
    for (const node of updates) {
        lines.push(`  ~ ${node.key}  (${node.name})`);
        for (const change of node.changes) {
            lines.push(`      ${change.field}: ${preview(change.before)} → ${preview(change.after)}`);
        }
    }
    for (const node of deletes)
        lines.push(`  - ${node.key}  (${node.name})`);
    for (const edge of added)
        lines.push(`  + edge ${edge.from} -[${edge.type}]-> ${edge.to}`);
    for (const edge of removed)
        lines.push(`  - edge ${edge.from} -[${edge.type}]-> ${edge.to}`);
    return lines.join("\n");
}
function preview(value) {
    if (value === undefined)
        return "∅";
    const text = typeof value === "string" ? value : JSON.stringify(canonicalizeValue(value));
    const compact = String(text ?? "").replace(/\s+/g, " ").trim();
    return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
}
