"""Parse a MATSim ``output_events.xml(.gz)`` into link volumes and boardings.

This is the expensive one: the Swiss 1 % run ships 95.9 M events in a 930 MB
gzip. Everything is accumulated in one streaming pass into four products:

``link_bins``   ``(link_id, time_bin) → {volume, sum_travel_time,
                sum_inv_travel_time, n_travel_times}`` feeds ``link_speeds``.
``boardings``   ``(stop_facility_id, line_id, route_id, hour) → {boardings,
                alightings}`` feeds ``boarding_data_by_line``. Raw counts —
                scaling by ``1/sample_rate`` is ``ingest.py``'s business.
``pt_link_bins`` ``(link_id, line_id, route_id, time_bin) → passengers`` feeds
                ``pt_link_volumes``: **passengers on board** while a vehicle of
                that route traverses the link, summed over departures — *not* a
                vehicle count (see below).
``transfers``   ``stop_facility_id → {in, out, lines, dests}`` feeds
                ``stop_transfer_data_by_canton``.

Semantics are aligned with the pipeline that produced the reference dataset
(``eqasim-switzerland@webmap_export``, ``analysis/webmap_export/
events_extras.py``); every deviation is called out in place.

Memory is the design constraint. The Swiss run touches ~1.13 M links × 96 bins,
of which ~25 M cells are non-empty; a plain ``dict`` keyed by tuples would cost
~8 GB, so :class:`LinkBins` and :class:`PtLinkBins` are compact array/int-packed
containers that *implement the read-only mapping protocol* — ``bins[key]``,
``for key in bins``, ``bins.items()``, ``len(bins)`` all behave as documented
above, at ~2 GB for the whole run.

.. warning::
   ``LinkBins.items()`` / ``PtLinkBins.items()`` return **generators**, not
   ``ItemsView``. Iterate them (that is what a DuckDB ``executemany`` wants);
   do not call ``dict(bins)`` on the full-run result unless you have the ~8 GB.

Two definitions of "volume"
---------------------------
``link_bins`` reports both, because the two sources disagree:

* ``volume`` — every vehicle *entering* the link: an ``entered link`` event or a
  ``vehicle enters traffic`` event (MATSim's own ``VolumesAnalyzer`` counts
  both, and a trip's first link is only ever reported by the latter). This is
  what ``docs/duckdb-format.md`` specifies for ``link_speeds.volume``.
* ``n_travel_times`` — completed traversals only (an ``entered link`` matched by
  the ``left link`` of the same vehicle on the same link, with a positive
  travel time). This is what the reference pipeline actually wrote into
  ``link_speeds.volume``; on this run it is ~1.3 % lower.

``avg_speed`` has the same fork. The reference stores the **mean of the
per-traversal speeds**, reproducible as ``length * sum_inv_travel_time / n``;
``length / (sum_travel_time / n)`` (the space-mean speed) is the alternative.
Pick one in ``ingest.py`` — both are one field away.

Times beyond the 24 h horizon
-----------------------------
MATSim keeps simulating past midnight (this run reaches 30:00:00). Times
**wrap into the day**: ``time_bin = (t % 86400) // 900`` and
``hour = (t % 86400) // 3600``, matching the reference pipeline — a 24:30
departure lands in bin 2, not in a dropped tail and not clamped into bin 95.
``stats["entries_after_24h"]`` / ``stats["boardings_after_24h"]`` report how
much traffic that is.
"""

from __future__ import annotations

import gzip
import logging
from array import array
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

logger = logging.getLogger(__name__)

#: 15-minute slots in a day — the ``time_bin`` domain (0..95).
BINS_PER_DAY = 96
BIN_SECONDS = 900
DAY_SECONDS = 86400

#: PT stop pseudo-links (``pt_8503003``) — they exist in the events *and* in
#: the network XML; counted separately so link totals can be compared.
PT_LINK_PREFIX = "pt_"

#: MATSim names PT driver agents ``pt_<line>_<route>_<departure>``. They board
#: their own vehicle and must not count as passengers. The driver is normally
#: identified by the ``TransitDriverStarts`` id; the prefix is the fallback for
#: a vehicle whose driver event has not been seen yet.
DRIVER_PREFIX = "pt_"

