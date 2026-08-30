"""Website AI agent — multi-step "Ask AI".

Replaces the single-shot question→query translation: the LLM now runs a
small function-calling loop over the shared tool layer (ai_tools). It can
chain queries, inspect intermediate results, compare numbers and self-
correct on validation errors before answering.

Display handling: tool results that carry a display payload (chart, table,
map GeoJSON, locate marker) are intercepted here — the frontend gets the
full payload, the LLM only sees a compact summary (an 80k-feature GeoJSON
must never enter the context window).

The dataset root is scoped by the caller (main.py sets the per-request
override before invoking run_agent, exactly as for every other provider).
"""

from __future__ import annotations

import json
import logging

from . import _llm, ai_log, ai_tools
from .constants import CANTON_MAP

logger = logging.getLogger(__name__)

MAX_STEPS = 10             # LLM turns (a turn may contain several tool calls)
MAX_DISPLAYS = 4           # visual payloads forwarded to the frontend
LLM_RESULT_CHARS = 9000    # hard cap for a tool result in the LLM context
LLM_TABLE_ROWS = 30


# Tables the LLM actually analyses — inlined into the prompt so it never
# has to guess column names (the top ⚠️-retry cause in the evals). The
# hex-tile/spider index tables stay out: irrelevant for questions and pure
# prompt noise. Full schema remains available via the sql_schema tool.
_CORE_TABLES = ("trips", "persons", "households", "activities",
                "network_links", "link_speeds")
_schema_cache: dict[str, str] = {}


def _core_schema_block() -> str:
    from .paths import dataset_key
    dk = dataset_key()
    if dk in _schema_cache:
        return _schema_cache[dk]
    from . import ai_tools
    lines = []
    try:
        tables = ai_tools.sql_schema("synthetic")["tables"]
        for t in _CORE_TABLES:
            if t in tables:
                lines.append(f"  {t}({tables[t]})")
    except Exception:
        return ""
    block = "\n".join(lines)
    if len(_schema_cache) > 16:
        _schema_cache.clear()
    _schema_cache[dk] = block
    return block


