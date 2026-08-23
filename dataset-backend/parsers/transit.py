"""Parse a MATSim ``output_transitSchedule.xml(.gz)``.

Yields the three things the rest of the pipeline needs from the schedule:

* **stops** — the ``<stopFacility>`` table. Its ids are already the composite
  ``"8503003:0:3.link:pt_8503003:0:3"`` spelling the webmap joins on
  (``docs/duckdb-format.md`` → *stop_id format*), so nothing has to be rebuilt
  downstream; the part after ``.link:`` is the ``linkRefId``.
* **lines / routes** — ordered stop refs, ordered link refs and the departure
  table per ``<transitRoute>``. The route id carries the direction as a
  ``.H`` / ``.R`` suffix (``"1053.TA.91-1-A-j24-1.1747.H"``), which is what the
  webmap's direction toggle regex-extracts out of ``pt_link_volumes.route_id``.
* **vehicle_to_route** — ``vehicle_id → (line_id, route_id, mode)``, the map
  :func:`parsers.events.parse_events` uses to tell PT vehicles from cars.

    sched = parse_transit_schedule("output_transitSchedule.xml.gz")
    sched.stops["8502204:0:6.link:338123"]["name"]   # "Zug"
    sched.lines[0]["routes"][0]["stop_ids"]          # ordered facility refs

.. warning::
   MATSim reuses one physical vehicle across departures of *different* routes,
   so ``vehicle_to_route`` is lossy by construction (last departure in file
   order wins; the collision count is logged). ``parse_events`` therefore
   prefers the per-departure ``TransitDriverStarts`` events and only falls back
   to this map — do not use it as a day-long truth on its own.
"""

from __future__ import annotations

import gzip
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

logger = logging.getLogger(__name__)

_PROGRESS_EVERY = 1_000


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
    """``"30:15:00"`` → ``108900.0`` seconds from midnight (``None`` → 0.0).

    MATSim clocks run past 24 h; nothing is wrapped here.
    """
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
class TransitData:
    """The schedule, flattened."""

    #: facility id → ``{x, y, name, link_ref}``
    stops: dict[str, dict] = field(default_factory=dict)
    #: ``[{line_id, line_name, routes: [{route_id, mode, stop_ids, link_ids,
    #: departures: [{vehicle_id, time}]}]}]``
    lines: list[dict] = field(default_factory=list)
    #: vehicle id → ``(line_id, route_id, mode)`` — lossy, see module docstring
    vehicle_to_route: dict[str, tuple[str, str, str]] = field(default_factory=dict)

    def flat_routes(self) -> list[dict]:
        """One dict per ``<transitRoute>``, line fields folded in.

        ``{line_id, line_name, route_id, mode, link_refs, stop_refs,
        n_departures}`` — the shape the ``transit_routes`` geometry,
        ``route_directions`` and ``pt_link_volumes`` builders want (a route's
        geometry is its ``link_refs``; its direction is the ``.H``/``.R``
        suffix of ``route_id``; its weight is ``n_departures``).
        """
        return [
            {
                "line_id": line["line_id"],
                "line_name": line["line_name"],
                "route_id": route["route_id"],
                "mode": route["mode"],
                "link_refs": route["link_ids"],
                "stop_refs": route["stop_ids"],
                "n_departures": len(route["departures"]),
            }
            for line in self.lines
            for route in line["routes"]
        ]


def _parse_stop(elem) -> tuple[str, dict]:
    get = elem.get
    return get("id"), {
        "x": float(get("x")),
        "y": float(get("y")),
        "name": get("name") or "",
        "link_ref": get("linkRefId") or "",
    }


def _parse_line(elem, pool: dict[str, str]) -> tuple[dict, list[tuple[str, tuple]]]:
    """Return the line dict plus its ``(vehicle_id, (line, route, mode))`` pairs."""
    line_id = elem.get("id")
    line = {
        "line_id": line_id,
        "line_name": elem.get("name") or line_id,
        "routes": [],
    }
    assignments: list[tuple[str, tuple]] = []
    for route_el in elem.iterfind("transitRoute"):
        route_id = route_el.get("id")
        mode_el = route_el.find("transportMode")
        mode = (mode_el.text or "").strip() if mode_el is not None else ""
        mode = pool.setdefault(mode, mode)

        stop_ids = [s.get("refId")
                    for s in route_el.iterfind("routeProfile/stop")]
        link_ids = [pool.setdefault(link.get("refId"), link.get("refId"))
                    for link in route_el.iterfind("route/link")]

        departures = []
        for dep in route_el.iterfind("departures/departure"):
            vehicle_id = dep.get("vehicleRefId")
            departures.append({
                "vehicle_id": vehicle_id,
                "time": parse_time(dep.get("departureTime")),
            })
            if vehicle_id:
                assignments.append((vehicle_id, (line_id, route_id, mode)))

        line["routes"].append({
            "route_id": route_id,
            "mode": mode,
            "stop_ids": stop_ids,
            "link_ids": link_ids,
            "departures": departures,
        })
    return line, assignments


def parse_transit_schedule(
    path: str | Path,
    progress: Callable[[str], None] | None = None,
) -> TransitData:
    """Stream the transit schedule into a :class:`TransitData`."""
    logger.info("parsing transit schedule %s", path)
    data = TransitData()
    # link ids and mode strings repeat across tens of thousands of routes
    pool: dict[str, str] = {}
    n_routes = 0
    n_departures = 0
    n_vehicle_collisions = 0

    with _open(path) as fh:
        for _, elem in etree.iterparse(fh, events=("end",),
                                       tag=("stopFacility", "transitLine"),
                                       huge_tree=True):
            if elem.tag == "stopFacility":
                stop_id, stop = _parse_stop(elem)
                data.stops[stop_id] = stop
                if progress is not None and len(data.stops) % 10_000 == 0:
                    progress(f"transit: {len(data.stops):,} stops parsed")
            else:
                line, assignments = _parse_line(elem, pool)
                data.lines.append(line)
                n_routes += len(line["routes"])
                for vehicle_id, target in assignments:
                    n_departures += 1
                    previous = data.vehicle_to_route.get(vehicle_id)
                    if previous is not None and previous != target:
                        n_vehicle_collisions += 1
                    data.vehicle_to_route[vehicle_id] = target
                if progress is not None and len(data.lines) % _PROGRESS_EVERY == 0:
                    progress(f"transit: {len(data.lines):,} lines parsed")
            _drop(elem)

    logger.info(
        "transit: %d stops, %d lines, %d routes, %d departures, %d vehicles",
        len(data.stops), len(data.lines), n_routes, n_departures,
        len(data.vehicle_to_route),
    )
    if n_vehicle_collisions:
        logger.warning(
            "transit: %d departures reuse a vehicle across routes — "
            "vehicle_to_route keeps the last one (events use TransitDriverStarts)",
            n_vehicle_collisions,
        )
    if progress is not None:
        progress(f"transit: {len(data.lines):,} lines / {n_routes:,} routes parsed")
    return data