#: activity types ending in this are MATSim's stage connectors, not real
#: destinations — a journey continues across them (used for transfer detection)
STAGE_ACTIVITY_SUFFIX = "interaction"

#: links allocated per array growth step in :class:`LinkBins`
_GROW_LINKS = 8192
#: events between progress callbacks / element-tree flushes (the flush interval
#: must divide the progress interval — the checks are nested to keep the hot
#: loop down to one modulo per event)
_PROGRESS_EVERY = 1_000_000
_FLUSH_EVERY = 5_000

# bit layout of a packed PtLinkBins key: link_row | route_row | time_bin
_BIN_BITS = 7
_ROUTE_BITS = 20
_ROUTE_SHIFT = _BIN_BITS
_LINK_SHIFT = _BIN_BITS + _ROUTE_BITS
_ROUTE_MASK = (1 << _ROUTE_BITS) - 1
_BIN_MASK = (1 << _BIN_BITS) - 1


def time_bin(t: float) -> int:
    """Seconds from midnight → 15-minute slot ``0..95``, wrapping past 24 h."""
    return int(t % DAY_SECONDS) // BIN_SECONDS


def hour_of_day(t: float) -> int:
    """Seconds from midnight → hour ``0..23``, wrapping past 24 h."""
    return int(t % DAY_SECONDS) // 3600


# ─── containers ────────────────────────────────────────────────────────────

class LinkBins(Mapping):
    """``(link_id, time_bin) → {volume, sum_travel_time, sum_inv_travel_time,
    n_travel_times}``.

    Backed by four dense ``array`` rows of 96 slots per link seen, which is
    ~4× cheaper than a sparse dict of tuples at the observed fill rate. Only
    cells that were actually touched are exposed.
    """

    __slots__ = ("_row", "_links", "_volume", "_n_tt", "_sum_tt", "_sum_inv_tt",
                 "_capacity", "_cells")

    def __init__(self) -> None:
        self._row: dict[str, int] = {}
        self._links: list[str] = []
        self._volume = array("i")
        self._n_tt = array("i")
        self._sum_tt = array("f")
        self._sum_inv_tt = array("f")
        self._capacity = 0
        self._cells = 0

    # -- accumulation (hot path) --
    def _grow(self) -> None:
        zeros = bytes(4 * BINS_PER_DAY * _GROW_LINKS)
        self._volume.frombytes(zeros)
        self._n_tt.frombytes(zeros)
        self._sum_tt.frombytes(zeros)
        self._sum_inv_tt.frombytes(zeros)
        self._capacity += _GROW_LINKS

    def _index(self, link_id: str, bin_index: int) -> int:
        row = self._row.get(link_id)
        if row is None:
            row = len(self._links)
            self._links.append(link_id)
            self._row[link_id] = row
            if row >= self._capacity:
                self._grow()
        return row * BINS_PER_DAY + bin_index

    def add_entry(self, link_id: str, bin_index: int) -> None:
        """Count one vehicle entering ``link_id`` during ``bin_index``."""
        i = self._index(link_id, bin_index)
        volume = self._volume[i]
        if volume == 0 and self._n_tt[i] == 0:
            self._cells += 1
        self._volume[i] = volume + 1

    def add_travel_time(self, link_id: str, bin_index: int, seconds: float) -> None:
        """Record one completed traversal, attributed to its *entry* bin."""
        i = self._index(link_id, bin_index)
        if self._volume[i] == 0 and self._n_tt[i] == 0:
            self._cells += 1
        self._n_tt[i] += 1
        self._sum_tt[i] += seconds
        self._sum_inv_tt[i] += 1.0 / seconds

    # -- mapping protocol --
    def _value(self, i: int) -> dict:
        return {
            "volume": self._volume[i],
            "sum_travel_time": float(self._sum_tt[i]),
            "sum_inv_travel_time": float(self._sum_inv_tt[i]),
            "n_travel_times": self._n_tt[i],
        }

    def __getitem__(self, key: tuple[str, int]) -> dict:
        link_id, bin_index = key
        row = self._row.get(link_id)
        if row is None or not 0 <= bin_index < BINS_PER_DAY:
            raise KeyError(key)
        i = row * BINS_PER_DAY + bin_index
        if self._volume[i] == 0 and self._n_tt[i] == 0:
            raise KeyError(key)
        return self._value(i)

    def __len__(self) -> int:
        return self._cells

    def __iter__(self):
        for key, _value in self.items():
            yield key

    def items(self):
        """Yield ``((link_id, time_bin), value)`` for every non-empty cell."""
        volume, n_tt = self._volume, self._n_tt
        sum_tt, sum_inv = self._sum_tt, self._sum_inv_tt
        for row, link_id in enumerate(self._links):
            base = row * BINS_PER_DAY
            v_row = volume[base:base + BINS_PER_DAY].tolist()
            n_row = n_tt[base:base + BINS_PER_DAY].tolist()
            for bin_index in range(BINS_PER_DAY):
                v = v_row[bin_index]
                n = n_row[bin_index]
                if v or n:
                    i = base + bin_index
                    yield (link_id, bin_index), {
                        "volume": v,
                        "sum_travel_time": float(sum_tt[i]),
                        "sum_inv_travel_time": float(sum_inv[i]),
                        "n_travel_times": n,
                    }

    def link_ids(self) -> list[str]:
        """Every link that saw at least one vehicle, in first-seen order."""
        return list(self._links)


