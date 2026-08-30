"""Natural-language querying ("Ask AI").

Flow: question text → LLM (Gemini) returns a JSON query plan → Pydantic
validates it (the LLM is untrusted input; THIS is the security boundary) →
the plan is executed against the dataset's read-only DuckDB / transit assets
and shaped for one of the displays: chat answer, table, bar chart, a map
layer, or a location marker. Only the QUESTION and the schema vocabulary
ever reach the LLM — never the data itself.

Three query families the LLM can choose from:
  plan    — trip-level queries (trips × persons × households × routes)
  transit — line/stop questions answered from boarding_data_by_line
  locate  — "show me <place>" (transit stations, then gemeinde/canton names)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError

from . import _llm
from .connection import get_source_cursor
from .constants import CANTON_MAP, canton_name
from .helpers import load_static_asset, resolve_canton_to_polygon_id
from .paths import dataset_key

logger = logging.getLogger(__name__)

# WKT (WGS84) of the polygon the user has drawn on the map, scoped to the
# current request like the dataset root. Set by main.py; consumed by
# _compile for the *_in_drawn trip filters.
from contextvars import ContextVar
_user_polygon: ContextVar[str | None] = ContextVar("_user_polygon", default=None)


def set_user_polygon(wkt: str | None) -> None:
    _user_polygon.set(wkt)


MAX_TABLE_ROWS = 200
# Country-wide car queries traverse ~700k distinct links. Full geometry is ~85 MB
# raw, but GeoJSON gzips ~7x (the proxy gzips responses), so 80k links is only
# ~1.9 MB over the wire and covers essentially the whole meaningful network
# (links used by ≥~70 trips) — continuous, no gaps in the arterial network.
MAX_MAP_LINKS = 80000
MAX_MAP_OD = 2000

# ─── The DSL (what the LLM is allowed to ask for) ───────────────────────
#
# extra="forbid" on every model: a mistyped field name (e.g. "mode" instead
# of "modes") must FAIL validation so the LLM can self-correct — silently
# ignoring it would drop the filter and return a wrong-but-plausible number.


class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


class NumRange(_Strict):
    """Numeric range. Field names are gte/lte — NOT min/max."""
    gte: Optional[float] = Field(default=None, description="minimum (>=)")
    lte: Optional[float] = Field(default=None, description="maximum (<=)")


class PersonFilter(_Strict):
    age: Optional[NumRange] = None
    sex: Optional[Literal["male", "female"]] = None
    employed: Optional[bool] = None
    has_driving_license: Optional[bool] = None
    car_availability: Optional[Literal["always", "sometimes", "never"]] = None
    has_subscription: Optional[list[Literal[
        "ga", "halbtax", "verbund", "strecke", "gleis7", "junior", "other"]]] = None
    home_place: Optional[str] = None    # canton / district / municipality name


class HouseholdFilter(_Strict):
    income_class: Optional[list[str]] = None
    n_cars_class: Optional[list[str]] = None
    ovgk: Optional[list[str]] = None


class TripFilter(_Strict):
    modes: Optional[list[str]] = None
    exclude_modes: Optional[list[str]] = None
    purpose_to: Optional[list[str]] = None
    purpose_from: Optional[list[str]] = None
    depart_hour: Optional[NumRange] = None          # 0–24
    travel_time_min: Optional[NumRange] = None
    network_distance_km: Optional[NumRange] = None
    detour_factor: Optional[NumRange] = None        # network / crowfly
    origin_place: Optional[str] = None    # canton / district / municipality name
    dest_place: Optional[str] = None      # canton / district / municipality name
    # User-drawn polygon on the map (geometry arrives out-of-band, never
    # through the LLM): filter by trip endpoints relative to the drawn area.
    origin_in_drawn: Optional[bool] = None   # trip starts inside
    dest_in_drawn: Optional[bool] = None     # trip ends inside
    touches_drawn: Optional[bool] = None     # starts OR ends inside


class RouteFilter(_Strict):
    via_place: Optional[list[str]] = None    # canton / district / municipality names
    via_road_type: Optional[list[str]] = None


class Output(_Strict):
    type: Literal["number", "table", "chart", "map"] = "number"
    metric: Literal["count", "count_persons", "avg_travel_time_min", "avg_distance_km",
                    "avg_speed_kmh", "sum_person_km", "mode_share"] = "count"
    group_by: Optional[Literal["hour", "mode", "purpose", "origin_canton",
                               "dest_canton", "age_group", "income_class"]] = None
    hour_bin: int = Field(default=1, ge=1, le=12)   # bucket size for group_by=hour
    # Sorting — for superlatives ("longest/fastest/shortest trip"): type=table,
    # order_by the field, order_dir desc/asc, limit small (1 for "the longest").
    order_by: Optional[Literal["network_distance_km", "travel_time_min",
                               "depart_hour", "speed_kmh"]] = None
    order_dir: Literal["asc", "desc"] = "desc"
    limit: int = Field(default=1000, ge=1, le=5000)


class QueryPlan(_Strict):
    person: PersonFilter = PersonFilter()
    household: HouseholdFilter = HouseholdFilter()
    trip: TripFilter = TripFilter()
    route: RouteFilter = RouteFilter()
    output: Output = Output()


class TransitQuery(_Strict):
    """Questions about transit LINES and STOPS (boarding data)."""
    kind: Literal["count_lines", "line_boardings", "stop_boardings", "top_lines", "top_stops"]
    mode: Optional[str] = None          # bus, tram, rail, …
    canton: Optional[str] = None
    line_name: Optional[str] = None     # e.g. "80", "S11", "31"
    stop_name: Optional[str] = None     # e.g. "Bucheggplatz"
    top_n: int = Field(default=10, ge=1, le=30)
    output: Literal["number", "chart", "table"] = "number"


class LocateQuery(_Strict):
    name: str


class LLMReply(_Strict):
    """Top-level object the LLM must return (exactly one field set)."""
    plan: Optional[QueryPlan] = None
    transit: Optional[TransitQuery] = None
    locate: Optional[LocateQuery] = None
    clear_map: Optional[bool] = None
    title: str = ""
    refuse_reason: Optional[str] = None


# ─── Per-dataset vocabulary for the system prompt ────────────────────────

_vocab_cache: dict[str, dict] = {}


def _boarding_lines() -> list:
    from .boarding_data import BoardingDataProvider
    return BoardingDataProvider()._load()


def _dataset_vocab() -> dict:
    dk = dataset_key()
    if dk in _vocab_cache:
        return _vocab_cache[dk]
    con = get_source_cursor("synthetic")

    def distinct(sql):
        try:
            return sorted(str(r[0]) for r in con.execute(sql).fetchall() if r[0] is not None)
        except Exception:
            return []

    vocab = {
        "modes": distinct("SELECT DISTINCT main_mode FROM trips"),
        "purposes": distinct("SELECT DISTINCT following_purpose FROM trips"),
        "income_classes": distinct("SELECT DISTINCT income_class FROM households"),
        "n_cars_classes": distinct("SELECT DISTINCT n_cars_class FROM households"),
        "ovgk": distinct("SELECT DISTINCT ovgk FROM households"),
        "road_types": distinct(
            "SELECT DISTINCT road_type FROM network_links WHERE road_type IS NOT NULL LIMIT 40"),
        "transit_modes": [],
        "sample_rate": None,
    }
    try:
        vocab["transit_modes"] = sorted({l.get("vehicle") for l in _boarding_lines()
                                         if l.get("vehicle")})
    except Exception:
        pass
    try:
        meta = load_static_asset("synthetic", "metadata") or {}
        vocab["sample_rate"] = meta.get("sample_rate")
    except Exception:
        pass
    _vocab_cache[dk] = vocab
    return vocab


def _system_prompt(vocab: dict) -> str:
    cantons = ", ".join(CANTON_MAP.values())
    plan_schema = json.dumps(QueryPlan.model_json_schema(), separators=(",", ":"))
    transit_schema = json.dumps(TransitQuery.model_json_schema(), separators=(",", ":"))
    return f"""You translate questions about a Swiss MATSim transport simulation into a JSON query.

