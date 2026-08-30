# webmap MCP server

Exposes the webmap datasets to MCP clients (Claude Code, Claude Desktop, any
MCP-capable agent) through the shared AI tool layer
(`providers/ai_tools.py`) — the same tools the website's Ask-AI agent uses.
The MCP client *is* the LLM: it reads the query guide, builds a JSON plan,
and the server validates (Pydantic — the security boundary) and executes it
against the read-only DuckDB files.

## Two modes

### Remote (the docker service — what users connect to)

Runs as `mcp_backend` in the compose stack, served at `<origin>/mcp`
(streamable HTTP). Every tool call needs a bearer token:

* users create **personal API tokens** in the webmap (sidebar → API Tokens);
* dataset access = exactly the platform rights (own + public + shared),
  enforced through the dataset service's `/resolve` — datasets are addressed
  by their numeric platform ID.

Connect from Claude Code:

```bash
claude mcp add webmap --transport http https://YOUR-SERVER/mcp \
  --header "Authorization: Bearer wm_YOURTOKEN"
```

Claude Desktop (no header support → `mcp-remote` shim), in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "webmap": {
      "command": "npx",
      "args": ["mcp-remote", "https://YOUR-SERVER/mcp",
               "--header", "Authorization: Bearer wm_YOURTOKEN"]
    }
  }
}
```

> Note: without HTTPS in front of the proxy, tokens travel in cleartext.

### Local (stdio — developer use on the machine that has the data)

No auth (your own file permissions), datasets = folder names under
`WEBMAP_DATASETS_DIR` (default `<repo>/data/dataset-storage`):

```bash
cd webmap-backend/mcp
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
claude mcp add webmap -- $PWD/.venv/bin/python $PWD/server.py
```

## Tools

| Tool | Purpose |
|---|---|
| `list_datasets` | Remote: datasets your token may access · Local: folders found |
| `dataset_info` | Row counts, sample rate, vocabulary (modes, purposes, ...) |
| `query_guide` | The query-DSL documentation + dataset vocabulary |
| `trip_query` | Validated trip-level query (`QueryPlan` JSON) |
| `transit_query` | Transit line/stop boarding questions (`TransitQuery` JSON) |
| `locate_place` | Find a stop / municipality / canton by name |
| `list_data_endpoints` | Catalog of 19 precomputed dashboard statistics (mode share, demographics, PT subscriptions, ...) |
| `fetch_data` | Fetch one dashboard endpoint with filters — covers synthetic AND microcensus |
| `sql_schema` | Tables + columns of `synthetic.duckdb` / `microcensus.duckdb` |
| `run_sql` | Read-only SQL (SELECT/WITH/DESCRIBE/SHOW/SUMMARIZE), row/time-capped |

Map-type outputs (GeoJSON) are summarized instead of returned — they are
meant for the webmap UI; use `number`/`table`/`chart` outputs here.

## How auth works (remote)

```
client ── Authorization: Bearer wm_xxx ──► mcp_backend
             │ POST /api-tokens/verify (cached 5 min)
             ▼
     authentification_backend  → user_id + short-lived access JWT
             │
             ▼
     dataset_backend /datasets/{id}/resolve (cookie = JWT, cached 10 min)
             → filesystem root, only if the user may read the dataset
```

Tokens are stored hashed (SHA-256) in the auth DB, expire (30/90/365 days)
and can be revoked in the webmap UI at any time.
