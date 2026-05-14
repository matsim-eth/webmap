"""Node-level turning-movement matrix.

Given a MATSim node ID, derives entering/exiting links from the network
XML and returns a matrix of trip counts for every (entering -> exiting)
link pair observed in the spider route data.

The network topology is parsed once per dataset from output_network.xml
and cached in memory.

Query params
------------
node_id          (str, required)       : MATSim node ID.
minute_start     (int, 0-1440)         : Time window start (minutes from midnight).
minute_end       (int, 0-1440)         : Time window end (minutes from midnight).
sex              (str, "0"/"1")        : Gender filter.
age_min          (int)                 : Minimum age (inclusive).
age_max          (int)                 : Maximum age (exclusive).
employed         (str, "true"/"false") : Employment status.
has_license      (str, "true"/"false") : Driving-licence filter.
car_availability (str, "0"/"1"/"2")    : Car-availability class.
home_canton      (str)                 : Canton name or ID (comma-separated).
income           (str)                 : Income class (from households).
"""

from __future__ import annotations

import threading
import xml.sax
import xml.sax.handler
from dataclasses import dataclass, field

from .base import Param
from .paths import get_data_paths
from .spider_analysis import _SpiderBase, _get_con


# ─── Network topology cache ───────────────────────────────────────

@dataclass
class _NodeTopology:
    """Links entering and exiting a node."""
    entering: list[str] = field(default_factory=list)   # links whose "to" is this node
    exiting: list[str] = field(default_factory=list)     # links whose "from" is this node


class _NetworkHandler(xml.sax.handler.ContentHandler):
    """SAX handler that extracts link from/to relationships."""

    def __init__(self) -> None:
        super().__init__()
        self.nodes: dict[str, _NodeTopology] = {}
        # Reverse lookup: link_id → (from_node, to_node)
        self.link_to_nodes: dict[str, tuple[str, str]] = {}

    def startElement(self, name: str, attrs: xml.sax.xmlreader.AttributesImpl) -> None:
        if name != "link":
            return
        link_id = attrs.get("id")
        from_node = attrs.get("from")
        to_node = attrs.get("to")
        if not link_id or not from_node or not to_node:
            return

        # Only include links that allow car traffic
        modes = attrs.get("modes", "car")
        if "car" not in modes:
            return

        self.link_to_nodes[link_id] = (from_node, to_node)

        # Link exits from_node and enters to_node
        if from_node not in self.nodes:
            self.nodes[from_node] = _NodeTopology()
        self.nodes[from_node].exiting.append(link_id)

        if to_node not in self.nodes:
            self.nodes[to_node] = _NodeTopology()
        self.nodes[to_node].entering.append(link_id)


@dataclass
class _NetworkData:
    """Parsed network: node topology + link-to-node reverse lookup."""
    nodes: dict[str, _NodeTopology] = field(default_factory=dict)
    link_to_nodes: dict[str, tuple[str, str]] = field(default_factory=dict)


_network_cache: dict[str, _NetworkData] = {}
_network_lock = threading.Lock()


def _get_network(network_xml: str) -> _NetworkData:
    """Parse and cache the network topology from output_network.xml."""
    with _network_lock:
        if network_xml not in _network_cache:
            handler = _NetworkHandler()
            parser = xml.sax.make_parser()
            parser.setContentHandler(handler)
            parser.parse(network_xml)
            _network_cache[network_xml] = _NetworkData(
                nodes=handler.nodes,
                link_to_nodes=handler.link_to_nodes,
            )
        return _network_cache[network_xml]


# ─── Provider ─────────────────────────────────────────────────────

