"""Node-level turning-movement matrix.

Network topology now comes from ``network_links`` (no XML parsing).
Filter logic and spider join semantics match SpiderInflow/Outflow.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .base import Param
from .connection import get_source_cursor
from .spider_analysis import _SpiderBase, _get_con


@dataclass
class _NodeTopology:
    entering: list[str] = field(default_factory=list)
    exiting: list[str] = field(default_factory=list)


@dataclass
class _NetworkData:
    nodes: dict[str, _NodeTopology] = field(default_factory=dict)
    link_to_nodes: dict[str, tuple[str, str]] = field(default_factory=dict)


_network_cache: dict[str, _NetworkData] = {}
_network_lock = threading.Lock()


def _get_network() -> _NetworkData:
    """Read network_links from synthetic.duckdb and build a topology lookup."""
    key = "synthetic"
    with _network_lock:
        if key in _network_cache:
            return _network_cache[key]
        con = get_source_cursor("synthetic")
        rows = con.execute(
            "SELECT link_id, from_node, to_node, modes FROM network_links"
        ).fetchall()
        nd = _NetworkData()
        for link_id, fr, to, modes in rows:
            if not link_id or not fr or not to:
                continue
            if modes and "car" not in modes:
                continue
            nd.link_to_nodes[link_id] = (fr, to)
            nd.nodes.setdefault(fr, _NodeTopology()).exiting.append(link_id)
            nd.nodes.setdefault(to, _NodeTopology()).entering.append(link_id)
        _network_cache[key] = nd
        return nd


_NODE_FLOWS_PARAMS = [
    Param("node_id", "MATSim node ID (required unless link_id given)"),
    Param("link_id", "MATSim link ID — derives the to-node automatically"),
    Param("end", "Which end of the link to use: 'to' (default) or 'from'", enum=["to", "from"]),
    Param("sex", "Gender filter (0=male, 1=female)", enum=["0", "1"]),
    Param("age_min", "Minimum age (inclusive)", param_type="integer"),
    Param("age_max", "Maximum age (exclusive)", param_type="integer"),
    Param("employed", "Employment status", enum=["true", "false"]),
    Param("has_license", "Driving-licence filter", enum=["true", "false"]),
    Param("car_availability", "Car-availability class", enum=["always", "sometimes", "never"]),
    Param("home_canton", "Canton name or ID (legacy)"),
    Param("polygon_id", "Hot-polygon ID(s) for home filter, comma-separated"),
    Param("income", "Income class (from households)"),
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

        if not warmup and not node_id and not link_id:
            return {"error": "node_id or link_id parameter is required"}

        try:
            net = _get_network()
        except Exception as e:
            return {"error": f"Failed to load network: {e}"}

        if warmup:
            return {"warmed": True, "nodes": len(net.nodes), "links": len(net.link_to_nodes)}

        if not node_id and link_id:
            endpoints = net.link_to_nodes.get(link_id)
            if not endpoints:
                return {"error": f"Link {link_id} not found in network"}
            node_id = endpoints[1] if end == "to" else endpoints[0]

        topo = net.nodes.get(node_id)
        if topo is None:
            return {"error": f"Node {node_id} not found in network"}

        entering = topo.entering
        exiting = topo.exiting
        if not entering or not exiting:
            return {"node_id": node_id, "entering_links": entering, "exiting_links": exiting,
                    "total_movements": 0, "matrix": {}}

        person_clauses, poly_join, poly_bind, hh_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)
        con = _get_con()
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
