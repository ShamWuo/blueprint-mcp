export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export const MCP_TOOLS: MCPToolDefinition[] = [
  {
    name: "bkn_list_workspaces",
    description: "List all available workspaces in Blueprint Nexus with their node counts, descriptions, and modification timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of workspaces to return (default: 10)."
        }
      }
    }
  },
  {
    name: "bkn_create_workspace",
    description: "Create a new project workspace in Blueprint Nexus with automatic registration of ownership, workspace settings, documentation, and initial Knowledge Graph (BKN) nodes.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name or title of the workspace (required)."
        },
        description: {
          type: "string",
          description: "Charter, vision, or architectural summary of the workspace."
        },
        problem_statement: {
          type: "string",
          description: "Core problem or market opportunity addressed by this workspace."
        },
        target_audience: {
          type: "string",
          description: "Target user personas, market segment, or customer profiles."
        },
        technologies: {
          type: "array",
          items: { type: "string" },
          description: "Tech stack, frameworks, or tools used in this workspace."
        },
        scope: {
          type: "string",
          enum: ["small", "medium", "large"],
          description: "Estimated scope or scale (default: 'medium')."
        },
        key_features: {
          type: "array",
          items: { type: "string" },
          description: "Key product capabilities or deliverables."
        },
        work_mode: {
          type: "string",
          enum: ["solo", "team", "swarm"],
          description: "Workspace collaboration mode (default: 'solo')."
        },
        created_by: {
          type: "string",
          description: "Optional UUID of the user who owns this workspace. Defaults to API key owner or admin."
        },
        template_id: {
          type: "string",
          enum: [
            "autonomous-app-builder",
            "deep-research-synthesis",
            "founder-gtm-product-os",
            "personal-productivity-os",
            "proactive-daily-briefing",
            "normative-halo-rule-compiler",
            "verification-receipts-gate",
            "adversarial-scar-tissue-red-team",
            "outcome-weighted-salience",
            "mutation-tested-prose-contracts"
          ],
          description: "Optional starter Knowledge Graph Template ID to pre-seed architecture specs, rules, directed edges, and Cloud Sandbox verification routines."
        },
        initial_nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              metadata: { type: "object" }
            },
            required: ["name", "label"]
          },
          description: "Optional array of initial Knowledge Graph nodes to seed into the workspace BKN."
        }
      },
      required: ["name"]
    }
  },
  {
    name: "bkn_query_graph",
    description: "Search and retrieve nodes and edges from the workspace Knowledge Graph (BKN). Returns nodes, properties, and typed relationships.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description:
            "Workspace (blueprint) id to search. Defaults to BLUEPRINT_WORKSPACE_ID, then the .bkn/config.json binding, then the workspace bound to the API key; when several workspaces are visible the call fails with their names instead of guessing."
        },
        query: {
          type: "string",
          description: "Optional text query to match node names, descriptions, or properties."
        },
        label: {
          type: "string",
          description: "Optional category filter: 'Rule', 'Decision', 'Insight', 'Concept' (or execution types 'Goal', 'Task', 'Resource', 'Signal')."
        },
        limit: {
          type: "number",
          description: "Max number of nodes to return (default: 50)."
        },
        verbose: {
          type: "boolean",
          description: "When false (default), returns compact token-efficient node summaries and edges. Set true for full raw properties and metadata."
        }
      }
    }
  },
  {
    name: "bkn_apply_patch",
    description: "Create or update multiple BKN nodes (Variables, Logic gates, Rules with verification contracts, Tasks, Goals, Concepts) and wire typed/reactive edges between them in a single call.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        },
        nodes: {
          type: "array",
          description: "Nodes to create or update before linking edges.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              metadata: { type: "object" },
              node_class: {
                type: "string",
                enum: ["file", "variable", "document", "signal", "workflow", "entity"]
              },
              verification: {}
            },
            required: ["name", "label"]
          }
        },
        edges: {
          type: "array",
          description: "Directed typed/reactive edges to link between nodes in this patch or existing workspace nodes.",
          items: {
            type: "object",
            properties: {
              source_name: { type: "string" },
              target_name: { type: "string" },
              relationship_type: { type: "string" },
              description: { type: "string" },
              properties: { type: "object" }
            },
            required: ["source_name", "target_name", "relationship_type"]
          }
        }
      }
    }
  },
  {
    name: "bkn_ingest_content",
    description: "Universal Graph Ingestion engine. Analyzes raw unstructured text, application logs, specs, or code snippets, extracts entities and relationships, and automatically upserts them into the workspace Knowledge Graph.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The raw text, markdown document, code, or unstructured string to ingest into the Knowledge Graph."
        },
        source_name: {
          type: "string",
          description: "Name or identifier of the source (e.g., 'mobile-app-logs', 'linear-webhook', 'user-doc.md')."
        },
        source_type: {
          type: "string",
          description: "Category of the source (default: 'mcp_external_app')."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        }
      },
      required: ["content"]
    }
  },
  {
    name: "bkn_create_node",
    description: "Explicitly create or update a single Knowledge Node in the workspace Knowledge Graph, optionally attaching an executable verification contract.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        },
        name: {
          type: "string",
          description: "Name or title of the node (e.g., 'Auth Token Expiration Exception')."
        },
        label: {
          type: "string",
          description: "Taxonomy label for the node: 'Rule', 'Decision', 'Insight', 'Concept' (or execution types 'Goal', 'Task', 'Resource', 'Signal')."
        },
        node_class: {
          type: "string",
          enum: ["file", "variable", "document", "signal", "workflow", "entity"],
          description: "Optional operational class governing node behavior (e.g. 'file' for code files, 'variable' for counters/state, 'document' for rich text, 'entity' for passive concepts)."
        },
        description: {
          type: "string",
          description: "Detailed description or context for this node."
        },
        verification: {
          description: "Optional polymorphic executable verification contract (command string, array of specs, or object with type: 'command' | 'eval' | 'file_pattern' | 'http' | 'composite') run by bkn_verify_node and bkn_verify_workspace."
        },
        metadata: {
          type: "object",
          description: "Optional key-value JSON object containing custom properties, external IDs, or telemetry."
        }
      },
      required: ["name", "label", "description"]
    }
  },
  {
    name: "bkn_link_nodes",
    description: "Create a directed, typed edge between two existing nodes in the workspace Knowledge Graph.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        },
        source_name: {
          type: "string",
          description: "Name of the source node."
        },
        target_name: {
          type: "string",
          description: "Name of the target node."
        },
        relationship_type: {
          type: "string",
          description: "Type of relationship: 'governs', 'decided_by', 'supports', 'conflicts_with', 'implements', 'supersedes', 'aligns', 'requires', 'blocks', 'triggers', 'when_true', 'when_false', 'references'."
        },
        description: {
          type: "string",
          description: "Rationale or explanation of why these nodes are linked."
        },
        properties: {
          type: "object",
          description: "Optional structured edge metadata for reactive triggers (e.g. { condition, action, target_status, target_mutation, logic_branch })."
        }
      },
      required: ["source_name", "target_name", "relationship_type"]
    }
  },
  {
    name: "bkn_get_workspace_context",
    description: "Fetch comprehensive context about the workspace, including executive summary, tech spec, open user stories, tasks, and key Knowledge Graph nodes.",
    inputSchema: {
      type: "object",
      properties: {
        include_docs: {
          type: "boolean",
          description: "Whether to include full technical spec and executive summary (default: true)."
        },
        include_tasks: {
          type: "boolean",
          description: "Whether to include task epics and milestones (default: true)."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        }
      }
    }
  },
  {
    name: "bkn_push_telemetry",
    description: "Stream runtime telemetry, errors, or application events from an external app directly into the workspace's activity and audit log.",
    inputSchema: {
      type: "object",
      properties: {
        event_name: {
          type: "string",
          description: "Short event identifier (e.g. 'payment_gateway_timeout', 'user_signup_failed')."
        },
        severity: {
          type: "string",
          description: "Severity level: 'info', 'warning', 'error', 'critical'."
        },
        payload: {
          type: "object",
          description: "JSON payload containing diagnostic data, stack trace, or state variables."
        }
      },
      required: ["event_name", "payload"]
    }
  },
  {
    name: "bkn_mutate_variable",
    description: "Mutate a Variable Node (e.g. increment daily push-ups counter, toggle smart light switch, or reset state) in the workspace Knowledge Graph. Automatically evaluates and fires connected reactive edge triggers.",
    inputSchema: {
      type: "object",
      properties: {
        node_identifier: {
          type: "string",
          description: "UUID or exact name of the Variable Node to mutate."
        },
        operation: {
          type: "string",
          enum: ["increment", "decrement", "set", "toggle", "reset"],
          description: "Mutation operation to perform."
        },
        amount: {
          type: "number",
          description: "Optional numeric step for increment/decrement (default: 1)."
        },
        value: {
          description: "New value when using the 'set' operation."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["node_identifier", "operation"]
    }
  },
  {
    name: "bkn_delete_node",
    description: "Delete or archive a node in the workspace Knowledge Graph (BKN) and sever all connected relationships.",
    inputSchema: {
      type: "object",
      properties: {
        node_identifier: {
          type: "string",
          description: "UUID or exact name of the node to delete."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["node_identifier"]
    }
  },
  {
    name: "bkn_unlink_nodes",
    description: "Delete a directed relationship (edge) between two nodes in the workspace Knowledge Graph.",
    inputSchema: {
      type: "object",
      properties: {
        source_name: {
          type: "string",
          description: "Name or UUID of the source node."
        },
        target_name: {
          type: "string",
          description: "Name or UUID of the target node."
        },
        relationship_type: {
          type: "string",
          description: "Optional relationship type."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["source_name", "target_name"]
    }
  },
  {
    name: "bkn_get_subgraph",
    description: "Retrieve nodes scoped to a parent_uuid (or root if omitted) for fractal subgraph exploration.",
    inputSchema: {
      type: "object",
      properties: {
        parent_uuid: {
          type: "string",
          description: "Optional parent node UUID. Omit or pass null to fetch top-level root nodes."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      }
    }
  },
  {
    name: "bkn_get_related_nodes",
    description: "List the nodes directly connected to one anchor node, with the relationship type and direction. Walks the graph outward from an entity so an agent can read its neighbourhood without pulling the whole workspace.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Anchor node: its exact name or uuid."
        },
        limit: {
          type: "number",
          description: "Max related nodes to return (default: 25)."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID (defaults to bound .bkn/config.json or active workspace)."
        }
      },
      required: ["node"]
    }
  },
  {
    name: "agent_traverse_node",
    description: "Move an autonomous agent along a connected edge to a neighboring node, updating its topological location and streaming its traversal trail.",
    inputSchema: {
      type: "object",
      properties: {
        target_node_uuid: {
          type: "string",
          description: "UUID of the destination node."
        },
        reason: {
          type: "string",
          description: "Reason or operational intent for traversing to this node."
        },
        agent_id: {
          type: "string",
          description: "Optional agent ID."
        }
      },
      required: ["target_node_uuid"]
    }
  },
  {
    name: "bkn_emit_signal",
    description: "Emit an active graph signal onto a target node or the workspace, broadcasting across the graph and alerting resident agents.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title of the signal (e.g. 'Auth Rate Limit Exceeded' or 'MRR Milestone Achieved')."
        },
        target_node_uuid: {
          type: "string",
          description: "Optional UUID of the target knowledge node to attach this signal to."
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "critical", "success"],
          description: "Severity level of the signal (default: 'info')."
        },
        signal_type: {
          type: "string",
          description: "Category of signal: 'agent_alert', 'metric_threshold', 'webhook_event', 'human_blocker', 'temporal_deadline'."
        },
        description: {
          type: "string",
          description: "Detailed diagnostic narrative or explanation."
        },
        propagation_mode: {
          type: "string",
          enum: ["local", "downstream", "upstream", "broadcast"],
          description: "Propagation ripple mode across graph topology (default: 'local')."
        },
        payload: {
          type: "object",
          description: "Arbitrary structured JSON metadata/diagnostics."
        },
        is_persistent: {
          type: "boolean",
          description: "If true, also mirrors as a persistent Signal node in the Knowledge Graph."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["title"]
    }
  },
  {
    name: "bkn_resolve_signal",
    description: "Mark an active graph signal as resolved, recording resolution notes and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        signal_uuid: {
          type: "string",
          description: "UUID of the signal to resolve."
        },
        resolution_note: {
          type: "string",
          description: "Explanation of how the alert/blocker was resolved."
        }
      },
      required: ["signal_uuid"]
    }
  },
  {
    name: "bkn_list_signals",
    description: "List active and unacknowledged signals for the workspace or a specific node, ordered by severity.",
    inputSchema: {
      type: "object",
      properties: {
        target_node_uuid: {
          type: "string",
          description: "Optional UUID of the node to filter signals for."
        },
        limit: {
          type: "number",
          description: "Maximum number of signals to retrieve (default: 50)."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      }
    }
  },
  {
    name: "bkn_write_file",
    description: "Create or overwrite a file node in the workspace Knowledge Graph. Supports large text and code files (TypeScript, Python, JSON, Markdown, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path of the code or text file (e.g., 'src/app/page.tsx', 'package.json')."
        },
        label: {
          type: "string",
          description: "Optional semantic role of the file (e.g. 'Goal' if this code satisfies a project milestone, 'Rule' if it enforces an architecture guardrail, 'Task', or default 'Resource')."
        },
        content: {
          type: "string",
          description: "Full content of the file. Supports arbitrarily large code files and text documents."
        },
        language: {
          type: "string",
          description: "Optional programming language or format identifier (e.g., 'typescript', 'javascript', 'python', 'json', 'markdown', 'html', 'css')."
        },
        description: {
          type: "string",
          description: "Optional summary of the file's architectural role or functionality."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "bkn_read_file",
    description: "Read a file node's content and metadata from the workspace Knowledge Graph by path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path or node name to retrieve (e.g., 'src/app/page.tsx')."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bkn_edit_file",
    description: "Surgically edit a file node's content using exact target string search-and-replace, avoiding full rewrites of large code files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path of the file node to edit."
        },
        target: {
          type: "string",
          description: "The exact substring to find and replace in the file (must match exactly including whitespace)."
        },
        replacement: {
          type: "string",
          description: "The replacement string to substitute in place of target. Use empty string to delete target."
        },
        all: {
          type: "boolean",
          description: "Whether to replace all occurrences of target (default: false, replaces first occurrence)."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      },
      required: ["path", "target", "replacement"]
    }
  },
  {
    name: "bkn_list_files",
    description: "List all file and code nodes in the workspace Knowledge Graph, with paths, languages, and size metrics.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Optional directory prefix to filter file paths (e.g., 'src/', 'components/')."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        }
      }
    }
  },
  {
    name: "bkn_verify_node",
    description: "Execute a node's verification harness (command, eval script, file pattern, HTTP, or composite pipeline) to validate that active code satisfies the node's architectural invariants, rules, or contracts.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name or UUID of the node containing the executable verification contract."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        },
        files_changed: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of files modified during the current task, passed into script/file_pattern checks."
        },
        custom_spec: {
          description: "Optional custom verification spec to test against the node (overrides node properties for dry-runs)."
        }
      },
      required: ["node"]
    }
  },
  {
    name: "bkn_verify_workspace",
    description: "Scan and execute all executable verification contracts (rules, decisions, constraints) in the workspace to produce a comprehensive governance and invariant pass/fail report.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        },
        label: {
          type: "string",
          description: "Optional label filter (e.g. 'Rule', 'Decision', 'Component'). Defaults to all nodes with verification contracts."
        },
        limit: {
          type: "number",
          description: "Maximum number of nodes to verify (default: 20)."
        }
      }
    }
  },
  {
    name: "bkn_list_integrations",
    description: "List connected external SaaS integrations (Composio) for the workspace, their 1-turn action recipes (Gmail, Slack, GitHub, Linear, Notion, Google Calendar, etc.), and optionally search the 800+ app catalog.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        },
        query: {
          type: "string",
          description: "Optional keyword query to search available apps or actions (e.g., 'slack', 'email', 'linear', 'calendar')."
        },
        category: {
          type: "string",
          description: "Optional integration category filter (e.g., 'Productivity', 'Developer Tools', 'Communication')."
        },
        include_recipes: {
          type: "boolean",
          description: "Whether to include 1-turn parameter recipes for connected toolkits (default: true)."
        }
      }
    }
  },
  {
    name: "bkn_execute_integration",
    description: "Execute an external SaaS integration action via Composio (e.g., 'GMAIL_FETCH_EMAILS', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'LINEAR_CREATE_LINEAR_ISSUE', 'GITHUB_CREATE_AN_ISSUE', or shorthands like 'gmail.send_email', 'slack.send_message', 'gmail.create_draft') with automatic parameter aliasing, #channel/team/repo resolution, and optional BKN Knowledge Graph ingestion.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Composio action slug or canonical shorthand to execute (e.g., 'GMAIL_FETCH_EMAILS', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'GITHUB_CREATE_AN_ISSUE', 'gmail.create_draft')."
        },
        arguments: {
          type: "object",
          description: "Action parameters object (supports human-friendly aliases such as 'to', '#channel', 'owner/repo', and Linear team names)."
        },
        workspace_id: {
          type: "string",
          description: "Optional workspace UUID."
        },
        user_id: {
          type: "string",
          description: "Optional user UUID owning the Composio connected account (defaults to workspace owner / API key creator)."
        },
        connected_account_id: {
          type: "string",
          description: "Optional explicit Composio connected_account_id ('ca_...')."
        },
        ingest_to_graph: {
          type: "boolean",
          description: "When true, automatically extracts returned messages/items into provisional Knowledge Graph nodes in bkn_nodes (default: false)."
        }
      },
      required: ["action"]
    }
  },
  {
    name: "bkn_connect_folder",
    description: "Connect a local folder on disk to a Blueprint workspace so tools auto-resolve workspace_id and files can be synced into the workspace Knowledge Graph.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the local directory to connect (e.g., '/Users/alice/my-project' or '.')."
        },
        workspace_id: {
          type: "string",
          description: "Target Blueprint workspace UUID (defaults to active workspace)."
        },
        workspace_name: {
          type: "string",
          description: "Optional human-friendly workspace label."
        },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Optional glob patterns to include during folder sync (e.g., ['src/**', 'docs/*.md'])."
        },
        ignore: {
          type: "array",
          items: { type: "string" },
          description: "Optional additional glob patterns to ignore during folder sync."
        },
        max_file_size_bytes: {
          type: "number",
          description: "Optional per-file size cap in bytes (default: 262144)."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bkn_disconnect_folder",
    description: "Disconnect a local folder from its Blueprint workspace mapping.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the connected local directory to disconnect."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bkn_list_folders",
    description: "List all local folders currently connected to Blueprint workspaces.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bkn_sync_folder",
    description: "Incrementally sync text and code files from a connected local folder into its Blueprint workspace Knowledge Graph (respecting .gitignore, .bknignore, and secret exclusions).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the local directory to sync (defaults to current working directory if connected)."
        },
        workspace_id: {
          type: "string",
          description: "Optional Blueprint workspace UUID override."
        },
        dry_run: {
          type: "boolean",
          description: "When true, reports which files would be synced without writing to the workspace (default: false)."
        },
        force: {
          type: "boolean",
          description: "When true, re-syncs all matching files even if their SHA-256 hash has not changed (default: false)."
        }
      },
      required: ["path"]
    }
  }
];