def _agent_system_prompt() -> str:
    from .nl_query import _dataset_vocab
    from .ai_tools import _ENDPOINT_WHITELIST
    vocab = _dataset_vocab()
    cantons = ", ".join(CANTON_MAP.values())
    sr = vocab.get("sample_rate")
    sr_note = (f"This is a {sr:.0%} population sample — counts scale by 1/{sr}."
               if sr else "")
    return f"""You are the data assistant of a Swiss MATSim transport-simulation webmap.
You always respond in English, no matter which language the user writes in.
Answer the user's questions by calling the available tools; you may chain
several calls (query, inspect, refine, compare) before answering.

Vocabulary of THIS dataset (use these exact values):
- canton names: {cantons}
- trip modes: {vocab['modes']}
- transit line modes: {vocab['transit_modes']}
- trip purposes: {vocab['purposes']}
- household income_class values (ordered; 'highest' = last): {vocab['income_classes']}
- household n_cars_class values: {vocab['n_cars_classes']}
- ovgk (PT quality class of home, A=best): {vocab['ovgk']}

Rules:
- ALWAYS ANSWER IN ENGLISH. Even when the question is asked in German,
  French or any other language — the entire product UI is English.
- The simulation covers ONE average workday. No weekday/season questions. {sr_note}
- "commute" → trip.purpose_to=["work"]; shopping → ["shop"]; leisure → ["leisure"].
- metric "count" counts TRIPS, "count_persons" counts UNIQUE PEOPLE.
- Breakdowns/profiles ("by hour", "per mode", "by canton"): output.type
  "chart" with output.group_by ∈ hour | mode | purpose | origin_canton |
  dest_canton | age_group | income_class (there is NO other breakdown
  field; group_by "hour" supports hour_bin for bucket size).
- Superlatives ("longest/fastest trip", "the 10 longest"): output.type="table",
  order_by + order_dir + limit (1 for "the ...", N for "the N ...").
- Numeric ranges (age, depart_hour, travel_time_min, network_distance_km,
  detour_factor) use gte/lte, e.g. {{"age": {{"gte": 65}}}} — NOT min/max.
- PLACES: origin_place/dest_place/via_place/home_place accept a canton,
  district or municipality name as free text. If the user means the CITY of
  Zürich/Bern/... (not the canton), append "city" (e.g. "Zürich city").
  route.via_place matches the driven route (car trips only).
- Output types: BE PROACTIVELY VISUAL. Whenever the answer is a
  distribution, comparison, share, ranking or time profile, return a
  "chart" (or "table" for listings) WITHOUT the user having to ask —
  never dump a list of numbers as prose. Use "number" only for single
  scalar facts and intermediate steps. "map" stays reserved for trips the
  user wants to SEE on the map ("zeig mir", "show me") — but when the
  ANSWER is a set of places or road segments, always draw it
  (show_links / locate_place / highlight_regions). Charts, tables and map
  layers you request are shown to the user automatically underneath your
  answer.
- "Show it/them on the map" follow-ups: reuse ALL filters and order/limit
  from your previous query, change only output.type to "map".
- locate_place marks a station/municipality/canton on the map;
  highlight_regions draws cantons/districts/municipalities as filled
  polygons ("highlight the canton of Bern"); show_links draws specific
  road segments by link_id and zooms to them ("where is that segment?").
- ONE primary visual per request — never stack redundant ones. If you
  select a canton or open a module via ui_action, do NOT additionally
  highlight_regions / locate_place the same place; if you highlight a
  region, don't also locate its centre. Combine visuals only when they
  show DIFFERENT things (e.g. a chart plus the map layer it explains).
- NEVER claim something is shown/highlighted/zoomed on the map unless a
  tool call in THIS conversation actually returned a map display for it.
  If you found a link/place via SQL, call show_links/locate_place to
  actually display it before saying so.
- STANDARD STATISTICS (mode share, age/gender distributions, PT
  subscriptions, car availability, activity durations, distance
  histograms) and any synthetic-vs-microcensus comparison: prefer
  list_data_endpoints + fetch_data (precomputed, covers both sources)
  over trip_query.
- Use run_sql ONLY when no other tool can express the question. Use ONLY
  column names from the CORE TABLES below (or sql_schema for other
  tables) — never guess. If a query fails on a missing column/table,
  re-read sql_schema (table=...) and retry.

CORE TABLES of the synthetic DB (columns you may query with run_sql;
more tables exist — see sql_schema):
{_core_schema_block()}
Column semantics: link_speeds.time_bin is a 15-MINUTE bin 0-95 (hour =
time_bin // 4); network speeds are m/s; trips.departure_time and
travel_time are SECONDS. Transit BOARDING data (lines, stops) is NOT in
the SQL tables at all — it only exists via transit_query (or the boarding
endpoints). For an hourly boarding profile of one line use transit_query
kind='line_boardings', output='chart' — the result is stored (rX) and can
be combined with anything else via render_chart.

fetch_data endpoints (exact names; params via list_data_endpoints):
{", ".join(sorted(_ENDPOINT_WHITELIST))}
- The synthetic DB also has network tables: network_links (road segments
  with freespeed, capacity, length, modes) and link_speeds (measured speed
  per link and hour) — road/segment-level questions ARE answerable.
  CAVEAT: link ids starting with "pt_" are transit/teleport links, not
  roads — exclude them (link_id NOT LIKE 'pt_%') for road questions.
  Speeds in network tables are in m/s — report km/h (multiply by 3.6).
- Not answerable: demographics of transit-line riders, exact addresses.
- Counts come back as raw sample counts plus a population-scaled estimate.
  Say which one you are quoting (e.g. "24'940 trips in the 1% sample,
  ~2.5 million scaled to the full population").
- SANITY-CHECK results before presenting them. Near-zero link speeds are
  simulation artifacts (blocked/parked vehicles), NOT congestion: for
  slowest-road / congestion questions ALWAYS filter avg_speed > 0.55
  (m/s, = 2 km/h) AND link_id NOT LIKE 'pt_%' in the SQL and say that
  artifacts were excluded. Better still, measure congestion RELATIVE to
  the limit: join network_links and rank by avg_speed/freespeed (ratio
  < 0.5 = congested) — absolute slowest speeds mostly surface artifacts.
  Same instinct everywhere: all-zero counts or absurd magnitudes -> add
  a filter, mention it, rerun.
- After drawing something on the map, add ONE orienting sentence (how
  many elements, roughly where — e.g. "scattered across the country,
  the largest near Bern") so the user knows where to look.
- Concise answers, numbers formatted readably. Do not invent
  vocabulary values. If a tool errors, fix your call and retry (max twice).
- If trip_query fails validation, FIX THE FIELD NAMES AND RETRY trip_query.
  Do not switch to run_sql just because one call was rejected — SQL is the
  last resort, not the fallback for typos.
- NEVER announce a tool call in text ("I will now query..."). Either CALL
  the tool, or give the final answer. Your text is only shown at the end.
"""


def _summarize_for_llm(result: dict) -> str:
    """Compact JSON for the LLM context: strip geojson, cap table rows."""
    slim = dict(result)
    display = dict(slim.get("display") or {})
    if isinstance(display.get("geojson"), dict):
        n = len(display["geojson"].get("features", []))
        display["geojson"] = f"<{n} features - already shown to the user on the map>"
    if isinstance(display.get("layers"), list):        # map_layers payloads
        display["layers"] = [
            {**l, "geojson": f"<{len((l.get('geojson') or {}).get('features', []))} "
                             "features - drawn on the map>"}
            for l in display["layers"]]
    rows = display.get("rows")
    if isinstance(rows, list) and len(rows) > LLM_TABLE_ROWS:
        display["rows"] = rows[:LLM_TABLE_ROWS]
        display["note"] = (f"{len(rows) - LLM_TABLE_ROWS} more rows shown to "
                           "the user but omitted here")
    if display:
        slim["display"] = display
    text = json.dumps(slim, ensure_ascii=False, default=str)
    if len(text) > LLM_RESULT_CHARS:
        text = text[:LLM_RESULT_CHARS] + "...<truncated>"
    return text


def _args_brief(name: str, args: dict) -> str:
    """One-line summary of a tool call for the step trace — whitespace is
    collapsed so multi-line SQL can't break the chip layout."""
    return " ".join(_args_brief_raw(name, args).split())


