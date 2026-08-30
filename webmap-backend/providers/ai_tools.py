"""Shared AI tool layer.

One set of data tools, offered twice:
  • the MCP server (mcp/server.py) exposes them to external MCP clients,
  • the website agent (providers/agent.py) calls them in-process.

Every function assumes the dataset root is already scoped via
``paths.set_root_override`` — dataset selection/authorization is the
CALLER's job (the MCP server resolves grants through the dataset service,
the webmap endpoint has already done so for the request).

Security model, same as the Ask-AI feature: tool inputs come from an LLM
and are untrusted. Pydantic validation of the query DSL is the boundary for
trip/transit queries; SQL is restricted to read-only statements against the
read-only DuckDB with a row cap and an interrupt-based timeout.
"""

from __future__ import annotations

import json
import threading

MAX_SQL_ROWS = 500
SQL_TIMEOUT_S = 20.0
_SQL_ALLOWED = ("select", "with", "describe", "show", "summarize", "explain")

# Precomputed dashboard endpoints exposed to the AI (aggregated statistics
# only — geometry/map-asset providers are excluded on purpose: they return
# megabytes of GeoJSON that neither an LLM context nor a chat needs).
_ENDPOINT_WHITELIST = {
    "age.json", "gender.json", "car_availability.json",
    "departure_times.json", "num_cars.json", "pt_sub.json",
    "mode_share.json", "purpose_share.json", "avg_distance.json",
    "activity_durations.json", "num_activities.json", "out_of_home.json",
    "frequent_sequences.json", "histogram_distance.json",
    "stacked_bar_distance.json", "lineplot.json", "modes_by_canton.json",
    "speed_dashboard.json", "stop_transfer_data_by_canton.json",
}
MAX_ENDPOINT_CHARS = 100_000


# ─── Tool implementations ────────────────────────────────────────────────

