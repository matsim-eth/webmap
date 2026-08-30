"""Node-level turning-movement matrix.

Network topology is queried **on demand** from ``network_links`` — only the
links touching the requested node — instead of building a full in-memory
topology of all ~1.7M links per worker. That removes a ~6 s cold start and a
few hundred MB of per-worker memory; the per-request cost is one small lookup.
Filter logic and spider join semantics match SpiderInflow/Outflow.

Socioeconomic person filters (mirrored from the Zone Flows contract):
``gender`` (alias of ``sex``, 0/1), ``age_min``/``age_max``, ``income_class``
(comma-separated ints → ``households.income_class``), and ``subscription``
(comma-separated subset of ``constants.SUBS`` → any ``persons.subscriptions_{s}``
is TRUE). Any of them forces the per-trip spider path — the precomputed
``node_flow_matrix`` fast path is full-day / all-persons and cannot express
person filters (see ``_PERSON_FILTER_KEYS``).
"""

from __future__ import annotations

from .base import Param
from .spider_analysis import _SpiderBase, _get_con


_CAR = "(modes IS NULL OR modes LIKE '%car%')"


def _link_endpoints(con, link_id: str):
    """Return (from_node, to_node) for a car link, or None."""
    r = con.execute(
        f"SELECT from_node, to_node FROM network_links WHERE link_id = ? AND {_CAR} LIMIT 1",
        [link_id],
    ).fetchone()
    return (r[0], r[1]) if r else None


def _node_links(con, node_id: str):
    """Return (entering_links, exiting_links) for a node (car links only)."""
    rows = con.execute(
        f"""SELECT link_id, from_node, to_node FROM network_links
            WHERE (from_node = ? OR to_node = ?) AND {_CAR}""",
        [node_id, node_id],
    ).fetchall()
    entering = [lid for lid, fr, to in rows if to == node_id]
    exiting = [lid for lid, fr, to in rows if fr == node_id]
    return entering, exiting


# Person-filter params that force the (slow) live spider scan. If none are set
# and the time window covers the full day, the precomputed node_flow_matrix —
# which is a full-day, all-persons aggregate — gives an identical result. The
# socio params (gender/income_class/subscription) are included so ANY of them
# forces the per-trip (spider_link_index/spider_routes) path: the matrix has no
# person dimension and cannot express them.
_PERSON_FILTER_KEYS = (
    "sex", "gender", "age_min", "age_max", "employed", "has_license",
    "car_availability", "home_canton", "zone", "polygon_id", "polygon_ids",
    "income", "income_class", "subscription",
)


def _is_unfiltered(params: dict) -> bool:
    """True when no person filter is set and the time window is the full day."""
    if any(params.get(k) not in (None, "") for k in _PERSON_FILTER_KEYS):
        return False
    ms = params.get("minute_start")
    if ms not in (None, ""):
        try:
            if int(ms) > 0:
                return False
        except ValueError:
            return False
    me = params.get("minute_end")
    if me not in (None, ""):
        try:
            if int(me) < 1440:
                return False
        except ValueError:
            return False
    return True


def _matrix_result(con, node_id: str, entering: list, exiting: list) -> dict | None:
    """Build the node-flow response from the precomputed node_flow_matrix table.

    Returns the full result dict, or None if the table is absent (older
    datasets) so the caller can fall back to the live spider query. The matrix
    is full-day / all-persons, so only use it when ``_is_unfiltered`` holds.
    """
    try:
        rows = con.execute(
            "SELECT from_link, to_link, n_trips FROM node_flow_matrix WHERE node_id = ?",
            [node_id],
        ).fetchall()
    except Exception:
        return None  # table not present → fall back to the live query

    matrix: dict[str, dict[str, int]] = {e: {x: 0 for x in exiting} for e in entering}
    total = 0
    for from_link, to_link, n in rows:
        if from_link in matrix and to_link in matrix[from_link]:
            matrix[from_link][to_link] = int(n)
            total += int(n)
    return {"node_id": node_id, "entering_links": entering, "exiting_links": exiting,
            "total_movements": total, "matrix": matrix}