def _args_brief_raw(name: str, args: dict) -> str:
    if name == "run_sql":
        sql = str(args.get("sql", ""))
        return sql[:120] + ("…" if len(sql) > 120 else "")
    if name == "locate_place":
        return str(args.get("name", ""))
    if name == "render_chart":
        spec = args.get("spec") or {}
        names = ", ".join(str(s.get("name", "")) for s in (spec.get("series") or [])[:3])
        return str(spec.get("title") or names)
    if name == "get_result":
        return str(args.get("id") or "")
    if name == "fetch_data":
        ep = str(args.get("endpoint") or "")
        params = args.get("params") or {}
        extra = ", ".join(f"{k}={v}" for k, v in list(params.items())[:3])
        return f"{ep} ({extra})" if extra else ep
    if name == "sql_schema":
        return " ".join(str(args[k]) for k in ("source", "table") if args.get(k))
    if name == "ui_action":
        p = args.get("params") or {}
        return f"{args.get('action', '')} {json.dumps(p) if p else ''}".strip()
    if name == "show_links":
        ids = args.get("link_ids") or []
        return f"{len(ids)} link(s): {', '.join(map(str, ids[:3]))}"
    if name == "highlight_regions":
        return ", ".join(map(str, (args.get("names") or [])[:4]))
    if name == "propose_simulation":
        n_ops = len(args.get("operations") or [])
        return f"{args.get('title', '')} ({n_ops} operation(s))"
    if name in ("confirm_simulation", "simulation_status",
                "cancel_simulation"):
        jid = args.get("job_id")
        return f"job {jid}" if jid is not None else ""
    title = args.get("title")
    if title:
        return str(title)
    inner = args.get("plan") or args.get("query") or {}
    try:
        s = json.dumps(inner, ensure_ascii=False)
        return s[:120] + ("…" if len(s) > 120 else "")
    except Exception:
        return ""


_CHART_TOOL_SPECS = [
    {
        "name": "render_chart",
        "description": (
            "Build a custom chart: several series in ONE chart, types "
            "bar/line/scatter/area, log axis, stacking, and free element-wise "
            "math over stored results. Each series uses exactly one of: "
            "inline y-values; source='rX' (reuse a stored result's series); "
            "or expr+inputs for math, e.g. expr='((a+b)/2)**2', "
            "inputs={'a':'r1','b':'r2:car'}. Use this for comparisons "
            "(two runs as two series), transformed plots and chart edits."),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "x_title": {"type": "string"},
                        "y_title": {"type": "string"},
                        "y_log": {"type": "boolean"},
                        "stacked": {"type": "boolean"},
                        "series": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "type": {"type": "string",
                                             "enum": ["bar", "line",
                                                      "scatter", "area"]},
                                    "x": {"type": "array", "items": {}},
                                    "y": {"type": "array",
                                          "items": {"type": "number"}},
                                    "source": {"type": "string"},
                                    "source_series": {"type": "string"},
                                    "expr": {"type": "string"},
                                    "inputs": {"type": "object",
                                               "properties": {}},
                                },
                                "required": ["name"],
                            },
                        },
                    },
                    "required": ["series"],
                },
            },
            "required": ["spec"],
        },
    },
    {
        "name": "get_result",
        "description": ("Fetch a stored result (r1, r2, ...) with its full "
                        "data — use before editing or transforming a chart."),
        "input_schema": {"type": "object",
                         "properties": {"id": {"type": "string"}},
                         "required": ["id"]},
    },
    {
        "name": "list_results",
        "description": "List the results stored in this conversation.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

_UI_MODULES = ["Choropleth", "Network", "Volumes", "Transit", "TransitVolumes",
               "Destination", "VolumeFlow", "NodeFlows", "LinkSpeeds",
               "ZoneFlows", "PolygonTrips"]
_UI_ACTIONS = {
    "open_module": {"module"},
    "close_module": set(),
    "select_canton": {"canton"},
    "set_time_range": {"from_hour", "to_hour"},
    "set_network_modes": {"modes"},
    "set_dataset": {"dataset_id"},
    "fly_to": {"lon", "lat", "zoom"},
    "reset_view": set(),
    "start_draw": set(),        # put the map into polygon-draw mode
    "clear_drawn": set(),       # remove drawn polygons
    # Dashboard surface: pin the most recent chart as a tile / remove one
    "add_tile": {"title"},
    "remove_tile": {"index"},
}

_UI_TOOL_SPEC = {
    "name": "ui_action",
    "description": (
        "Operate the webmap UI for the user — like clicking. Actions: "
        "open_module (module: " + "|".join(_UI_MODULES) + "), close_module, "
        "select_canton (canton name), set_time_range (from_hour/to_hour "
        "0-24), set_network_modes (modes list or ['all']), set_dataset "
        "(dataset_id), fly_to (lon/lat/zoom), reset_view, start_draw (puts "
        "the map into polygon-draw mode so the user can sketch an area), "
        "clear_drawn (removes drawn polygons); on the DASHBOARD "
        "also add_tile (pins the chart you rendered LAST as a dashboard "
        "tile; render_chart first, then add_tile) and remove_tile "
        "(index, 1-based as shown on the tiles). Call when the user asks "
        "to open/show a module, filter, zoom, switch dataset or manage "
        "dashboard tiles. You may chain several actions."),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": sorted(_UI_ACTIONS)},
            "params": {
                "type": "object",
                "properties": {
                    "module": {"type": "string", "enum": _UI_MODULES},
                    "canton": {"type": "string"},
                    "from_hour": {"type": "number"},
                    "to_hour": {"type": "number"},
                    "modes": {"type": "array", "items": {"type": "string"}},
                    "dataset_id": {"type": "integer"},
                    "lon": {"type": "number"},
                    "lat": {"type": "number"},
                    "zoom": {"type": "number"},
                },
            },
        },
        "required": ["action"],
    },
}


