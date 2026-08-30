"""Streaming parsers for the MATSim output XML files.

One module per input file of a MATSim run, each exposing a single
``parse_*`` entry point that returns a plain dataclass:

    output_network.xml.gz          → :func:`parse_network`          → NetworkData
    output_transitSchedule.xml.gz  → :func:`parse_transit_schedule` → TransitData
    output_events.xml.gz           → :func:`parse_events`           → EventsData
    output_plans.xml.gz            → :func:`parse_plans`            → PlansData

Everything is parsed with ``lxml.etree.iterparse`` (tag-filtered, siblings
deleted as we go), so a 930 MB gzipped events file streams in bounded memory.
``.gz`` inputs are opened transparently; plain ``.xml`` works too.

Every entry point takes an optional ``progress`` callback::

    parse_events(path, veh2route, progress=lambda msg: print(msg))

called every so often with a short human-readable string
(``"events: 12.0M parsed"``) so the caller can log or stream a status line.

Conventions shared with ``docs/duckdb-format.md``:

* coordinates are LV95 / EPSG:2056 exactly as written in the XML — nothing is
  reprojected here;
* times are **seconds from midnight** (MATSim simulates past 24 h, so values
  ``>= 86400`` do occur and are handled per-parser, see :mod:`parsers.events`);
* ``time_bin`` is the 15-minute slot index ``0..95``.

The parsers are deliberately dumb: they report what the XML says, do not join
across files (beyond the vehicle → route map events needs) and never touch
DuckDB. Assembling tables, canton tagging and scaling all happen in
``ingest.py``.
"""

from .events import EventsData, LinkBins, PtLinkBins, parse_events
from .network import NetworkData, iter_links, iter_nodes, parse_network
from .plans import PlansData, parse_plans
from .transit import TransitData, parse_transit_schedule

__all__ = [
    "EventsData",
    "LinkBins",
    "NetworkData",
    "PlansData",
    "PtLinkBins",
    "TransitData",
    "iter_links",
    "iter_nodes",
    "parse_events",
    "parse_network",
    "parse_plans",
    "parse_transit_schedule",
]