class PtLinkBins(Mapping):
    """``(link_id, line_id, route_id, time_bin) → passengers``.

    Sparse — a PT route touches a link in only a couple of bins a day — so this
    packs the three ids into one integer key instead of holding millions of
    tuples.
    """

    __slots__ = ("_counts", "_link_row", "_links", "_route_row", "_routes")

    def __init__(self) -> None:
        self._counts: dict[int, int] = {}
        self._link_row: dict[str, int] = {}
        self._links: list[str] = []
        self._route_row: dict[tuple[str, str], int] = {}
        self._routes: list[tuple[str, str]] = []

    def _key(self, link_id: str, line_id: str, route_id: str,
             bin_index: int) -> int:
        link_row = self._link_row.get(link_id)
        if link_row is None:
            link_row = self._link_row[link_id] = len(self._links)
            self._links.append(link_id)
        route = (line_id, route_id)
        route_row = self._route_row.get(route)
        if route_row is None:
            route_row = self._route_row[route] = len(self._routes)
            if route_row > _ROUTE_MASK:
                raise ValueError(f"more than {_ROUTE_MASK} transit routes")
            self._routes.append(route)
        return (link_row << _LINK_SHIFT) | (route_row << _ROUTE_SHIFT) | bin_index

    def add(self, link_id: str, line_id: str, route_id: str, bin_index: int,
            passengers: int) -> None:
        """Add ``passengers`` carried over ``link_id`` by that route."""
        key = self._key(link_id, line_id, route_id, bin_index)
        counts = self._counts
        counts[key] = counts.get(key, 0) + passengers

    def _unpack(self, key: int) -> tuple[str, str, str, int]:
        line_id, route_id = self._routes[(key >> _ROUTE_SHIFT) & _ROUTE_MASK]
        return (self._links[key >> _LINK_SHIFT], line_id, route_id,
                key & _BIN_MASK)

    def __getitem__(self, key: tuple[str, str, str, int]) -> int:
        link_id, line_id, route_id, bin_index = key
        link_row = self._link_row.get(link_id)
        route_row = self._route_row.get((line_id, route_id))
        if link_row is None or route_row is None:
            raise KeyError(key)
        packed = ((link_row << _LINK_SHIFT) | (route_row << _ROUTE_SHIFT)
                  | bin_index)
        try:
            return self._counts[packed]
        except KeyError:
            raise KeyError(key) from None

    def __len__(self) -> int:
        return len(self._counts)

    def __iter__(self):
        unpack = self._unpack
        for key in self._counts:
            yield unpack(key)

    def items(self):
        """Yield ``((link_id, line_id, route_id, time_bin), passengers)``."""
        unpack = self._unpack
        for key, volume in self._counts.items():
            yield unpack(key), volume

    def hourly(self) -> dict[tuple[str, str, str, int], int]:
        """Re-bucket to whole hours — ``(link, line, route, hour) → passengers``.

        Materialises a plain dict (~3.8 M entries on the Swiss run). Prefer
        :attr:`EventsData.pt_link_bins`: the ``pt_link_volumes`` table is
        15-minute-binned and the webmap indexes it that way.
        """
        out: dict[tuple[str, str, str, int], int] = {}
        for (link_id, line_id, route_id, bin_index), volume in self.items():
            key = (link_id, line_id, route_id, bin_index // 4)
            out[key] = out.get(key, 0) + volume
        return out


@dataclass
class EventsData:
    """One streaming pass over the events file."""

    link_bins: LinkBins = field(default_factory=LinkBins)
    #: ``(stop_facility_id, line_id, route_id, hour) → {boardings, alightings}``
    boardings: dict[tuple[str, str, str, int], dict] = field(default_factory=dict)
    pt_link_bins: PtLinkBins = field(default_factory=PtLinkBins)
    #: transfer stop → ``{"in", "out", "lines": {from_line: {to_line: n}},
    #: "dests": {egress_stop: n}}`` — a transfer is a boarding with a previous
    #: PT alighting and no real activity in between, attributed to the stop the
    #: passenger alighted at
    transfers: dict[str, dict] = field(default_factory=dict)
    #: counters for logging / sanity checks, see :func:`parse_events`
    stats: dict[str, float] = field(default_factory=dict)

    @property
    def pt_link_hourly(self) -> dict[tuple[str, str, str, int], int]:
        """Hourly view of :attr:`pt_link_bins` (materialised on each access)."""
        return self.pt_link_bins.hourly()


# ─── streaming helpers ─────────────────────────────────────────────────────

def _open(path: str | Path):
    """Open ``path`` as a binary stream, transparently gunzipping ``.gz``."""
    path = str(path)
    return gzip.open(path, "rb") if path.endswith(".gz") else open(path, "rb")


# ─── public API ────────────────────────────────────────────────────────────

def parse_events(
    path: str | Path,
    vehicle_to_route: dict[str, tuple[str, str, str]] | None = None,
    progress: Callable[[str], None] | None = None,
) -> EventsData:
    """Accumulate link volumes, travel times, PT boardings and transfers.

    ``vehicle_to_route`` is :attr:`parsers.transit.TransitData.vehicle_to_route`
    and only seeds the "is this a PT vehicle" test — the authoritative
    line/route per vehicle comes from the ``TransitDriverStarts`` events in the
    stream itself, so a vehicle reused across routes is still attributed
    correctly.

    Returns an :class:`EventsData` whose ``stats`` carries the raw event
    counters used to validate a run (``entered_link``, ``enters_traffic``,
    ``entries_after_24h``, ``boardings``, ``driver_boardings_skipped``, …).
    """
    logger.info("parsing events %s", path)
    data = EventsData()
    link_bins = data.link_bins
    pt_bins = data.pt_link_bins
    boardings = data.boardings
    transfers = data.transfers
    add_entry = link_bins.add_entry
    add_travel_time = link_bins.add_travel_time
    pt_add = pt_bins.add

    # vehicle → (line_id, route_id, mode). Pre-seeded from the schedule so the
    # very first link event of a PT vehicle is already recognised; each
    # TransitDriverStarts then pins the vehicle to the departure it is running.
    veh_route: dict[str, tuple[str, str, str]] = dict(vehicle_to_route or {})
    route_mode = {(line, route): mode
                  for line, route, mode in veh_route.values()}
    veh_driver: dict[str, str] = {}
    veh_stop: dict[str, str] = {}
    veh_pax: dict[str, int] = {}
    # vehicle → (link_id, entry_time); entry_time < 0 means "no travel time"
    # (the vehicle materialised part-way along the link)
    veh_pos: dict[str, tuple[str, float]] = {}
    # vehicle → link it was parked on, for the stale-traversal counter below
    veh_parked: dict[str, str] = {}
    # person → (line, alight stop) of the last PT alighting not yet closed by a
    # real activity, and the stop a boarded transfer still owes its egress to
    last_alight: dict[str, tuple[str, str]] = {}
    pending_egress: dict[str, str] = {}

    n_events = 0
    n_entered = 0
    n_enters_traffic = 0
    n_left = 0
    n_entered_pt_link = 0
    n_enters_traffic_pt_link = 0
    n_after_24h = 0
    n_travel_times = 0
    n_zero_travel_times = 0
    n_unmatched_left = 0
    n_stale_traversals = 0
    n_boardings = 0
    n_alightings = 0
    n_boardings_after_24h = 0
    n_driver_skipped = 0
    n_no_stop = 0
    n_driver_starts = 0
    n_transfers = 0
    max_time = 0.0

    # event times repeat for whole blocks of events — parse each string once
    last_time_str = ""
    last_time = 0.0

    with _open(path) as fh:
        context = etree.iterparse(fh, events=("end",), tag="event",
                                  huge_tree=True)
        root = None
        for _, elem in context:
            get = elem.get
            etype = get("type")
            time_str = get("time")
            if time_str != last_time_str:
                last_time_str = time_str
                last_time = float(time_str)
            t = last_time

            if etype == "entered link":
                n_entered += 1
                link = get("link")
                vehicle = get("vehicle")
                if link.startswith(PT_LINK_PREFIX):
                    n_entered_pt_link += 1
                if t >= DAY_SECONDS:
                    n_after_24h += 1
                add_entry(link, int(t % DAY_SECONDS) // BIN_SECONDS)
                veh_pos[vehicle] = (link, t)

            elif etype == "left link":
                n_left += 1
                vehicle = get("vehicle")
                position = veh_pos.pop(vehicle, None)
                if position is None:
                    if veh_parked.pop(vehicle, None) == get("link"):
                        n_stale_traversals += 1
                    else:
                        n_unmatched_left += 1
                else:
                    link, entered_at = position
                    if entered_at < 0.0:
                        # Partial traversal — the vehicle entered traffic
                        # part-way along the link. If it had parked on that same
                        # link, the reference pipeline still holds the entry it
                        # made *before* the activity and books a traversal
                        # spanning the whole stop; we drop it and count how
                        # often the two disagree.
                        if veh_parked.pop(vehicle, None) == link:
                            n_stale_traversals += 1
                    elif link != get("link"):
                        n_unmatched_left += 1
                    else:
                        entry_bin = int(entered_at % DAY_SECONDS) // BIN_SECONDS
                        route = veh_route.get(vehicle)
                        if route is not None:
                            pax = veh_pax.get(vehicle, 0)
                            if pax > 0:
                                pt_add(link, route[0], route[1], entry_bin, pax)
                        if t > entered_at:
                            add_travel_time(link, entry_bin, t - entered_at)
                            n_travel_times += 1
                        else:
                            n_zero_travel_times += 1

            elif etype == "vehicle enters traffic":
                # the vehicle materialises part-way along the link: it counts
                # as an entry but its traversal is partial, so no travel time
                n_enters_traffic += 1
                link = get("link")
                if link.startswith(PT_LINK_PREFIX):
                    n_enters_traffic_pt_link += 1
                if t >= DAY_SECONDS:
                    n_after_24h += 1
                add_entry(link, int(t % DAY_SECONDS) // BIN_SECONDS)
                veh_pos[get("vehicle")] = (link, -1.0)

            elif etype == "vehicle leaves traffic":
                vehicle = get("vehicle")
                position = veh_pos.pop(vehicle, None)
                if position is not None:
                    veh_parked[vehicle] = position[0]

            elif etype == "PersonEntersVehicle" or etype == "PersonLeavesVehicle":
                vehicle = get("vehicle")
                route = veh_route.get(vehicle)
                if route is not None:
                    person = get("person")
                    if person == veh_driver.get(vehicle) or \
                            person.startswith(DRIVER_PREFIX):
                        n_driver_skipped += 1
                    else:
                        line_id = route[0]
                        boarding = etype == "PersonEntersVehicle"
                        # occupancy must be tracked even with an unknown stop
                        veh_pax[vehicle] = max(
                            0, veh_pax.get(vehicle, 0) + (1 if boarding else -1))
                        stop = veh_stop.get(vehicle)
                        if stop is None:
                            n_no_stop += 1
                        else:
                            hour = int(t % DAY_SECONDS) // 3600
                            if t >= DAY_SECONDS:
                                n_boardings_after_24h += 1
                            key = (stop, line_id, route[1], hour)
                            record = boardings.get(key)
                            if record is None:
                                record = boardings[key] = {"boardings": 0,
                                                           "alightings": 0}
                            if boarding:
                                record["boardings"] += 1
                                n_boardings += 1
                                previous = last_alight.pop(person, None)
                                if previous is not None:
                                    # boarding again without a real activity in
                                    # between: a transfer at the alighting stop
                                    from_line, transfer_stop = previous
                                    entry = transfers.get(transfer_stop)
                                    if entry is None:
                                        entry = transfers[transfer_stop] = {
                                            "in": 0, "out": 0, "lines": {},
                                            "dests": {}}
                                    entry["in"] += 1
                                    entry["out"] += 1
                                    onward = entry["lines"].setdefault(
                                        from_line, {})
                                    onward[line_id] = onward.get(line_id, 0) + 1
                                    pending_egress[person] = transfer_stop
                                    n_transfers += 1
                            else:
                                record["alightings"] += 1
                                n_alightings += 1
                                transfer_stop = pending_egress.pop(person, None)
                                if transfer_stop is not None:
                                    dests = transfers[transfer_stop]["dests"]
                                    dests[stop] = dests.get(stop, 0) + 1
                                last_alight[person] = (line_id, stop)

            elif etype == "VehicleArrivesAtFacility":
                veh_stop[get("vehicle")] = get("facility")

            elif etype == "TransitDriverStarts":
                n_driver_starts += 1
                vehicle = get("vehicleId")
                line_id = get("transitLineId")
                route_id = get("transitRouteId")
                veh_route[vehicle] = (line_id, route_id,
                                      route_mode.get((line_id, route_id), ""))
                veh_driver[vehicle] = get("driverId")
                veh_pax[vehicle] = 0  # the vehicle starts a new departure

            elif etype == "actstart" or etype == "actend":
                # a real activity ends the journey: the previous PT alighting
                # can no longer become a transfer
                act_type = get("actType") or ""
                if not act_type.endswith(STAGE_ACTIVITY_SUFFIX):
                    last_alight.pop(get("person"), None)

            n_events += 1
            if t > max_time:
                max_time = t
            if n_events % _FLUSH_EVERY == 0:
                if root is None:
                    root = elem.getparent()
                if root is not None:
                    root.clear()
                if progress is not None and n_events % _PROGRESS_EVERY == 0:
                    progress(f"events: {n_events / 1e6:.1f}M parsed")

    data.stats = {
        "events": n_events,
        "entered_link": n_entered,
        "enters_traffic": n_enters_traffic,
        "left_link": n_left,
        "entered_link_pt_pseudo": n_entered_pt_link,
        "enters_traffic_pt_pseudo": n_enters_traffic_pt_link,
        "entries_after_24h": n_after_24h,
        "travel_times": n_travel_times,
        "zero_travel_times": n_zero_travel_times,
        "unmatched_left_link": n_unmatched_left,
        "stale_traversals_skipped": n_stale_traversals,
        "boardings": n_boardings,
        "alightings": n_alightings,
        "boardings_after_24h": n_boardings_after_24h,
        "driver_boardings_skipped": n_driver_skipped,
        "boardings_without_stop": n_no_stop,
        "transit_driver_starts": n_driver_starts,
        "transfers": n_transfers,
        "max_time": max_time,
        "link_bin_cells": len(link_bins),
        "pt_link_bin_cells": len(pt_bins),
        "boarding_cells": len(boardings),
        "transfer_stops": len(transfers),
    }
    logger.info(
        "events: %d parsed, %d link entries in %d cells, %d boardings, "
        "%d transfers", n_events, n_entered + n_enters_traffic,
        len(link_bins), n_boardings, n_transfers,
    )
    if progress is not None:
        progress(f"events: {n_events / 1e6:.1f}M parsed (done)")
    return data