def _ui_action_tool(action: str, params: dict | None = None) -> dict:
    params = params or {}
    if action not in _UI_ACTIONS:
        raise ValueError(f"unknown action '{action}'. Actions: "
                         + ", ".join(sorted(_UI_ACTIONS)))
    unknown = set(params) - _UI_ACTIONS[action]
    if unknown:
        raise ValueError(f"action '{action}' does not take {sorted(unknown)} "
                         f"(allowed: {sorted(_UI_ACTIONS[action])})")
    if action == "open_module" and params.get("module") not in _UI_MODULES:
        raise ValueError(f"unknown module. Modules: {', '.join(_UI_MODULES)}")
    return {"reply": f"Done - {action.replace('_', ' ')} executed.",
            "display": {"type": "ui_action", "action": action, "params": params}}


# Custom-simulation tools. The flat operation schema mirrors the broker's
# ScenarioDiff DSL; the broker's Pydantic validation is the authority and
# its 422 details feed the agent's self-correction.
_SIM_OP_SCHEMA = {
    "type": "object",
    "properties": {
        "op": {"type": "string",
               "enum": ["modify_links", "close_links", "remove_links",
                        "add_node", "add_link", "remove_transit_lines",
                        "scale_transit_frequency",
                        "scale_transit_vehicle_capacity"]},
        "select": {"type": "object", "properties": {
            "link_ids": {"type": "array", "items": {"type": "string"}},
            "line_ids": {"type": "array", "items": {"type": "string"}},
            "filter": {"type": "object", "properties": {
                "road_type_in": {"type": "array", "items": {"type": "string"}},
                "modes_any": {"type": "array", "items": {"type": "string"}},
                "freespeed_kmh": {"type": "object", "properties": {
                    "gte": {"type": "number"}, "lte": {"type": "number"}}},
                "capacity": {"type": "object", "properties": {
                    "gte": {"type": "number"}, "lte": {"type": "number"}}},
                "polygon": {"type": "array",
                            "items": {"type": "array",
                                      "items": {"type": "number"}}},
                "mode_in": {"type": "array", "items": {"type": "string"}},
                "name_contains": {"type": "string"},
            }},
        }},
        "set": {"type": "object", "properties": {
            "freespeed_kmh": {"type": "number"},
            "capacity": {"type": "number"},
            "lanes": {"type": "number"},
            "modes": {"type": "array", "items": {"type": "string"}}}},
        "scale": {"type": "object", "properties": {
            "freespeed": {"type": "number"},
            "capacity": {"type": "number"},
            "lanes": {"type": "number"}}},
        "factor": {"type": "number"},
        "node_id": {"type": "string"},
        "lon": {"type": "number"}, "lat": {"type": "number"},
        "link_id": {"type": "string"},
        "from_node": {"type": "string"}, "to_node": {"type": "string"},
        "freespeed_kmh": {"type": "number"}, "capacity": {"type": "number"},
        "lanes": {"type": "number"},
        "modes": {"type": "array", "items": {"type": "string"}},
        "length_m": {"type": "number"},
        "bidirectional": {
            "type": "boolean",
            "description": "add_link: MUST reflect what the user said - "
                           "ask them if unstated (false = one-way only)"},
    },
    "required": ["op"],
}

_SIM_TOOL_SPECS = [
    {
        "name": "propose_simulation",
        "description": (
            "Propose a CUSTOM SIMULATION RUN: a scenario diff on the current "
            "base dataset (close/remove/modify/add road links, edit transit "
            "lines) plus run parameters. This only CREATES A PROPOSAL - "
            "nothing runs until the user explicitly approves and you call "
            "confirm_simulation. Find link ids via run_sql/map first. "
            "Prefer close_links over remove_links (safer); removing links "
            "used by transit is rejected."),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string",
                          "description": "short scenario name, e.g. "
                                         "'No Hardbruecke'"},
                "operations": {"type": "array", "items": _SIM_OP_SCHEMA},
                "iterations": {"type": "integer", "minimum": 1,
                               "maximum": 200},
                "random_seed": {"type": "integer"},
            },
            "required": ["title", "operations"],
        },
    },
    {
        "name": "confirm_simulation",
        "description": (
            "Start a proposed simulation job. ONLY call this after the user "
            "EXPLICITLY approved in their own message (e.g. 'yes, run it') "
            "AFTER seeing the proposal - never in the same turn you "
            "proposed, never on your own initiative."),
        "input_schema": {"type": "object",
                         "properties": {"job_id": {"type": "integer"}},
                         "required": ["job_id"]},
    },
    {
        "name": "simulation_status",
        "description": ("Status of the user's simulation jobs. With job_id: "
                        "that job (phase, progress, result dataset); "
                        "without: list recent jobs."),
        "input_schema": {"type": "object",
                         "properties": {"job_id": {"type": "integer"}}},
    },
    {
        "name": "cancel_simulation",
        "description": "Cancel a proposed/queued/running simulation job.",
        "input_schema": {"type": "object",
                         "properties": {"job_id": {"type": "integer"}},
                         "required": ["job_id"]},
    },
]