def dataset_info() -> dict:
    """Row counts, sample rate and vocabulary of the scoped dataset."""
    from .connection import get_source_cursor
    from .nl_query import _dataset_vocab
    info: dict = {"vocab": _dataset_vocab()}
    for source in ("synthetic", "microcensus"):
        counts = {}
        try:
            con = get_source_cursor(source)
            for table in ("persons", "trips", "households"):
                try:
                    counts[table] = con.execute(
                        f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                except Exception:
                    pass
        except Exception:
            continue
        if counts:
            info[source] = counts
    return info


def query_guide() -> str:
    """The query-DSL documentation + vocabulary for the scoped dataset."""
    from .nl_query import _dataset_vocab, _system_prompt
    return _system_prompt(_dataset_vocab())


def trip_query(plan: dict, title: str = "") -> dict:
    """Validated trip-level query (QueryPlan DSL)."""
    from .nl_query import QueryPlan, _dataset_vocab, _execute_plan
    parsed = QueryPlan.model_validate(plan)
    return _execute_plan(parsed, title, _dataset_vocab())


def transit_query(query: dict, title: str = "") -> dict:
    """Transit line/stop boarding query (TransitQuery DSL)."""
    from .nl_query import TransitQuery, _execute_transit
    parsed = TransitQuery.model_validate(query)
    return _execute_transit(parsed, title)


def locate_place(name: str) -> dict:
    """Find a stop / municipality / canton by name."""
    from .nl_query import LocateQuery, _execute_locate
    return _execute_locate(LocateQuery(name=name))


def highlight_regions(names: list[str], color: str | None = None) -> dict:
    """Highlight administrative regions (cantons, districts, municipalities)
    on the map as filled polygons."""
    from .connection import get_source_cursor
    from .nl_query import _resolve_place
    if not names:
        raise ValueError("names must contain at least one region name")
    con = get_source_cursor("synthetic")
    feats, found, missing = [], [], []
    for raw in [str(n) for n in names][:10]:
        place = _resolve_place(raw)
        if place is None:
            missing.append(raw)
            continue
        pid = (f"canton:{place['canton_id']}" if place["kind"] == "canton"
               else place["polygon_id"])
        row = con.execute(
            "SELECT polygon_name, ST_AsGeoJSON(ST_Transform("
            "ST_Simplify(polygon_geom, 20), 'EPSG:2056', 'EPSG:4326', "
            "always_xy := true)) "
            "FROM hot_polygons WHERE polygon_id = ?", [pid]).fetchone()
        if row is None:
            missing.append(raw)
            continue
        feats.append({"type": "Feature", "properties": {"name": row[0]},
                      "geometry": json.loads(row[1])})
        found.append(row[0])
    if not feats:
        raise ValueError(f"no region found for {names} - use canton, "
                         "district or municipality names")
    reply = f"Highlighted on the map: {', '.join(found)}."
    if missing:
        reply += f" Not found: {', '.join(missing)}."
    return {"reply": reply, "display": {
        "type": "map_layers",
        "layers": [{"id": "regions", "kind": "polygons",
                    "label": ", ".join(found),
                    "color": (color or "").strip() or None,
                    "geojson": {"type": "FeatureCollection", "features": feats}}],
    }}


def show_links(link_ids: list, color: str | None = None,
               label: str | None = None) -> dict:
    """Draw specific network links (road segments) on the map by link_id."""
    from .connection import get_source_cursor
    ids = [str(l) for l in (link_ids or [])][:2000]
    if not ids:
        raise ValueError("link_ids must contain at least one id")
    con = get_source_cursor("synthetic")
    rows = con.execute(
        f"""SELECT link_id,
                   ST_AsGeoJSON(ST_Transform(geom, 'EPSG:2056', 'EPSG:4326',
                                             always_xy := true))
            FROM network_links
            WHERE link_id IN ({','.join('?' * len(ids))})""", ids).fetchall()
    if not rows:
        raise ValueError(f"no network links found for {ids[:5]}")
    feats = [{"type": "Feature", "properties": {"name": lid},
              "geometry": json.loads(g)} for lid, g in rows if g]
    missing = len(ids) - len(feats)
    reply = (f"Drawn on the map: {len(feats)} road segment(s)"
             + (f" ({missing} id(s) not found)" if missing else "") + ".")
    return {"reply": reply, "display": {
        "type": "map_layers",
        "layers": [{"id": "links", "kind": "lines",
                    "label": label or f"{len(feats)} road segment(s)",
                    "color": (color or "").strip() or "#e11d48",
                    "width": 6,
                    "geojson": {"type": "FeatureCollection", "features": feats}}],
    }}


def sql_schema(source: str = "synthetic", table: str | None = None) -> dict:
    """Tables and columns of the scoped dataset's DuckDB file. Compact
    one-line-per-table format so the FULL schema fits into an LLM context;
    pass `table` for a single table's detail."""
    from .connection import get_source_cursor
    if source not in ("synthetic", "microcensus"):
        raise ValueError("source must be 'synthetic' or 'microcensus'")
    con = get_source_cursor(source)
    names = [r[0] for r in con.execute("SHOW TABLES").fetchall()]
    if table:
        if table not in names:
            raise ValueError(f"unknown table '{table}'. Tables: {', '.join(names)}")
        names = [table]
    tables = {}
    for name in names:
        cols = con.execute(f'DESCRIBE "{name}"').fetchall()
        tables[name] = ", ".join(f"{c[0]} {c[1]}" for c in cols)
    return {"source": source, "tables": tables}


def run_sql(sql: str, source: str = "synthetic", limit: int = 200) -> dict:
    """Read-only SQL against the scoped dataset. Allowlisted statements,
    row cap, interrupt-based timeout (LLM-generated scans can be slow)."""
    from .connection import get_source_cursor
    if source not in ("synthetic", "microcensus"):
        raise ValueError("source must be 'synthetic' or 'microcensus'")
    stmt = (sql or "").strip().rstrip(";")
    if ";" in stmt:
        raise ValueError("one statement per call")
    if not stmt.lower().startswith(_SQL_ALLOWED):
        raise ValueError(f"only {'/'.join(s.upper() for s in _SQL_ALLOWED)} "
                         "statements are allowed")
    limit = max(1, min(int(limit), MAX_SQL_ROWS))
    con = get_source_cursor(source)
    timer = threading.Timer(SQL_TIMEOUT_S, con.interrupt)
    timer.start()
    try:
        cur = con.execute(stmt)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchmany(limit + 1)
    except Exception as exc:
        if "interrupt" in str(exc).lower():
            raise ValueError(f"query cancelled after {SQL_TIMEOUT_S:.0f}s — "
                             "add filters or LIMIT") from exc
        raise
    finally:
        timer.cancel()
    return {"columns": columns,
            "rows": [list(r) for r in rows[:limit]],
            "truncated": len(rows) > limit}


def _endpoint_registry() -> dict:
    from . import ALL_PROVIDERS
    return {p.ROUTE: p for p in ALL_PROVIDERS if p.ROUTE in _ENDPOINT_WHITELIST}


def list_data_endpoints() -> dict:
    """Catalog of the precomputed dashboard endpoints: name, what it
    returns, and the accepted parameters."""
    out = []
    for route, p in sorted(_endpoint_registry().items()):
        doc = (p.__class__.__doc__ or "").strip().splitlines()
        out.append({
            "endpoint": route,
            "description": doc[0] if doc else "",
            "params": [{
                "name": pr.name, "description": pr.description,
                **({"enum": pr.enum} if pr.enum else {}),
                **({"default": pr.default} if pr.default is not None else {}),
            } for pr in p.PARAMS],
        })
    return {"endpoints": out,
            "note": "these return PRECOMPUTED aggregates and usually cover "
                    "BOTH sources (synthetic simulation + microcensus survey) "
                    "- ideal for comparisons and dashboard-style statistics"}


def fetch_data(endpoint: str, params: dict | None = None) -> dict:
    """Call one precomputed dashboard endpoint with query parameters."""
    reg = _endpoint_registry()
    p = reg.get(endpoint) or reg.get(f"{endpoint}.json")
    if p is None:
        raise ValueError(f"unknown endpoint '{endpoint}'. Known: "
                         + ", ".join(sorted(reg)))
    clean = {k: str(v) for k, v in (params or {}).items() if v is not None}
    result = p.deliver(clean)
    if not isinstance(result, dict):        # some providers return error responses
        try:
            body = result.body            # fastapi JSONResponse
            result = json.loads(body)
        except Exception:
            raise ValueError(f"endpoint '{endpoint}' returned no data")
    if len(json.dumps(result, default=str)) > MAX_ENDPOINT_CHARS:
        raise ValueError(f"result of '{endpoint}' is too large - narrow it "
                         "down with parameters (e.g. canton=...)")
    return result


# ─── Tool specs (standard JSON Schema; adapters convert per provider) ────

def _plan_schema() -> dict:
    from .nl_query import QueryPlan
    return QueryPlan.model_json_schema()


def _transit_schema() -> dict:
    from .nl_query import TransitQuery
    return TransitQuery.model_json_schema()


def tool_specs() -> list[dict]:
    """Specs for LLM function-calling and MCP registration. Descriptions are
    written for the model: say WHEN to call, not just what it does."""
    return [
        {
            "name": "trip_query",
            "description": (
                "Run a validated trip-level query over the simulation "
                "(trips x persons x households x routes). Call this for any "
                "question about trips, travellers, mode share, travel times, "
                "distances or flows. Prefer output.type 'number', 'table' or "
                "'chart'; use 'map' only when the user asks to SEE trips on "
                "the map. All fields are nested JSON OBJECTS (never strings) "
                "and filter fields are plural arrays. Example — bike trips "
                "to work in canton Bern: {\"plan\": {\"trip\": {\"modes\": "
                "[\"bike\"], \"purpose_to\": [\"work\"], \"dest_place\": "
                "\"Bern\"}, \"output\": {\"type\": \"number\", \"metric\": "
                "\"count\"}}}"),
            "input_schema": {
                "type": "object",
                "properties": {
                    "plan": _plan_schema(),
                    "title": {"type": "string",
                              "description": "short human-readable title"},
                },
                "required": ["plan"],
            },
        },
        {
            "name": "transit_query",
            "description": (
                "Answer questions about transit LINES and STOPS from boarding "
                "data: number of lines, boardings per line/stop, busiest "
                "lines/stops. Call this instead of trip_query when the "
                "question is about lines or stations."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": _transit_schema(),
                    "title": {"type": "string"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "locate_place",
            "description": (
                "Find a place by name (transit stop, municipality or canton) "
                "and mark it on the map. Call when the user asks to show or "
                "find a location."),
            "input_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
        {
            "name": "dataset_info",
            "description": (
                "Row counts, sample rate and vocabulary (modes, purposes, "
                "income classes) of the current dataset. Call once when you "
                "need to know what values exist."),
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "highlight_regions",
            "description": (
                "Highlight one or more administrative regions on the map as "
                "filled polygons: cantons, districts (Bezirke) or "
                "municipalities. Call when the user wants to SEE a region "
                "('highlight the canton of Bern', 'show the district of "
                "Uster'). Optional CSS color."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string"},
                              "description": "region names, free text"},
                    "color": {"type": "string",
                              "description": "optional CSS color, e.g. '#e11d48'"},
                },
                "required": ["names"],
            },
        },
        {
            "name": "show_links",
            "description": (
                "Draw specific road segments (network links) on the map by "
                "link_id and zoom to them. Call this whenever you want to "
                "SHOW a link you found via SQL/analysis ('where is that "
                "segment?'). Optional CSS color and label."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "link_ids": {"type": "array", "items": {"type": "string"}},
                    "color": {"type": "string"},
                    "label": {"type": "string",
                              "description": "short caption for the layer"},
                },
                "required": ["link_ids"],
            },
        },
        {
            "name": "list_data_endpoints",
            "description": (
                "Catalog of PRECOMPUTED dashboard statistics endpoints "
                "(mode share, age/gender distributions, PT subscriptions, "
                "car availability, activity durations, distance histograms, "
                "...). Most cover BOTH the synthetic simulation and the "
                "microcensus survey - call fetch_data afterwards. Prefer "
                "these over trip_query for standard statistics and for any "
                "synthetic-vs-microcensus comparison."),
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "fetch_data",
            "description": (
                "Fetch one precomputed dashboard endpoint from "
                "list_data_endpoints with query parameters, e.g. "
                "fetch_data(endpoint='mode_share.json', params={'canton': "
                "'Zürich'})."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "endpoint": {"type": "string",
                                 "description": "endpoint name from "
                                                "list_data_endpoints"},
                    "params": {
                        "type": "object",
                        "description": "query parameters for the endpoint",
                        "properties": {
                            "canton": {"type": "string"},
                            "source": {"type": "string",
                                       "enum": ["synthetic", "microcensus"]},
                            "gender": {"type": "string", "enum": ["0", "1"]},
                            "age_min": {"type": "integer"},
                            "age_max": {"type": "integer"},
                            "mode": {"type": "string"},
                            "purpose": {"type": "string"},
                            "breakdown": {"type": "string"},
                            "group_by": {"type": "string"},
                            "distance_type": {"type": "string"},
                            "metric": {"type": "string"},
                            "summary_only": {"type": "string"},
                        },
                    },
                },
                "required": ["endpoint"],
            },
        },
        {
            "name": "sql_schema",
            "description": (
                "List tables and columns of the dataset's DuckDB file. Call "
                "before run_sql when the query DSL cannot express the "
                "question. Use ONLY column names from this schema. Pass "
                "'table' for one table's detail."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "source": {"type": "string",
                               "enum": ["synthetic", "microcensus"],
                               "description": "simulation or survey data"},
                    "table": {"type": "string",
                              "description": "optional: single table"},
                },
            },
        },
        {
            "name": "run_sql",
            "description": (
                "Run one read-only SQL statement (SELECT/WITH/DESCRIBE/SHOW/"
                "SUMMARIZE) against the dataset. Use only when trip_query/"
                "transit_query cannot express the question. Always use "
                "aggregations or LIMIT — results are capped at "
                f"{MAX_SQL_ROWS} rows and {SQL_TIMEOUT_S:.0f}s."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string"},
                    "source": {"type": "string",
                               "enum": ["synthetic", "microcensus"]},
                    "limit": {"type": "integer", "minimum": 1,
                              "maximum": MAX_SQL_ROWS},
                },
                "required": ["sql"],
            },
        },
    ]


# name → callable, for the agent loop and the MCP wrappers
TOOL_FUNCS = {
    "trip_query": trip_query,
    "transit_query": transit_query,
    "locate_place": locate_place,
    "highlight_regions": highlight_regions,
    "show_links": show_links,
    "dataset_info": dataset_info,
    "list_data_endpoints": list_data_endpoints,
    "fetch_data": fetch_data,
    "sql_schema": sql_schema,
    "run_sql": run_sql,
}