_NODE_FLOWS_PARAMS = [
    Param("node_id", "MATSim node ID (required unless link_id given)"),
    Param("link_id", "MATSim link ID — derives the to-node automatically"),
    Param("end", "Which end of the link to use: 'to' (default) or 'from'", enum=["to", "from"]),
    Param("sex", "Gender filter (0=male, 1=female)", enum=["0", "1"]),
    Param("age_min", "Minimum age (inclusive)", param_type="integer"),
    Param("age_max", "Maximum age (exclusive)", param_type="integer"),
    Param("employed", "Employment status", enum=["true", "false"]),
    Param("has_license", "Driving-licence filter", enum=["true", "false"]),
    Param("car_availability", "Car-availability class", enum=["0", "1", "2"]),
    Param("home_canton", "Canton name or ID (comma-separated)"),
    Param("income", "Income class (from households)", param_type="integer"),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class NodeFlowsProvider(_SpiderBase):
    """Link-to-link turning-movement matrix at a MATSim node.

    1. Looks up the node in the network XML to find entering/exiting links.
    2. Queries spider_routes for consecutive link pairs that cross the node.
    3. Returns a count matrix: matrix[entering_link][exiting_link] = trips.

    Example: /data/{dataset_id}/node_flows.json?node_id=12345
    """

    ROUTE = "node_flows.json"
    PARAMS = _NODE_FLOWS_PARAMS

    def deliver(self, params: dict) -> dict:
        node_id = (params.get("node_id") or "").strip()
        link_id = (params.get("link_id") or "").strip()
        end = (params.get("end") or "to").strip().lower()
        warmup = str(params.get("warmup") or "").lower() in ("1", "true")

        if not warmup and not node_id and not link_id:
            return {"error": "node_id or link_id parameter is required"}

        # Look up node topology from network XML
        paths = get_data_paths()
        try:
            net = _get_network(paths.network_xml)
        except Exception as e:
            return {"error": f"Failed to load network: {e}"}

        if warmup:
            return {"warmed": True, "nodes": len(net.nodes), "links": len(net.link_to_nodes)}

        # Derive node_id from link_id if needed
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
            return {
                "node_id": node_id,
                "entering_links": entering,
                "exiting_links": exiting,
                "total_movements": 0,
                "matrix": {},
            }

        person_filter, household_join, time_filter, bind_persons, bind_time = \
            self._build_filters(params)

        con = _get_con()

        # Build IN-list placeholders
        entering_ph = ", ".join(["?"] * len(entering))
        exiting_ph = ", ".join(["?"] * len(exiting))

        # 1. Find all trips passing through any entering link (via index).
        # 2. Join back to spider_routes to get the next link in the route.
        # 3. Keep only pairs where the next link is an exiting link.
        query = f"""
            WITH target_trips AS (
                SELECT idx.person_id, idx.trip_index, idx.position
                FROM spider_link_index idx
                INNER JOIN (
                    SELECT CAST(p.person_id AS VARCHAR) AS person_id
                    FROM persons p
                    {household_join}
                    WHERE 1=1
                    {person_filter}
                ) fp ON idx.person_id = fp.person_id
                WHERE idx.link_id IN ({entering_ph})
                {time_filter}
            ),
            movements AS (
                SELECT
                    r.route_links[tt.position] AS from_link,
                    r.route_links[tt.position + 1] AS to_link
                FROM spider_routes r
                INNER JOIN target_trips tt
                    ON r.person_id = tt.person_id
                    AND r.trip_index = tt.trip_index
                WHERE tt.position < len(r.route_links)
                  AND r.route_links[tt.position + 1] IN ({exiting_ph})
            )
            SELECT from_link, to_link, COUNT(*)::INTEGER AS flow
            FROM movements
            GROUP BY from_link, to_link
            ORDER BY from_link, to_link
        """

        bind = bind_persons + entering + bind_time + exiting

        try:
            rows = con.execute(query, bind).fetchall()
        except Exception as e:
            return {"error": str(e)}

        # Build the matrix: {entering_link: {exiting_link: count}}
        matrix: dict[str, dict[str, int]] = {
            e: {x: 0 for x in exiting} for e in entering
        }
        total = 0
        for from_link, to_link, flow in rows:
            if from_link in matrix and to_link in matrix[from_link]:
                matrix[from_link][to_link] = flow
                total += flow

        return {
            "node_id": node_id,
            "entering_links": entering,
            "exiting_links": exiting,
            "total_movements": total,
            "matrix": matrix,
        }