_SIM_PROMPT = """
CUSTOM SIMULATIONS: you can propose what-if runs (propose_simulation) that
modify the scenario and re-run MATSim. Rules:
- Identify link ids first (run_sql on network_links, or the user's map
  selection); show them with show_links so the user SEES what changes.
- close_links = safe road closure (traffic reroutes). remove_links only
  when the user insists on physical deletion.
- Transit edits: remove_transit_lines, scale_transit_frequency (2 =
  double service), scale_transit_vehicle_capacity.
- A proposal is NOT a started run. Present the returned summary + cost
  estimate and ASK the user to approve. Call confirm_simulation ONLY
  after an explicit yes in a LATER user message. Never auto-confirm.
- Results appear as a new private dataset of the user (status via
  simulation_status); compare it with the base via the usual tools.
- NEVER fill in scenario parameters the user did not state. If required
  information is missing, say exactly WHAT is missing and ask — do not
  propose. In particular for add_link: you need BOTH endpoints (existing
  node ids, or new nodes with coordinates via add_node) AND whether the
  road is one-way or bidirectional — the DSL default is one-way, so a
  guessed direction silently builds the wrong road. If the user left
  speed/capacity/lanes open, either ask or state the defaults you would
  use (50 km/h, 1000 veh/h, 1 lane) in the proposal text and let them
  object BEFORE confirming. The same applies everywhere: an ambiguous
  selection ("the bridge" matching several links), an unclear factor, an
  unstated scope — ask first, propose second.
"""

_SIM_GATE_ON = """
- The user opted in with /sim, so proposing is allowed — but only propose
  once you are SURE what they want simulated. If the request is vague or
  incomplete, ask instead of proposing.
"""

_SIM_GATE_OFF = """
- Proposing NEW simulation runs is DISABLED for this message: runs are
  expensive and must be requested deliberately. If the user asks for a
  what-if run, do NOT try to propose — explain that they should resend
  the request as a message starting with /sim (e.g. "/sim close the
  Hardbruecke and rerun"). Checking status, confirming an EXISTING
  proposal and cancelling remain available.
"""

_SIM_TOOL_SPECS_NO_PROPOSE = [s for s in _SIM_TOOL_SPECS
                              if s["name"] != "propose_simulation"]


def _sim_tool(name: str, args: dict, token: str,
              current_dataset: int | None) -> dict:
    from . import sim_client
    if name == "propose_simulation":
        diff = {"base_dataset_id": current_dataset,
                "title": args.get("title") or "Custom run",
                "operations": args.get("operations") or [],
                "params": {k: v for k, v in {
                    "iterations": args.get("iterations"),
                    "random_seed": args.get("random_seed"),
                }.items() if v is not None}}
        job = sim_client.propose(token, diff)
        return {"reply": f"Proposal {job['job_id']} created (not started).",
                "display": {"type": "sim_proposal", **job}}
    if name == "confirm_simulation":
        job = sim_client.confirm(token, int(args["job_id"]))
        return {"reply": f"Simulation job {job['job_id']} queued.",
                "display": {"type": "sim_job", **job}}
    if name == "cancel_simulation":
        job = sim_client.cancel(token, int(args["job_id"]))
        return {"reply": f"Job {job['job_id']} is now {job['status']}.",
                "display": {"type": "sim_job", **job}}
    # simulation_status
    if args.get("job_id") is not None:
        job = sim_client.job_status(token, int(args["job_id"]))
        return {"reply": f"Job {job['job_id']}: {job['status']} "
                         f"({job.get('phase') or '-'}, "
                         f"{round((job.get('progress') or 0) * 100)}%).",
                "display": {"type": "sim_job", **job}}
    jobs = sim_client.list_jobs(token).get("jobs", [])
    if not jobs:
        return {"reply": "No simulation jobs yet.", "display": {"type": "chat"}}
    rows = [[j["job_id"], j["title"], j["status"],
             f"{round((j.get('progress') or 0) * 100)}%",
             j.get("result_dataset_id") or "-"] for j in jobs[:20]]
    return {"reply": f"{len(jobs)} simulation job(s):",
            "display": {"type": "table",
                        "columns": ["job", "title", "status", "progress",
                                    "result dataset"],
                        "rows": rows}}


_SIM_TOOL_NAMES = ("propose_simulation", "confirm_simulation",
                   "simulation_status", "cancel_simulation")


_CHART_PROMPT = """
Result registry: every chart/table produced by a tool is stored under an id
(you see "[stored as rX]" in the result — ONLY results marked that way
exist in the registry). fetch_data endpoint results are NOT stored: to
chart those, pass their values INLINE to render_chart (series with x +
y arrays) instead of referencing an rX id. render_chart lets you compose
free-form charts from stored results; charts you render are stored too.
Inline series example: {"name": "Synthetic", "type": "bar",
"x": ["car", "pt", "walk"], "y": [0.39, 0.13, 0.30]} — x carries the
labels, y contains ONLY numbers. To EDIT an
existing chart ("make it logarithmic", "add run 2 as second series"):
get_result(its id), then render_chart with the modified spec. For
comparisons put multiple series into ONE chart. Element-wise math in expr
supports + - * / ** and sqrt/log/log10/exp/abs.
"""


def _render_chart_tool(convo_id: str, spec: dict) -> dict:
    from . import convo_store
    from .charts import ChartSpec, resolve_chart
    parsed = ChartSpec.model_validate(spec)
    display = resolve_chart(parsed, lambda rid: convo_store.get(convo_id, rid))
    return {"reply": f"Chart '{parsed.title or 'untitled'}' rendered.",
            "display": display}


def _get_result_tool(convo_id: str, id: str) -> dict:
    from . import convo_store
    entry = convo_store.get(convo_id, id)
    if entry is None:
        raise ValueError(f"unknown result '{id}' - call list_results")
    return entry


