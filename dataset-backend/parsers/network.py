"""Parse a MATSim ``output_network.xml(.gz)`` into nodes and links.

Feeds ``network_nodes`` / ``network_links`` (see ``docs/duckdb-format.md``):
coordinates are LV95 as written in the XML, and ``road_type`` is the link's
OSM highway class taken from its nested ``<attributes>`` block.

    net = parse_network("output_network.xml.gz")
    net.nodes  # [{"node_id": "1000020544", "x": 2581934.3, "y": 1195391.9}, …]
    net.links  # [{"link_id": "1", "from_node": …, "road_type": "residential"}, …]

``parse_network`` materialises the whole network (~1.9 M links ≈ 1 GB of
Python objects for the Swiss network). When that is too much next to another
parse, stream instead — :func:`iter_nodes` / :func:`iter_links` yield the exact
same dicts one at a time and the file is read once per call.
"""

from __future__ import annotations

import gzip
import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

logger = logging.getLogger(__name__)

#: link ``<attribute name="…">`` holding the road hierarchy class. Only the
#: *highway* tag counts: rail/ferry links carry ``osm:way:railway`` instead and
#: the reference datasets leave their ``road_type`` untagged.
ROAD_TYPE_ATTRIBUTE = "osm:way:highway"

#: value used when a link has no :data:`ROAD_TYPE_ATTRIBUTE`. The webmap treats
#: NULL and ``"unknown"`` alike (``link_speeds.py`` falls back to a capacity
#: threshold for both), so this is a cosmetic choice — but an explicit one.
DEFAULT_ROAD_TYPE = "unknown"

_PROGRESS_EVERY = 100_000


# ─── streaming helpers ─────────────────────────────────────────────────────

def _open(path: str | Path):
    """Open ``path`` as a binary stream, transparently gunzipping ``.gz``."""
    path = str(path)
    return gzip.open(path, "rb") if path.endswith(".gz") else open(path, "rb")


def _drop(elem) -> None:
    """Free an element and every sibling already consumed before it."""
    elem.clear()
    parent = elem.getparent()
    if parent is not None:
        while elem.getprevious() is not None:
            del parent[0]


def _tick(progress: Callable[[str], None] | None, label: str, n: int) -> None:
    if progress is not None and n % _PROGRESS_EVERY == 0:
        progress(f"network: {n:,} {label} parsed")


# ─── public API ────────────────────────────────────────────────────────────

@dataclass
class NetworkData:
    """Everything ``output_network.xml`` has to say, as row dicts."""

    nodes: list[dict] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)


def _node_row(elem) -> dict:
    get = elem.get
    return {"node_id": get("id"), "x": float(get("x")), "y": float(get("y"))}


def _link_row(elem, pool: dict) -> dict:
    get = elem.get
    road_type = DEFAULT_ROAD_TYPE
    for attr in elem.iterfind("attributes/attribute"):
        if attr.get("name") == ROAD_TYPE_ATTRIBUTE:
            road_type = attr.text or DEFAULT_ROAD_TYPE
            break
    modes = get("modes") or ""
    # capacity/freespeed/permlanes take a few dozen distinct values across two
    # million links, and road types/mode sets a couple of dozen — sharing the
    # objects saves a few hundred MB over re-allocating each one.
    capacity = float(get("capacity") or 0.0)
    freespeed = float(get("freespeed") or 0.0)
    permlanes = float(get("permlanes") or 0.0)
    return {
        "link_id": get("id"),
        "from_node": get("from"),
        "to_node": get("to"),
        "length": float(get("length")),
        "capacity": pool.setdefault(capacity, capacity),
        "freespeed": pool.setdefault(freespeed, freespeed),
        "permlanes": pool.setdefault(permlanes, permlanes),
        "modes": pool.setdefault(modes, modes),
        "road_type": pool.setdefault(road_type, road_type),
    }


def _iter_network(path: str | Path, progress: Callable[[str], None] | None,
                  want_nodes: bool, want_links: bool) -> Iterator[tuple[str, dict]]:
    """Single pass over the file yielding ``("node"|"link", row)``.

    Both element types are consumed even when only one is wanted: a
    ``tag=``-filtered ``iterparse`` still *builds* the elements it does not
    yield, and nothing would ever free them (≈1 GB of stale ``<node>`` tree on
    the Swiss network).
    """
    n_nodes = n_links = 0
    pool: dict = {}
    with _open(path) as fh:
        for _, elem in etree.iterparse(fh, events=("end",), tag=("node", "link"),
                                       huge_tree=True):
            if elem.tag == "node":
                if want_nodes:
                    yield "node", _node_row(elem)
                n_nodes += 1
                _tick(progress, "nodes", n_nodes)
            else:
                if want_links:
                    yield "link", _link_row(elem, pool)
                n_links += 1
                _tick(progress, "links", n_links)
            _drop(elem)
    if progress is not None:
        progress(f"network: {n_nodes:,} nodes / {n_links:,} links parsed")


def iter_nodes(path: str | Path,
               progress: Callable[[str], None] | None = None) -> Iterator[dict]:
    """Yield ``{node_id, x, y}`` per ``<node>``, in file order."""
    for _kind, row in _iter_network(path, progress, True, False):
        yield row


def iter_links(path: str | Path,
               progress: Callable[[str], None] | None = None) -> Iterator[dict]:
    """Yield one row dict per ``<link>``, in file order.

    ``modes`` keeps the XML's own comma-joined spelling (``"car,truck"``) and
    ``road_type`` falls back to :data:`DEFAULT_ROAD_TYPE`.
    """
    for _kind, row in _iter_network(path, progress, False, True):
        yield row


def parse_network(path: str | Path,
                  progress: Callable[[str], None] | None = None) -> NetworkData:
    """Read the whole network into memory in one pass."""
    logger.info("parsing network %s", path)
    data = NetworkData()
    append = {"node": data.nodes.append, "link": data.links.append}
    for kind, row in _iter_network(path, progress, True, True):
        append[kind](row)
    logger.info("network: %d nodes, %d links",
                len(data.nodes), len(data.links))
    return data
