# How the Knowledge Graph Works via MCP

This document explains how Knowledge Graph queries work in our project when accessed via the Model Context Protocol (MCP), specifically focusing on what the LLM sees when it issues queries, the data structures returned, the relationship calculations, and architectural shortcomings.

## Overview

The Knowledge Graph connects the entire workspace, mapping Projects, Notes, Task Cards, and Tags as **Nodes**, and their relationships (like mentions, wikilinks, and project ownership) as **Edges**.

When an external LLM agent (like Claude Desktop or OpenCode) connects to our standalone MCP server (`mcp-server.ts`), it has access to two specific tools to interact with this graph:
1. `get_knowledge_graph`: Retrieves the full workspace graph, optionally scoped by project IDs to reduce the payload size.
2. `get_neighbors`: Performs an N-hop traversal (BFS) around a specific node. This is the preferred method for focused research to keep the context window lean.

## What the LLM Sees: The Tool Schema

Before the LLM can query the graph, the MCP server exposes the tool schemas to it. This is exactly what the LLM uses to structure its JSON-RPC request.

Here is the schema for `get_knowledge_graph` that the LLM sees:

```json
{
  "name": "get_knowledge_graph",
  "description": "Full workspace knowledge graph: all projects, notes, cards, and tags as nodes with relationships as edges. Scope with projectIds to reduce size.",
  "parameters": {
    "type": "object",
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "projectIds": {
        "type": "array",
        "items": { "type": "string" }
      },
      "includeAuto": {
        "type": "boolean",
        "description": "Include auto-discovered edges (co-mention, keyword, assignee). Default true."
      },
      "nodeTypes": {
        "type": "array",
        "items": { "type": "string", "enum": ["project", "note", "card", "tag"] }
      },
      "edgeTypes": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["workspaceId"]
  }
}
```

## How the Query Works under the Hood

When the LLM calls `get_knowledge_graph`, the standalone MCP server processes the request.

1. **Standalone Execution:** The MCP server executes as a separate Node.js process. It connects directly to the SQLite database.
2. **Filtering:** It fetches projects based on the provided `workspaceId` and optional `projectIds` array.
3. **Fetching Entities:** It queries SQLite for `notes`, `task_cards`, and `tags` that belong to the filtered projects.
4. **Building Nodes & Edges:** It maps these rows into a generic `{ nodes: [...], edges: [...] }` JSON payload.
5. **Auto-Relationships:** If `includeAuto` is true, it queries the `relationship_cache` table to append dynamically computed edges (like TF-IDF keyword overlap).

## Example Output: What the LLM Ingests

The response given to the LLM is a flat JSON structure containing `nodes` and `edges`.

### Example JSON Payload

```json
{
  "nodes": [
    {
      "id": "proj_123",
      "type": "project",
      "title": "Authentication V2",
      "meta": { "status": "active", "priority": "high" }
    },
    {
      "id": "note_456",
      "type": "note",
      "title": "JWT Security spec",
      "projectId": "proj_123",
      "meta": { "snippet": "We need to ensure refresh tokens are rotated..." }
    },
    {
      "id": "card_789",
      "type": "card",
      "title": "Implement Refresh Token Endpoint",
      "projectId": "proj_123",
      "meta": { "priority": "high", "assignee": "alice", "snippet": "Endpoint needs to accept the HTTPOnly cookie..." }
    }
  ],
  "edges": [
    {
      "id": "pm:proj_123:note_456:0",
      "source": "proj_123",
      "target": "note_456",
      "type": "project-member"
    },
    {
      "id": "nc:note_456:card_789:1",
      "source": "note_456",
      "target": "card_789",
      "type": "note-card",
      "label": "linked"
    },
    {
      "id": "co-mention:note_456:card_789:2",
      "source": "note_456",
      "target": "card_789",
      "type": "co-mention",
      "weight": 0.85
    }
  ]
}
```

## Relationships (Edges)

Edges are what make the Knowledge Graph useful. They are categorized into two types: Explicit and Auto-computed.

### 1. Explicit Links (Direct DB relations)
*   **`project-member`**: Links a note or card to its parent project.
*   **`note-note`** / **`note-card`**: Derived from explicit references saved in `linked_note_ids` or `linked_card_ids` columns.
*   **`flow-edge`**: Extracted from the Idea Flow canvas connections.

### 2. Auto-computed Relationships (`relationship_cache`)
These are computed by `computeAutoRelationships` inside the main application and cached in the DB:
*   **`wikilink`**: Parsed `[[Title]]` syntax within Markdown text.
*   **`co-mention`**: Occurs when the content of a note explicitly mentions the exact title of another note or card.
*   **`keyword`**: TF-IDF Jaccard similarity. The system tokenizes note contents (ignoring stop words) and creates an edge if the similarity threshold (0.15) is met.
*   **`assignee`**: Links two task cards together if they are assigned to the same user.

## Shortcomings & Limitations

1. **Context Window Bloat (`get_knowledge_graph`):** For a large workspace, returning *every* node and edge will consume a massive amount of the LLM's context window. Agents are heavily encouraged to use `projectIds` filtering or rely on `get_neighbors`.
2. **Duplicated Logic (ABI Boundary):** Because the standalone MCP server is compiled as a separate binary (to support OpenCode/Claude Desktop natively), it cannot safely import the `better-sqlite3` queries from the main Electron app due to Node ABI constraints. As a result, the `get_knowledge_graph` query logic is duplicated: once in `graph-queries.ts` for the renderer UI, and completely rewritten inline in `mcp-server.ts`.
3. **Stale Auto-Relationships via MCP:** The `relationship_cache` is computed by the main Electron app. If the MCP server writes a new note while the main Cairn app is closed, the auto-relationships (like TF-IDF similarities) will not be calculated until the main app is booted up again.
4. **BFS In-Memory for `get_neighbors`:** The MCP implementation of `get_neighbors` calculates the N-hop traversal by first generating the *entire* graph in memory and then doing a BFS. While fine for typical personal workspace sizes, this is unoptimized and scales poorly on CPU/Memory for massive databases.