def _display_to_store(display: dict) -> tuple[str, dict] | None:
    """Extract storable series data from a tool display payload."""
    t = display.get("type")
    if t == "chart" and display.get("traces"):
        x = display["traces"][0].get("x") or []
        return ("chart", {"x": x, "series": {
            tr.get("name") or f"s{i}": tr.get("y") or []
            for i, tr in enumerate(display["traces"])}})
    if t == "chart" and display.get("labels"):
        name = (display.get("metric") or display.get("title") or "value")
        return ("chart", {"x": display["labels"],
                          "series": {str(name): display.get("values") or []}})
    if t == "table" and display.get("rows"):
        return ("table", {"columns": display.get("columns") or [],
                          "rows": display.get("rows")[:200]})
    return None


def _augment_specs_for_datasets(specs: list[dict]) -> list[dict]:
    """Add an optional 'dataset' parameter to every tool so the agent can
    query OTHER runs the user may access (cross-run comparisons)."""
    out = []
    for spec in specs:
        schema = dict(spec["input_schema"])
        props = dict(schema.get("properties") or {})
        props["dataset"] = {
            "type": "integer",
            "description": "optional: run this call against another dataset "
                           "ID from list_datasets (default: the current one)",
        }
        schema["properties"] = props
        out.append({**spec, "input_schema": schema})
    out.append({
        "name": "list_datasets",
        "description": ("List all datasets/runs the user may access (own, "
                        "public, shared) with their IDs — call this before "
                        "comparing datasets."),
        "input_schema": {"type": "object", "properties": {}},
    })
    return out


def _ui_state_block(ui_state: dict | None) -> str:
    """Compact description of what the user currently sees, whitelisted key
    by key (the frontend sends it with every question). Lets the agent
    resolve "here" / "this view" / "what I'm looking at" and pick
    ui_actions that fit the current surface."""
    if not isinstance(ui_state, dict):
        return ""

    def s(v, n=60):
        return str(v)[:n]

    lines = [f"- surface: {s(ui_state.get('surface') or 'webmap', 16)}"]
    if ui_state.get("module"):
        lines.append(f"- open module: {s(ui_state['module'])}")
    if ui_state.get("canton"):
        lines.append(f"- selected canton: {s(ui_state['canton'])}")
    tr = ui_state.get("time_range")
    if isinstance(tr, (list, tuple)) and len(tr) == 2:
        try:
            lo, hi = float(tr[0]), float(tr[1])
            if (lo, hi) != (0.0, 24.0):
                lines.append(f"- time filter: {lo:g}-{hi:g} h")
        except (TypeError, ValueError):
            pass
    modes = ui_state.get("network_modes")
    if isinstance(modes, list) and modes and modes != ["all"]:
        lines.append("- network mode filter: "
                     + ", ".join(s(m, 20) for m in modes[:8]))
    center = ui_state.get("center")
    if (isinstance(center, (list, tuple)) and len(center) == 2
            and ui_state.get("zoom") is not None):
        try:
            lines.append(f"- viewport: lon {float(center[0]):.3f}, "
                         f"lat {float(center[1]):.3f}, "
                         f"zoom {float(ui_state['zoom']):.1f}")
        except (TypeError, ValueError):
            pass
    if ui_state.get("tiles") is not None:
        try:
            lines.append(f"- AI dashboard tiles pinned: {int(ui_state['tiles'])}")
        except (TypeError, ValueError):
            pass
    return ("\nCURRENT UI STATE (what the user sees right now; your "
            "ui_action calls change it):\n" + "\n".join(lines)
            + "\nInterpret 'here', 'this view', 'what I see' against this "
              "state.\n")