Return ONLY a JSON object with EXACTLY ONE of these shapes:
1. {{"plan": <QueryPlan>, "title": "<short title>"}} — for questions about TRIPS/people/journeys.
2. {{"transit": <TransitQuery>, "title": "<short title>"}} — for questions about TRANSIT LINES or
   STOPS (how many bus lines, boardings on line 80, boardings at a station, busiest lines/stops).
3. {{"locate": {{"name": "<place>"}}}} — when the user wants to SEE/FIND a place: a station,
   municipality or canton ("show me Bucheggplatz", "where is Wipkingen", "show me Lucerne").
4. {{"clear_map": true}} — when the user wants to REMOVE/clear the drawn trips/marker from the map
   ("remove the trips", "clear the map", "entfern das wieder").
5. {{"refuse_reason": "<short English explanation>"}} — ONLY if truly unanswerable.

QueryPlan schema: {plan_schema}
TransitQuery schema: {transit_schema}

TransitQuery semantics:
- kind "count_lines": how many lines (filter by mode and/or canton).
- kind "line_boardings": total boardings of ONE line — set line_name (e.g. "80", "S11", "31");
  optionally canton and/or stop_name to narrow down. output "chart" → hourly profile.
- kind "stop_boardings": boardings/alightings at a stop/station — set stop_name.
- kind "top_lines"/"top_stops": busiest lines/stops (top_n), optionally per mode/canton → chart.

Vocabulary of THIS dataset (use these exact values):
- canton names: {cantons}
- trip modes: {vocab['modes']}
- transit line modes: {vocab['transit_modes']}
- trip purposes: {vocab['purposes']}
- household income_class values (ordered; 'highest' = last): {vocab['income_classes']}
- household n_cars_class values: {vocab['n_cars_classes']}
- ovgk (PT quality class of home, A=best): {vocab['ovgk']}
- road types: {vocab['road_types']}

Rules:
- The simulation covers ONE average workday. No weekday/season questions.
- "commute" → trip.purpose_to=["work"]. Shopping → ["shop"]. Leisure → ["leisure"].
- Output type for plans: "number" for figures/averages/shares, "chart" for breakdowns
  (set group_by), "map" when the user wants to SEE trips/routes on the map, "table" for lists.