_NODE_FLOWS_PARAMS = [
    Param("node_id", "MATSim node ID (required unless link_id given)"),
    Param("link_id", "MATSim link ID — derives the to-node automatically"),
    Param("end", "Which end of the link to use: 'to' (default) or 'from'", enum=["to", "from"]),
    Param("sex", "Gender filter (0=male, 1=female)", enum=["0", "1"]),
    Param("gender", "Person sex filter (alias of sex)", enum=["0", "1"]),
    Param("age_min", "Minimum age (inclusive)", param_type="integer"),
    Param("age_max", "Maximum age (exclusive)", param_type="integer"),
    Param("employed", "Employment status", enum=["true", "false"]),
    Param("has_license", "Driving-licence filter", enum=["true", "false"]),
    Param("car_availability", "Car-availability class", enum=["always", "sometimes", "never"]),
    Param("home_canton", "Canton name or ID (legacy)"),
    Param("polygon_id", "Hot-polygon ID(s) for home filter, comma-separated"),
    Param("income", "Income class (from households, single value, legacy)"),
    Param("income_class", "Household income class(es), comma-separated"),
    Param("subscription", "PT subscription(s), comma-separated (ga,halbtax,…); match if ANY selected"),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class NodeFlowsProvider(_SpiderBase):
    ROUTE = "node_flows.json"
    PARAMS = _NODE_FLOWS_PARAMS

    def deliver(self, params: dict) -> dict:
        node_id = (params.get("node_id") or "").strip()
        link_id = (params.get("link_id") or "").strip()
        end = (params.get("end") or "to").strip().lower()
        warmup = str(params.get("warmup") or "").lower() in ("1", "true")

        if warmup:
            return {"warmed": True}
        if not node_id and not link_id:
            return {"error": "node_id or link_id parameter is required"}

        con = _get_con()

        if not node_id and link_id:
            endpoints = _link_endpoints(con, link_id)
            if not endpoints:
                return {"error": f"Link {link_id} not found in network"}
            node_id = endpoints[1] if end == "to" else endpoints[0]

        entering, exiting = _node_links(con, node_id)
        if not entering and not exiting:
            return {"error": f"Node {node_id} not found in network"}
        if not entering or not exiting:
            return {"node_id": node_id, "entering_links": entering, "exiting_links": exiting,
                    "total_movements": 0, "matrix": {}}

        # Fast path: a full-day, all-persons request is exactly what the
        # precomputed node_flow_matrix holds — a point lookup (~ms) instead of a
        # multi-second scan of the 255M-row spider_link_index. Falls back to the
        # live query below when the table is missing or filters are active.
        if _is_unfiltered(params):
            fast = _matrix_result(con, node_id, entering, exiting)
            if fast is not None:
                return fast

        person_clauses, poly_join, poly_bind, hh_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)
        psubq = self._person_subquery(poly_join, hh_join, person_clauses)

        entering_ph = ", ".join(["?"] * len(entering))
        exiting_ph = ", ".join(["?"] * len(exiting))

        query = f"""
            WITH target_trips AS (
                SELECT idx.person_id, idx.trip_index, idx.position
                FROM spider_link_index idx
                INNER JOIN ({psubq}) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id IN ({entering_ph})
                {time_filter}
            ),
            movements AS (
                SELECT r.route_links[tt.position] AS from_link,
                       r.route_links[tt.position + 1] AS to_link
                FROM spider_routes r
                INNER JOIN target_trips tt
                  ON r.person_id = tt.person_id AND r.trip_index = tt.trip_index
                WHERE tt.position < len(r.route_links)
                  AND r.route_links[tt.position + 1] IN ({exiting_ph})
            )
            SELECT from_link, to_link, COUNT(*)::INTEGER FROM movements
            GROUP BY from_link, to_link ORDER BY 1, 2
        """
        bind = poly_bind + bind_persons + entering + bind_time + exiting
        try:
            rows = con.execute(query, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        matrix: dict[str, dict[str, int]] = {e: {x: 0 for x in exiting} for e in entering}
        total = 0
        for from_link, to_link, flow in rows:
            if from_link in matrix and to_link in matrix[from_link]:
                matrix[from_link][to_link] = int(flow)
                total += int(flow)

        return {"node_id": node_id, "entering_links": entering, "exiting_links": exiting,
                "total_movements": total, "matrix": matrix}