def run_agent(question: str, history: list[dict],
              current_dataset: int | None = None,
              resolve_dataset=None, list_datasets=None,
              conversation_id: str | None = None,
              has_polygon: bool = False,
              ui_state: dict | None = None,
              emit=None, is_cancelled=None,
              sim_token: str | None = None,
              sim_propose: bool = False) -> dict:
    """Blocking; call via asyncio.to_thread. Returns
    {reply, display, displays, steps} — 'display' stays for compatibility
    with the previous single-shot response shape.

    Live progress: pass *emit(event)* and the loop reports itself while it
    runs — {"type": "turn"} before every LLM call (consumers reset their
    provisional text), {"type": "delta", "text"} for answer tokens,
    {"type": "step"} / {"type": "step_done", "step"} around every tool
    call, {"type": "display", "display"} for each visual payload. The
    return value is unchanged, so callers without *emit* behave exactly as
    before. *is_cancelled()* is polled between turns, tool calls and
    stream chunks — the Stop button.

    Cross-dataset support: *resolve_dataset(id) -> root* (sync, raises if
    the user may not access it) and *list_datasets() -> list* let the agent
    run any tool against another run and compare results. Without the
    callbacks the agent is confined to the current dataset.

    *ui_state* is the frontend's snapshot of what the user currently sees
    (surface, open module, filters, viewport) — folded into the system
    prompt so "here"/"this view" resolve against it."""
    question = (question or "").strip()
    if not question:
        return {"reply": "Please enter a question.",
                "display": {"type": "chat"}, "error": True}
    if not _llm.is_configured():
        return {"reply": "The AI feature is not configured.",
                "display": {"type": "chat"}, "error": True}

    streaming = emit is not None
    emit = emit or (lambda ev: None)
    cancelled = is_cancelled or (lambda: False)

    try:
        sys_prompt = _agent_system_prompt()
    except Exception as exc:
        logger.warning("agent vocab failed: %s", exc)
        return {"reply": f"The dataset could not be read: {exc}",
                "display": {"type": "chat"}, "error": True}

    specs = ai_tools.tool_specs()
    if conversation_id:
        specs = specs + _CHART_TOOL_SPECS + [_UI_TOOL_SPEC]
        sys_prompt += _CHART_PROMPT
        sys_prompt += ("\nui_action operates the webmap UI (open modules, "
                       "select canton, filters, zoom). Use it when the user "
                       "asks to open/show a UI view rather than data.\n")
        if has_polygon:
            sys_prompt += (
                "\nThe user HAS DRAWN a polygon on the map. Questions about "
                "'this area/region/polygon' refer to it: use the TripFilter "
                "booleans touches_drawn (starts OR ends inside), "
                "origin_in_drawn, dest_in_drawn. 'Trips within the area' = "
                "origin_in_drawn AND dest_in_drawn both true.\n")
        else:
            sys_prompt += (
                "\nNo polygon is drawn on the map. If the user asks about "
                "'this area', offer to start draw mode (ui_action "
                "start_draw) so they can sketch one, then ask again.\n")
    if sim_token:
        from . import sim_client
        if sim_client.available():
            # propose_simulation exists only for /sim-prefixed messages —
            # runs are expensive, so proposing needs that explicit opt-in.
            specs = specs + (_SIM_TOOL_SPECS if sim_propose
                             else _SIM_TOOL_SPECS_NO_PROPOSE)
            sys_prompt += _SIM_PROMPT
            sys_prompt += _SIM_GATE_ON if sim_propose else _SIM_GATE_OFF
    if resolve_dataset is not None:
        specs = _augment_specs_for_datasets(specs)
        sys_prompt += f"""
Cross-dataset comparisons: you are currently on dataset {current_dataset}.
The user may have access to other runs (list_datasets shows them). Pass
dataset=<id> on any tool call to query another run. IMPORTANT: datasets can
have different sample_rates (check dataset_info per dataset) — always
compare population-SCALED values, never raw sample counts, and say so.
The vocabulary above describes the CURRENT dataset; other runs may differ.
"""
    sys_prompt += _ui_state_block(ui_state)
    sys_prompt += ("\nFINAL REMINDERS: respond in ENGLISH only (even to "
                   "German questions). Prefer charts/tables over prose "
                   "number lists.\n")

    messages: list[dict] = []
    for m in (history or [])[-6:]:
        if m.get("role") in ("user", "model") and m.get("text"):
            role = "assistant" if m["role"] == "model" else "user"
            messages.append({"role": role, "text": m["text"]})
    messages.append({"role": "user", "text": question})

    displays: list[dict] = []
    steps: list[dict] = []
    last_text = None
    was_cancelled = False

    def _llm_turn(turn_specs: list[dict]) -> dict:
        """One LLM turn — streamed when a live consumer is attached."""
        if not streaming:
            return _llm.chat_with_tools(sys_prompt, messages, turn_specs)
        try:
            return _llm.chat_with_tools_stream(
                sys_prompt, messages, turn_specs,
                on_delta=lambda t: emit({"type": "delta", "text": t}),
                cancelled=cancelled)
        except _llm.LLMCancelled:
            raise
        except _llm.LLMError as exc:
            # Stream hiccup (connection drop, empty streamed response):
            # retry the turn blocking; tell consumers to discard any
            # half-emitted text first.
            logger.info("agent stream turn failed (%s) - blocking retry", exc)
            ai_log.log_failure("llm_stream_retry", error=str(exc),
                               convo=conversation_id)
            emit({"type": "turn"})
            return _llm.chat_with_tools(sys_prompt, messages, turn_specs)

    for _ in range(MAX_STEPS):
        if cancelled():
            was_cancelled = True
            break
        emit({"type": "turn"})
        try:
            reply = _llm_turn(specs)
        except _llm.LLMCancelled:
            was_cancelled = True
            break
        except _llm.LLMError as exc:
            logger.warning("agent LLM error: %s", exc)
            ai_log.log_failure("llm_error", error=str(exc), question=question,
                               convo=conversation_id)
            return {"reply": f"The AI service is currently unavailable ({exc}).",
                    "display": {"type": "chat"}, "error": True,
                    "steps": steps, "displays": displays}

        if reply.get("text"):
            last_text = reply["text"]
        calls = reply.get("tool_calls") or []
        if not calls:
            break

        messages.append({"role": "assistant", "text": reply.get("text"),
                         "tool_calls": calls})
        for call in calls:
            if cancelled():
                was_cancelled = True
                break
            name, args = call["name"], dict(call.get("args") or {})

            # Cross-dataset dispatch: an optional dataset arg reroutes this
            # single call to another run (grant-checked by resolve_dataset).
            other_ds = args.pop("dataset", None) if resolve_dataset else None
            if other_ds is not None and int(other_ds) == (current_dataset or -1):
                other_ds = None                      # explicit current = no-op

            if name == "list_datasets" and list_datasets is not None:
                fn = lambda: list_datasets()         # noqa: E731
            elif conversation_id and name == "render_chart":
                fn = (lambda spec:                    # noqa: E731
                      _render_chart_tool(conversation_id, spec))
            elif conversation_id and name == "get_result":
                fn = (lambda id:                      # noqa: E731
                      _get_result_tool(conversation_id, id))
            elif conversation_id and name == "list_results":
                from . import convo_store
                fn = (lambda: {"results":             # noqa: E731
                               convo_store.list_results(conversation_id)})
            elif conversation_id and name == "ui_action":
                fn = _ui_action_tool
            elif sim_token and name in _SIM_TOOL_NAMES:
                if name == "propose_simulation" and not sim_propose:
                    # tool wasn't offered this turn; refuse even if called
                    fn = (lambda **kw: (_ for _ in ()).throw(ValueError(
                        "proposing runs requires a message starting "
                        "with /sim")))
                else:
                    fn = (lambda __n=name, **kw:          # noqa: E731
                          _sim_tool(__n, kw, sim_token, current_dataset))
            else:
                fn = ai_tools.TOOL_FUNCS.get(name)
            step = {"tool": name, "detail": _args_brief(name, args), "ok": True}
            if other_ds is not None:
                step["detail"] = f"dataset {other_ds}: {step['detail']}".rstrip(": ")
            emit({"type": "step", "step": dict(step)})
            if fn is None:
                result_text = f"error: unknown tool '{name}'"
                step["ok"] = False
                step["error"] = result_text
                ai_log.log_failure("tool_error", tool=name,
                                   error="unknown tool", question=question,
                                   convo=conversation_id)
            else:
                try:
                    if other_ds is not None:
                        from .paths import dataset_root_path, set_root_override
                        home_root = dataset_root_path()
                        set_root_override(resolve_dataset(int(other_ds)))
                        try:
                            result = fn(**args)
                        finally:
                            set_root_override(home_root)
                    else:
                        result = fn(**args)
                    display = result.get("display") if isinstance(result, dict) else None
                    result_text = (_summarize_for_llm(result)
                                   if isinstance(result, dict)
                                   else json.dumps(result, default=str)[:LLM_RESULT_CHARS])
                    # Register chart/table data in the conversation's result
                    # registry so follow-ups can reference/transform it.
                    if conversation_id and isinstance(display, dict):
                        payload = _display_to_store(display)
                        if payload:
                            from . import convo_store
                            rid = convo_store.put(
                                conversation_id, payload[0],
                                f"{name}: {step['detail']}", payload[1])
                            if rid:
                                display["result_id"] = rid
                                result_text += f"\n[stored as {rid}]"
                    # ui_action displays are tiny AND order-critical (e.g.
                    # add_tile after render_chart) — never drop them; cap
                    # only the heavy visual payloads.
                    if (isinstance(display, dict)
                            and display.get("type") not in (None, "chat")
                            and (display.get("type") == "ui_action"
                                 or len(displays) < MAX_DISPLAYS)):
                        displays.append(display)
                        emit({"type": "display", "display": display})
                except Exception as exc:                # validation/SQL/runtime
                    result_text = f"error: {exc}"
                    step["error"] = str(exc)[:200]
                    if "float_parsing" in str(exc) or "int_parsing" in str(exc):
                        result_text += (
                            "\nHint: every series.y element must be a NUMBER. "
                            "Rebuild y from the numeric VALUES in the tool "
                            "result (the share/count figures) — never put "
                            "field names like 'share' into y; labels belong "
                            "in x. Fix the spec and retry render_chart.")
                    elif "extra_forbidden" in str(exc):
                        result_text += (
                            "\nHint: you used a field that does not exist. "
                            "Numeric ranges use gte/lte (not min/max). "
                            "Valid Output fields: type, metric, group_by "
                            "(hour|mode|purpose|origin_canton|dest_canton|"
                            "age_group|income_class), hour_bin, order_by, "
                            "order_dir, limit. Fix the call and retry the "
                            "SAME tool.")
                    step["ok"] = False
                    logger.info("agent tool %s failed: %s", name, exc)
                    ai_log.log_failure("tool_error", tool=name,
                                       detail=step["detail"],
                                       error=str(exc), question=question,
                                       convo=conversation_id)
            steps.append(step)
            emit({"type": "step_done", "step": dict(step)})
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "name": name, "result": result_text})
        if was_cancelled:
            break

    else:
        ai_log.log_failure("step_limit", question=question,
                           convo=conversation_id,
                           tools=",".join(st["tool"] for st in steps[-10:]))
        # Step limit exhausted mid-plan: force ONE final synthesis turn so
        # the user gets an answer from the gathered data instead of a
        # dangling "First, I'll ..." announcement.
        messages.append({"role": "user", "text": (
            "Step limit reached - no more tool calls are possible. Give your "
            "FINAL answer now from the results above. If something is "
            "missing, state plainly what you found and what you could not "
            "determine. Do NOT announce further actions.")})
        try:
            emit({"type": "turn"})
            final = _llm_turn([])
            if final.get("text"):
                last_text = final["text"]
        except _llm.LLMCancelled:
            was_cancelled = True
        except _llm.LLMError as exc:
            logger.warning("agent synthesis turn failed: %s", exc)

    if was_cancelled and not last_text:
        last_text = "Stopped."

    reply_text = (last_text or
                  "I could not finish answering this within the step limit - "
                  "try a more specific question.")
    # Backward-compatible primary display: the last visual, else chat
    display = displays[-1] if displays else {"type": "chat"}
    out = {"reply": reply_text, "display": display,
           "displays": displays, "steps": steps}
    if was_cancelled:
        out["cancelled"] = True
    return out
