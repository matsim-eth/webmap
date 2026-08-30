"""Parse a MATSim ``output_plans.xml(.gz)`` for network-routed trips.

Feeds ``spider_routes`` (and everything derived from it: ``spider_link_index``,
``node_flow_matrix``, the zone-flow link volumes) with the ordered link sequence
of every trip that was actually routed on the network:

    plans = parse_plans("output_plans.xml.gz")
    plans.routes[0]
    # {"person_id": "202340007164886", "trip_index": 0, "route_index": 0,
    #  "departure_time": 14.0, "mode": "car",
    #  "route_links": ["375882", "375884", …]}

Semantics:

* only the **selected** plan of each person is read — the output plans file
  keeps the whole choice set, and the discarded plans hold stale copies of the
  same routes;
* only legs whose ``<route type="links">`` is present, i.e. legs simulated on
  the network. In this run that is ``car`` (117.8 k), ``car_passenger``
  (26.1 k) and freight ``truck`` (2.2 k) — filter by ``mode`` downstream.
  Teleported legs carry ``type="generic"`` and PT legs ``type="default_pt"``,
  and neither has a link sequence;
* ``trip_index`` counts *trips between real activities*, 0-based per person,
  exactly like ``person_trip_id`` in ``eqasim_trips.csv`` and therefore like
  ``trips.trip_index`` in the DuckDB: MATSim's stage activities
  (``"car interaction"``, ``"pt interaction"``, …) split a trip into several
  legs but do not advance the index. This is the column
  ``spider_routes``/``spider_link_index`` are joined on
  (``zone_flows``, ``node_flows``, ``spider_analysis``, ``rezone.py``);
* ``route_index`` is the other numbering: 0..n-1 over the person's routed legs
  *of the same mode*. It exists because the reference dataset's
  ``spider_routes`` uses it — mistakenly, see below — and reproducing that
  dataset needs it.

.. warning::
   The reference dataset ``7036833688`` numbers ``spider_routes.trip_index``
   the ``route_index`` way, so its rows join to the wrong ``trips``: only
   100 151 of its 116 343 rows land on a ``car`` trip. Emit ``trip_index``,
   not ``route_index``, unless you are deliberately reproducing that dataset.
"""

from __future__ import annotations

import gzip
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

logger = logging.getLogger(__name__)

#: MATSim stage-activity marker: ``"car interaction"``, ``"pt interaction"``, …
STAGE_ACTIVITY_SUFFIX = " interaction"

#: ``<route type="…">`` value carrying an ordered link sequence
LINK_ROUTE_TYPE = "links"

_PROGRESS_EVERY = 25_000


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


def parse_time(value: str | None) -> float:
    """``"09:32:56"`` → ``34376.0`` seconds from midnight (``None`` → 0.0)."""
    if not value:
        return 0.0
    parts = value.split(":")
    try:
        if len(parts) == 3:
            h, m, s = parts
            return int(h) * 3600 + int(m) * 60 + float(s)
        return float(value)
    except ValueError:
        return 0.0


# ─── public API ────────────────────────────────────────────────────────────

@dataclass
class PlansData:
    """The network-routed trips of every person's selected plan."""

    #: ``[{person_id, trip_index, route_index, departure_time, mode,
    #: route_links}]``
    routes: list[dict] = field(default_factory=list)


def _selected_plan(person):
    """The person's selected plan, or the only/first one as a fallback."""
    first = None
    for plan in person.iterfind("plan"):
        if plan.get("selected") == "yes":
            return plan
        if first is None:
            first = plan
    return first


def _person_routes(person, pool: dict[str, str]) -> list[dict]:
    """Every ``type="links"`` leg of the person's selected plan."""
    plan = _selected_plan(person)
    if plan is None:
        return []
    person_id = person.get("id")
    routes: list[dict] = []
    n_activities = 0  # real (non-stage) activities seen so far
    per_mode: dict[str, int] = {}  # routed legs seen so far, per mode
    for child in plan:
        tag = child.tag
        if tag == "activity":
            act_type = child.get("type") or ""
            if not act_type.endswith(STAGE_ACTIVITY_SUFFIX):
                n_activities += 1
        elif tag == "leg":
            route = child.find("route")
            if route is None or route.get("type") != LINK_ROUTE_TYPE:
                continue
            links = (route.text or "").split()
            if not links:
                continue
            mode = child.get("mode") or ""
            route_index = per_mode.get(mode, 0)
            per_mode[mode] = route_index + 1
            routes.append({
                "person_id": person_id,
                # legs after the k-th real activity belong to trip k-1
                "trip_index": max(n_activities - 1, 0),
                "route_index": route_index,
                "departure_time": parse_time(child.get("dep_time")),
                "mode": pool.setdefault(mode, mode),
                "route_links": [pool.setdefault(link, link) for link in links],
            })
    return routes


def parse_plans(path: str | Path,
                progress: Callable[[str], None] | None = None) -> PlansData:
    """Stream the plans file and collect its network routes."""
    logger.info("parsing plans %s", path)
    data = PlansData()
    # ~1.9 M distinct link ids shared across ~6 M route entries
    pool: dict[str, str] = {}
    n_persons = 0

    with _open(path) as fh:
        for _, elem in etree.iterparse(fh, events=("end",), tag="person",
                                       huge_tree=True):
            data.routes.extend(_person_routes(elem, pool))
            n_persons += 1
            if progress is not None and n_persons % _PROGRESS_EVERY == 0:
                progress(f"plans: {n_persons:,} persons parsed")
            _drop(elem)

    logger.info("plans: %d persons, %d network routes",
                n_persons, len(data.routes))
    if progress is not None:
        progress(f"plans: {n_persons:,} persons / {len(data.routes):,} routes parsed")
    return data