- metric "count" counts TRIPS; metric "count_persons" counts UNIQUE PEOPLE ("how many people/
  wieviele Menschen…"). group_by "hour" supports hour_bin (e.g. 5 → 5-hour buckets).
- Superlatives ("which/what is the longest/shortest/fastest/slowest trip", "the 10 longest trips"):
  use output.type="table", set order_by (network_distance_km | travel_time_min | speed_kmh),
  order_dir ("desc" for longest/fastest, "asc" for shortest/slowest) and limit (1 for "the …", N
  for "the N …"). output.type="map" ALSO honours order_by+limit — so "show it/that one on the map"
  draws only those trip(s).
- FOLLOW-UPS: when the user says "show it/them/that/these on the map", "in der map", "zeig es mir",
  reuse ALL the filters AND order_by/order_dir/limit from your PREVIOUS query and only change
  output.type to "map". Do NOT drop the filters or the ordering (otherwise you'd draw every trip).
- PLACES: origin_place / dest_place / via_place / home_place accept a CANTON name (whole canton),
  a DISTRICT (Bezirk) name, or a MUNICIPALITY/CITY name (e.g. "Winterthur", "Uster", "Bülach").
  Many cities share a canton name — if the user means the CITY/municipality of Zürich/Bern/etc.,
  append "city" (e.g. "Zürich city") so it maps to the municipality, not the whole canton.
  "trips through Zürich city" → route.via_place=["Zürich city"]. Pass places as free text.
- route.via_place matches the driven route (car trips only).
- line_name and stop_name are free text — pass what the user said (e.g. "80", "Bucheggplatz").
- Titles and refuse_reason ALWAYS in English. Do not invent vocabulary values.
- NOT answerable (refuse): demographics of transit-line riders (who rides line X), exact
  addresses, anything outside this schema.
"""


# ─── Trip-plan compilation (DSL → SQL) ───────────────────────────────────


def _canton_id(name: str) -> Optional[int]:
    pid = resolve_canton_to_polygon_id(name or "")
    try:
        return int(pid.split(":", 1)[1]) if pid else None
    except (ValueError, IndexError):
        return None


_MUNI_WORDS = re.compile(r"\b(city|stadt|gemeinde|municipality|town|bezirk|district|of|the)\b")


def _resolve_place(name: str) -> Optional[dict]:
    """Resolve a place name to a canton (fast id filter) or a municipality/
    district polygon (spatial filter). 'Zurich' → whole canton; 'Zürich city'
    / 'Stadt Zürich' → the municipality; 'Uster', 'Winterthur' → municipality."""
    raw = (name or "").strip()
    if not raw:
        return None
    low = raw.lower()
    force_area = bool(_MUNI_WORDS.search(low))
    clean = _MUNI_WORDS.sub(" ", low)
    clean = re.sub(r"\s+", " ", clean).strip(" ,()")

    if not force_area:
        cid = _canton_id(raw)
        if cid is not None:
            return {"kind": "canton", "canton_id": cid, "label": canton_name(cid)}

    con = get_source_cursor("synthetic")
    row = con.execute(
        """SELECT polygon_id, polygon_type, polygon_name FROM hot_polygons
           WHERE polygon_type IN ('gemeinde','bezirk')
             AND (LOWER(polygon_name) = ? OR LOWER(polygon_name) LIKE ?)
           ORDER BY (polygon_type = 'gemeinde') DESC,
                    (LOWER(polygon_name) = ?) DESC, LENGTH(polygon_name)
           LIMIT 1""",
        [clean, f"{clean}%", clean]).fetchone()
    if row:
        return {"kind": row[1], "polygon_id": row[0], "label": row[2]}

    cid = _canton_id(raw)   # last resort
    if cid is not None:
        return {"kind": "canton", "canton_id": cid, "label": canton_name(cid)}
    return None


def _compile(plan: QueryPlan) -> tuple[str, list]:
    w, b = ["1=1"], []
    P, H, T, R = plan.person, plan.household, plan.trip, plan.route

    def rng(expr: str, r: Optional[NumRange]):
        if not r:
            return
        if r.gte is not None:
            w.append(f"{expr} >= ?"); b.append(r.gte)
        if r.lte is not None:
            w.append(f"{expr} <= ?"); b.append(r.lte)

    def inlist(expr: str, vals: Optional[list]):
        if vals:
            w.append(f"{expr} IN ({','.join('?' * len(vals))})"); b.extend(vals)

    rng("p.age", P.age)
    if P.sex is not None:
        w.append("p.sex = ?"); b.append(0 if P.sex == "male" else 1)
    if P.employed is not None:
        w.append("p.employed = ?"); b.append(P.employed)
    if P.has_driving_license is not None:
        w.append("p.has_driving_license = ?"); b.append(P.has_driving_license)
    if P.car_availability:
        w.append("p.car_availability = ?"); b.append(P.car_availability)
    for s in P.has_subscription or []:
        w.append(f"p.subscriptions_{s} = TRUE")
    if P.home_place:
        pl = _resolve_place(P.home_place)
        if pl is None:
            raise ValueError(f"unknown place: {P.home_place}")
        if pl["kind"] == "canton":
            w.append("p.canton_id = ?"); b.append(pl["canton_id"])
        else:  # municipality/district → spatial on home location
            w.append("ST_Within(p.home_pt, (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?))")
            b.append(pl["polygon_id"])

    inlist("h.income_class", H.income_class)
    inlist("h.n_cars_class", H.n_cars_class)
    inlist("h.ovgk", H.ovgk)

    inlist("t.main_mode", T.modes)
    if T.exclude_modes:
        w.append(f"t.main_mode NOT IN ({','.join('?' * len(T.exclude_modes))})")
        b.extend(T.exclude_modes)
    inlist("t.following_purpose", T.purpose_to)
    inlist("t.preceding_purpose", T.purpose_from)
    rng("t.departure_time / 3600.0", T.depart_hour)
    rng("t.travel_time / 60.0", T.travel_time_min)
    rng("t.network_distance / 1000.0", T.network_distance_km)
    rng("t.network_distance / NULLIF(t.crowfly_distance, 0)", T.detour_factor)
    # origin / destination: canton → id column (fast); municipality/district →
    # point-in-polygon on the trip's origin/dest point.
    for field, id_col, pt_col in ((T.origin_place, "t.origin_canton_id", "t.origin_pt"),
                                  (T.dest_place, "t.dest_canton_id", "t.dest_pt")):
        if field:
            pl = _resolve_place(field)
            if pl is None:
                raise ValueError(f"unknown place: {field}")
            if pl["kind"] == "canton":
                w.append(f"{id_col} = ?"); b.append(pl["canton_id"])
            else:
                w.append(f"ST_Within({pt_col}, (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?))")
                b.append(pl["polygon_id"])

    # User-drawn polygon filters. The geometry never passes through the LLM;
    # it is set per request from the map's draw layer. The WKT is embedded
    # as a literal, NOT a bind parameter: main.py builds it purely from
    # float() coordinates (injection-safe), and a bound ST_GeomFromText(?)
    # inside GROUP-BY queries trips a DuckDB planner bug (InternalException
    # in ColumnBindingResolver).
    if T.origin_in_drawn or T.dest_in_drawn or T.touches_drawn:
        wkt = _user_polygon.get()
        if not wkt:
            raise ValueError("no polygon is drawn on the map - ask the user "
                             "to draw one first (or offer to start draw mode)")
        if not re.fullmatch(r"POLYGON\(\([0-9eE+\-., ]+\)\)", wkt):
            raise ValueError("invalid drawn polygon")
        # Scalar subquery: a bare ST_Transform(...) expression in the WHERE
        # clause trips a DuckDB planner bug in GROUP-BY queries; the
        # subquery form (same shape as the hot_polygons filters) does not.
        drawn = (f"(SELECT ST_Transform(ST_GeomFromText('{wkt}'), "
                 "'EPSG:4326', 'EPSG:2056', always_xy := true))")
        if T.touches_drawn:
            w.append(f"(ST_Within(t.origin_pt, {drawn}) OR "
                     f"ST_Within(t.dest_pt, {drawn}))")
        if T.origin_in_drawn:
            w.append(f"ST_Within(t.origin_pt, {drawn})")
        if T.dest_in_drawn:
            w.append(f"ST_Within(t.dest_pt, {drawn})")

    # "via X" = the trip's route must traverse a link in X. Each named place is
    # its own EXISTS so "via A and B" means through BOTH (car routes only).
    def _via_exists(link_cond: str, link_bind: list):
        w.append(f"""EXISTS (SELECT 1 FROM spider_link_index si
                    WHERE si.person_id = t.person_id AND si.trip_index = t.trip_index
                      AND si.link_id IN (SELECT nl.link_id FROM network_links nl
                                         WHERE {link_cond}))""")
        b.extend(link_bind)

    for c in R.via_place or []:
        pl = _resolve_place(c)
        if pl is None:
            raise ValueError(f"unknown place: {c}")
        if pl["kind"] == "canton":
            _via_exists("nl.canton_id = ?", [pl["canton_id"]])
        else:
            _via_exists(
                "ST_Intersects(nl.geom, (SELECT polygon_geom FROM hot_polygons WHERE polygon_id = ?))",
                [pl["polygon_id"]])
    if R.via_road_type:
        _via_exists(f"nl.road_type IN ({','.join('?' * len(R.via_road_type))})",
                    list(R.via_road_type))

    return "WHERE " + " AND ".join(w), b


_BASE = """FROM trips t
JOIN persons p ON p.person_id = t.person_id
LEFT JOIN households h ON h.household_id = p.household_id"""

_METRIC_SQL = {
    "count": "COUNT(*)",
    "count_persons": "COUNT(DISTINCT t.person_id)",
    "avg_travel_time_min": "ROUND(AVG(t.travel_time) / 60.0, 1)",
    "avg_distance_km": "ROUND(AVG(t.network_distance) / 1000.0, 2)",
    "avg_speed_kmh": "ROUND(AVG(t.network_distance / NULLIF(t.travel_time, 0)) * 3.6, 1)",
    "sum_person_km": "ROUND(SUM(t.network_distance) / 1000.0, 0)",
}

_GROUP_SQL = {
    "hour": "CAST(t.departure_time / 3600 AS INTEGER) % 24",
    "mode": "t.main_mode",
    "purpose": "t.following_purpose",
    "origin_canton": "t.origin_canton_id",
    "dest_canton": "t.dest_canton_id",
    "age_group": ("CASE WHEN p.age < 18 THEN '0-17' WHEN p.age < 30 THEN '18-29' "
                  "WHEN p.age < 45 THEN '30-44' WHEN p.age < 65 THEN '45-64' ELSE '65+' END"),
    "income_class": "h.income_class",
}

_METRIC_UNIT = {"avg_travel_time_min": "min", "avg_distance_km": "km",
                "avg_speed_kmh": "km/h", "sum_person_km": "person-km"}

_ORDER_COL = {
    "network_distance_km": "t.network_distance",
    "travel_time_min": "t.travel_time",
    "depart_hour": "t.departure_time",
    "speed_kmh": "t.network_distance / NULLIF(t.travel_time, 0)",
}


def _fmt(n) -> str:
    return f"{n:,.0f}".replace(",", "'") if isinstance(n, (int, float)) else str(n)


# ─── Trip-plan execution ─────────────────────────────────────────────────


def _execute_plan(plan: QueryPlan, title: str, vocab: dict) -> dict:
    con = get_source_cursor("synthetic")
    where, bind = _compile(plan)
    out = plan.output
    sr = vocab.get("sample_rate")

    if out.type == "number":
        if out.metric == "mode_share":
            rows = con.execute(
                f"SELECT t.main_mode, COUNT(*) {_BASE} {where} GROUP BY 1 ORDER BY 2 DESC",
                bind).fetchall()
            total = sum(r[1] for r in rows) or 1
            share = {m: round(c / total * 100, 1) for m, c in rows}
            reply = (title or "Mode share") + ": " + ", ".join(
                f"{m} {s}%" for m, s in share.items()) + f"  (n={_fmt(total)})"
            return {"reply": reply, "display": {"type": "chat"}}
        val = con.execute(
            f"SELECT {_METRIC_SQL[out.metric]} {_BASE} {where}", bind).fetchone()[0] or 0
        if out.metric in ("count", "count_persons"):
            noun = "trips" if out.metric == "count" else "people"
            reply = f"{title or 'Result'}: {_fmt(val)} {noun}"
            if sr:
                reply += f" (scaled to full population ≈ {_fmt(val / sr)}, sample rate {sr})"
        else:
            reply = f"{title or 'Result'}: {_fmt(val)} {_METRIC_UNIT[out.metric]}"
        return {"reply": reply, "display": {"type": "chat"}}

    if out.type == "chart":
        gb = out.group_by or "mode"
        metric_sql = _METRIC_SQL.get(out.metric, _METRIC_SQL["count"])
        group_sql = _GROUP_SQL[gb]
        bin_size = max(1, min(out.hour_bin, 12)) if gb == "hour" else 1
        if gb == "hour" and bin_size > 1:
            group_sql = f"(({_GROUP_SQL['hour']}) / {bin_size}) * {bin_size}"
        rows = con.execute(
            f"SELECT {group_sql} AS g, {metric_sql} {_BASE} {where} "
            f"GROUP BY g ORDER BY g", bind).fetchall()
        if gb in ("origin_canton", "dest_canton"):
            rows = [(canton_name(int(g)) if g is not None else "?", v) for g, v in rows]
        if gb == "hour":
            by = {int(g): v for g, v in rows if g is not None}
            if bin_size == 1:
                rows = [(f"{h:02d}:00", by.get(h, 0)) for h in range(24)]
            else:
                rows = [(f"{h:02d}-{min(h + bin_size, 24):02d}h", by.get(h, 0))
                        for h in range(0, 24, bin_size)]
        labels = [str(r[0]) for r in rows]
        values = [float(r[1] or 0) for r in rows]
        reply = f"{title or 'Breakdown'} - see the chart below." if labels \
            else "No data matches these filters."
        return {"reply": reply,
                "display": {"type": "chart", "title": title, "labels": labels,
                            "values": values, "metric": out.metric, "group_by": gb}}

    if out.type == "map":
        total = con.execute(f"SELECT COUNT(*) {_BASE} {where}", bind).fetchone()[0]
        if total == 0:
            return {"reply": "No trips match these filters.", "display": {"type": "chat"}}

        # Honour ordering + limit so "show the/these longest trip(s)" draws only
        # those specific trip(s), not the whole match set (the "show it to me"
        # bug drew all 296k trips). `sel` = the exact trips to visualise.
        order_col = _ORDER_COL.get(out.order_by)
        if order_col:
            direction = "DESC" if out.order_dir == "desc" else "ASC"
            n_draw = min(out.limit, MAX_MAP_OD)
            sel = (f"SELECT t.person_id AS pid, t.trip_index AS tidx, t.main_mode AS mode, "
                   f"t.origin_pt AS opt, t.dest_pt AS dpt {_BASE} {where} "
                   f"ORDER BY ({order_col}) {direction} NULLS LAST LIMIT {n_draw}")
        else:
            sel = (f"SELECT t.person_id AS pid, t.trip_index AS tidx, t.main_mode AS mode, "
                   f"t.origin_pt AS opt, t.dest_pt AS dpt {_BASE} {where}")

        drawn = con.execute(f"SELECT COUNT(*), COUNT(*) FILTER (WHERE mode='car') "
                            f"FROM ({sel}) s", bind).fetchone()
        drawn_total, car_n = drawn[0], drawn[1]

        # Only CAR trips have complete routes in spider_link_index (~87% vs
        # ~5-12% for bike/walk/pt). Draw spider-style links only when car
        # dominates the drawn set; otherwise clean origin-destination lines.
        if car_n > 0 and car_n / max(drawn_total, 1) >= 0.5:
            rows = con.execute(f"""
                WITH sel AS ({sel}),
                agg AS (SELECT si.link_id, COUNT(*) AS n
                        FROM spider_link_index si
                        JOIN sel s ON s.pid = si.person_id AND s.tidx = si.trip_index
                                  AND s.mode = 'car'
                        GROUP BY si.link_id ORDER BY n DESC LIMIT {MAX_MAP_LINKS})
                SELECT ST_AsGeoJSON(ST_Transform(nl.geom,'EPSG:2056','EPSG:4326',always_xy:=true)),
                       agg.n
                FROM agg JOIN network_links nl ON nl.link_id = agg.link_id""",
                bind).fetchall()
            if rows:
                feats = [{"type": "Feature", "geometry": json.loads(g),
                          "properties": {"spider_flow": int(n)}}
                         for g, n in rows if g]
                capped = len(feats) >= MAX_MAP_LINKS
                cap_note = (" (showing the most-used roads only)" if capped else "")
                if order_col and drawn_total == 1:
                    reply = f"Route of the single trip drawn on the map ({len(feats)} road segments)."
                elif order_col:
                    reply = (f"Routes of the {_fmt(drawn_total)} selected car trips "
                             f"drawn on the map{cap_note}.")
                else:
                    src = ("" if car_n == total
                           else f" (of {_fmt(total)} matching; only car trips have routes)")
                    reply = (f"Routes of {_fmt(car_n)} car trips{src} drawn on the map{cap_note} "
                             f"- line width = how many use the road.")
                return {"reply": reply,
                        "display": {"type": "map", "style": "links", "title": title,
                                    "geojson": {"type": "FeatureCollection", "features": feats},
                                    "total": total, "shown": len(feats)}}

        # Non-car (or mixed): no route data → origin-destination rendering.
        # FEW trips (superlatives, small selections): individual mode-colored
        # lines. MANY trips: per-trip spaghetti looks terrible — aggregate
        # endpoints on a 2 km grid into CORRIDORS and reuse the spider look
        # (orange, width = number of trips).
        shown_total = drawn_total if order_col else total
        if shown_total <= 150:
            od = con.execute(f"""
                WITH sel AS ({sel})
                SELECT ROUND(ST_X(ST_Transform(opt,'EPSG:2056','EPSG:4326',always_xy:=true)),5),
                       ROUND(ST_Y(ST_Transform(opt,'EPSG:2056','EPSG:4326',always_xy:=true)),5),
                       ROUND(ST_X(ST_Transform(dpt,'EPSG:2056','EPSG:4326',always_xy:=true)),5),
                       ROUND(ST_Y(ST_Transform(dpt,'EPSG:2056','EPSG:4326',always_xy:=true)),5),
                       mode FROM sel LIMIT {MAX_MAP_OD}""", bind).fetchall()
            feats = [{"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": [[ox, oy], [dx, dy]]},
                      "properties": {"mode": m}}
                     for ox, oy, dx, dy, m in od if ox is not None and dx is not None]
            if order_col and drawn_total == 1:
                reply = ("The selected trip is shown as a straight origin-destination line "
                         "(its mode has no route data in the simulation).")
            else:
                reply = (f"{_fmt(shown_total)} trips shown as "
                         f"origin-destination lines (their modes have no route data).")
            return {"reply": reply,
                    "display": {"type": "map", "style": "od", "title": title,
                                "geojson": {"type": "FeatureCollection", "features": feats},
                                "total": total, "shown": len(feats)}}

        # Snap cell adapts to the selection's spatial extent: fine grid for
        # a city, coarse for country-wide — otherwise nothing aggregates
        # (every long trip is its own corridor) and the map stays spaghetti.
        ext = con.execute(f"""
            WITH sel AS ({sel})
            SELECT GREATEST(MAX(ST_X(opt)) - MIN(ST_X(opt)),
                            MAX(ST_Y(opt)) - MIN(ST_Y(opt))) FROM sel""",
            bind).fetchone()[0] or 0
        GRID = int(min(8000, max(1000, ext / 40)))
        od = con.execute(f"""
            WITH sel AS ({sel}),
            cells AS (
                SELECT ROUND(ST_X(opt)/{GRID})*{GRID} AS ox2,
                       ROUND(ST_Y(opt)/{GRID})*{GRID} AS oy2,
                       ROUND(ST_X(dpt)/{GRID})*{GRID} AS dx2,
                       ROUND(ST_Y(dpt)/{GRID})*{GRID} AS dy2
                FROM sel),
            agg AS (
                SELECT ox2, oy2, dx2, dy2, COUNT(*) AS n FROM cells
                GROUP BY ALL
                HAVING NOT (ox2 = dx2 AND oy2 = dy2)
                ORDER BY n DESC LIMIT {MAX_MAP_OD})
            SELECT
              ROUND(ST_X(ST_Transform(ST_Point(ox2, oy2),'EPSG:2056','EPSG:4326',always_xy:=true)),5),
              ROUND(ST_Y(ST_Transform(ST_Point(ox2, oy2),'EPSG:2056','EPSG:4326',always_xy:=true)),5),
              ROUND(ST_X(ST_Transform(ST_Point(dx2, dy2),'EPSG:2056','EPSG:4326',always_xy:=true)),5),
              ROUND(ST_Y(ST_Transform(ST_Point(dx2, dy2),'EPSG:2056','EPSG:4326',always_xy:=true)),5),
              n FROM agg""", bind).fetchall()
        max_n = max((r[4] for r in od), default=1)
        # spider_flow drives the width ramp (tuned for road volumes 0-700);
        # normalize corridor counts into that domain, keep the raw count in
        # 'trips' for labels.
        scale = 500.0 / max_n if max_n else 1.0
        feats = [{"type": "Feature",
                  "geometry": {"type": "LineString", "coordinates": [[ox, oy], [dx, dy]]},
                  "properties": {"spider_flow": round(n * scale, 1), "trips": int(n)}}
                 for ox, oy, dx, dy, n in od if ox is not None and dx is not None]
        reply = (f"{_fmt(shown_total)} trips aggregated into {_fmt(len(feats))} "
                 "origin-destination corridors - line width = number of trips. "
                 "(No route data for these modes, so flows are shown as direct "
                 "connections.)")
        return {"reply": reply,
                "display": {"type": "map", "style": "links", "title": title,
                            "geojson": {"type": "FeatureCollection", "features": feats},
                            "total": total, "shown": len(feats)}}

    # table
    limit = min(out.limit, MAX_TABLE_ROWS)
    order_col = _ORDER_COL.get(out.order_by)
    order_sql = ""
    if order_col:
        direction = "DESC" if out.order_dir == "desc" else "ASC"
        order_sql = f"ORDER BY ({order_col}) {direction} NULLS LAST"
    rows = con.execute(f"""
        SELECT p.age, CASE p.sex WHEN 0 THEN 'm' ELSE 'f' END,
               t.main_mode, t.preceding_purpose || '→' || t.following_purpose,
               ROUND(t.departure_time/3600.0,1), ROUND(t.travel_time/60.0,1),
               ROUND(t.network_distance/1000.0,2),
               ROUND(t.network_distance / NULLIF(t.travel_time,0) * 3.6, 1)
        {_BASE} {where} {order_sql} LIMIT {limit}""", bind).fetchall()
    total = con.execute(f"SELECT COUNT(*) {_BASE} {where}", bind).fetchone()[0]
    if order_col and limit == 1 and rows:
        reply = f"{title or 'Result'} (out of {_fmt(total)} matching trips):"
    elif order_col:
        reply = f"{title or 'Result'} - top {len(rows)} of {_fmt(total)} matching trips:"
    else:
        reply = f"{_fmt(total)} trips - showing the first {len(rows)} as a table."
    return {"reply": reply,
            "display": {"type": "table", "title": title,
                        "columns": ["Age", "Sex", "Mode", "Purpose", "Depart (h)",
                                    "Duration (min)", "Distance (km)", "Speed (km/h)"],
                        "rows": [list(r) for r in rows], "total": total}}


# ─── Transit-line / stop execution ───────────────────────────────────────


def _execute_transit(q: TransitQuery, title: str) -> dict:
    try:
        lines = _boarding_lines()
    except Exception:
        return {"reply": "This dataset has no transit boarding data.",
                "display": {"type": "chat"}, "error": True}

    canton = (q.canton or "").strip()
    cname = None
    if canton:
        cid = _canton_id(canton)
        if cid is None:
            return {"reply": f"Unknown canton: {canton}", "display": {"type": "chat"}, "error": True}
        cname = canton_name(cid)

    def line_matches(l):
        if q.mode and (l.get("vehicle") or "").lower() != q.mode.lower():
            return False
        if cname and cname not in (l.get("cantons") or []):
            return False
        if q.line_name and (l.get("line_name") or "").lower() != q.line_name.lower():
            return False
        return True

    matched = [l for l in lines if line_matches(l)]

    def stops_of(l):
        for s in l.get("stops", []):
            if cname and canton_name(s.get("canton_id")) != cname:
                continue
            if q.stop_name and q.stop_name.lower() not in (s.get("name") or "").lower():
                continue
            yield s

    def hourly(selected_lines) -> dict[int, float]:
        by = {h: 0.0 for h in range(24)}
        for l in selected_lines:
            for s in stops_of(l):
                for d in s.get("data", []):
                    by[int(d.get("hour", 0)) % 24] += d.get("boardings", 0)
        return by

    where_txt = " in " + cname if cname else ""

    if q.kind == "count_lines":
        names = {(l.get("line_name"), l.get("vehicle")) for l in matched}
        # The LLM's title usually already says "… in Zurich" — don't repeat it.
        if title:
            reply = f"{title}: {len(names)} lines ({len(matched)} route variants)."
        else:
            mode_txt = (q.mode + " ") if q.mode else "transit "
            reply = f"{len(names)} {mode_txt}lines{where_txt} ({len(matched)} route variants)."
        return {"reply": reply, "display": {"type": "chat"}}

    if q.kind == "line_boardings":
        if not matched:
            return {"reply": f"No line named '{q.line_name}' found{where_txt}.",
                    "display": {"type": "chat"}}
        by = hourly(matched)
        total = sum(by.values())
        stop_txt = f" at stops matching '{q.stop_name}'" if q.stop_name else ""
        if title:
            reply = f"{title}: {_fmt(total)} boardings{stop_txt} (scaled to full population)."
        else:
            reply = (f"Line {q.line_name}: {_fmt(total)} boardings{where_txt}{stop_txt} "
                     f"(scaled to full population).")
        if q.output == "chart":
            return {"reply": reply + " Hourly profile below.",
                    "display": {"type": "chart", "title": title,
                                "labels": [f"{h:02d}:00" for h in range(24)],
                                "values": [by[h] for h in range(24)],
                                "metric": "boardings", "group_by": "hour"}}
        return {"reply": reply, "display": {"type": "chat"}}

    if q.kind == "stop_boardings":
        if not q.stop_name:
            return {"reply": "Please name the stop.", "display": {"type": "chat"}, "error": True}
        board = alight = 0.0
        by_line: dict[str, float] = {}
        stations = set()
        for l in matched:
            for s in stops_of(l):
                if q.stop_name.lower() not in (s.get("name") or "").lower():
                    continue
                stations.add(s.get("name"))
                for d in s.get("data", []):
                    board += d.get("boardings", 0)
                    alight += d.get("alightings", 0)
                    key = f"{l.get('line_name')} ({l.get('vehicle')})"
                    by_line[key] = by_line.get(key, 0) + d.get("boardings", 0)
        if not stations:
            return {"reply": f"No stop matching '{q.stop_name}' found{where_txt}.",
                    "display": {"type": "chat"}}
        top = sorted(by_line.items(), key=lambda x: -x[1])[:q.top_n]
        reply = (f"{title or q.stop_name}: {_fmt(board)} boardings, {_fmt(alight)} alightings "
                 f"(scaled). Busiest lines: "
                 + ", ".join(f"{k} {_fmt(v)}" for k, v in top[:5]) + ".")
        if q.output == "chart":
            return {"reply": reply,
                    "display": {"type": "chart", "title": title or q.stop_name,
                                "labels": [k for k, _ in top],
                                "values": [v for _, v in top],
                                "metric": "boardings", "group_by": "line"}}
        return {"reply": reply, "display": {"type": "chat"}}

    # top_lines / top_stops
    agg: dict[str, float] = {}
    for l in matched:
        for s in stops_of(l):
            total = sum(d.get("boardings", 0) for d in s.get("data", []))
            key = (f"{l.get('line_name')} ({l.get('vehicle')})"
                   if q.kind == "top_lines" else s.get("name") or "?")
            agg[key] = agg.get(key, 0) + total
    top = sorted(agg.items(), key=lambda x: -x[1])[:q.top_n]
    what = "lines" if q.kind == "top_lines" else "stops"
    if not top:
        return {"reply": f"No {what} found{where_txt}.", "display": {"type": "chat"}}
    reply = f"{title or 'Busiest ' + what + where_txt} - chart below."
    return {"reply": reply,
            "display": {"type": "chart", "title": title or f"Busiest {what}{where_txt}",
                        "labels": [k for k, _ in top], "values": [v for _, v in top],
                        "metric": "boardings", "group_by": what}}


# ─── Locate ("show me <place>") ──────────────────────────────────────────


_LOCATE_STOPWORDS = {"of", "the", "de", "la", "le", "in", "at", "der", "die", "das"}


def _execute_locate(q: LocateQuery) -> dict:
    name = (q.name or "").strip()
    if not name:
        return {"reply": "Please name a place.", "display": {"type": "chat"}, "error": True}
    needle = name.lower()
    # Tokenise so word ORDER and filler words don't matter: "university of
    # zürich" → {"university","zürich"}; a stop matches if it contains ALL tokens.
    tokens = [t for t in needle.replace(",", " ").split()
              if len(t) > 1 and t not in _LOCATE_STOPWORDS]

    # 1. Transit stations (already WGS84, built by transit_stops)
    try:
        from .transit_stops import inter_cantonal_stops
        feats = inter_cantonal_stops().get("features", [])

        def score(nm: str):
            n = nm.lower()
            if n == needle:
                return 0
            if needle in n:
                return 1
            # All query tokens must match a WORD of the stop name (equal or a
            # word-prefix) — not just any substring, so "eth" no longer matches
            # "Bethanien" and only a real "ETH …" stop would hit.
            words = set(re.findall(r"[a-zäöüéèàâî0-9]+", n))
            if tokens and all(
                any(w == t or (len(t) >= 3 and w.startswith(t)) for w in words)
                for t in tokens
            ):
                return 2
            return 99

        scored = [(score(f["properties"].get("name") or ""), f) for f in feats]
        hits = sorted(((s, f) for s, f in scored if s < 99),
                      key=lambda sf: (sf[0], len(sf[1]["properties"].get("name") or "")))
        if hits:
            f = hits[0][1]
            lon, lat = f["geometry"]["coordinates"][:2]
            label = f["properties"].get("name")
            return {"reply": f"Found stop \"{label}\" - marked on the map.",
                    "display": {"type": "locate", "name": label, "lon": lon, "lat": lat,
                                "kind": "stop"}}
    except Exception:
        pass

    # 2. Municipalities / cantons from hot_polygons (centroid, LV95 → WGS84).
    # "Zürich city" / "Stadt Zürich" (the trip-DSL naming convention) must
    # find the municipality "Zürich": try the raw needle, then the
    # filler-word-stripped variant.
    try:
        con = get_source_cursor("synthetic")
        clean = _MUNI_WORDS.sub(" ", needle)
        clean = re.sub(r"\s+", " ", clean).strip(" ,()")
        for cand in dict.fromkeys([needle, clean]):
            if not cand:
                continue
            row = con.execute("""
                SELECT polygon_name,
                       ST_X(ST_Transform(ST_Centroid(polygon_geom),'EPSG:2056','EPSG:4326',always_xy:=true)),
                       ST_Y(ST_Transform(ST_Centroid(polygon_geom),'EPSG:2056','EPSG:4326',always_xy:=true))
                FROM hot_polygons
                WHERE LOWER(polygon_name) LIKE ?
                ORDER BY LENGTH(polygon_name) LIMIT 1""", [f"%{cand}%"]).fetchone()
            if row:
                return {"reply": f"Found \"{row[0]}\" - marked on the map.",
                        "display": {"type": "locate", "name": row[0], "lon": row[1], "lat": row[2],
                                    "kind": "municipality"}}
    except Exception:
        pass

    # 3. Not in the dataset (a POI like "ETH Zürich", an address, …). Signal the
    # frontend to try Mapbox geocoding (it has the token) as a fallback.
    return {"reply": f"Searching for \"{name}\"…",
            "display": {"type": "locate_failed", "query": name}}


# ─── Entry point ─────────────────────────────────────────────────────────


def run_ai_query(question: str, history: list[dict]) -> dict:
    """Blocking; call via asyncio.to_thread."""
    question = (question or "").strip()
    if not question:
        return {"reply": "Please enter a question.", "display": {"type": "chat"}, "error": True}
    if not _llm.is_configured():
        return {"reply": "The AI feature is not configured (GEMINI_API_KEY missing).",
                "display": {"type": "chat"}, "error": True}

    vocab = _dataset_vocab()
    sys_prompt = _system_prompt(vocab)
    messages = [m for m in history if m.get("role") in ("user", "model") and m.get("text")][-6:]
    messages.append({"role": "user", "text": question})

    last_err = None
    raw = None
    for attempt in range(2):                       # one self-repair round-trip
        try:
            raw = _llm.generate_json(sys_prompt, messages)
            parsed = LLMReply.model_validate(raw)
            if parsed.refuse_reason:
                return {"reply": parsed.refuse_reason, "display": {"type": "chat"}}
            if parsed.clear_map:
                return {"reply": "Done - removed the AI layer from the map.",
                        "display": {"type": "clear_map"}}
            if parsed.locate:
                return _execute_locate(parsed.locate)
            if parsed.transit:
                return _execute_transit(parsed.transit, parsed.title)
            if parsed.plan:
                return _execute_plan(parsed.plan, parsed.title, vocab)
            raise ValueError("no plan/transit/locate/refuse_reason in reply")
        except _llm.LLMError as exc:
            logger.warning("ai_query LLM error: %s", exc)
            return {"reply": f"The AI service is currently unavailable ({exc}).",
                    "display": {"type": "chat"}, "error": True}
        except (ValidationError, ValueError, KeyError) as exc:
            last_err = exc
            messages.append({"role": "model", "text": json.dumps(raw) if raw else "{}"})
            messages.append({"role": "user",
                             "text": f"Your JSON was invalid: {exc}. Return a corrected JSON object."})
        except Exception as exc:                    # SQL/runtime problems
            logger.warning("ai_query execution failed: %s", exc)
            return {"reply": f"The query could not be executed: {exc}",
                    "display": {"type": "chat"}, "error": True}

    return {"reply": f"The question could not be translated into a valid query ({last_err}).",
            "display": {"type": "chat"}, "error": True}
