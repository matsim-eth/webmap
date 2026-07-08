"""Per-canton destination/origin trip flows for the Destination Zones module.

Backend replacement for the old CDN ``destination_data/{canton}.json`` asset.
Derived from the v2 ``trips`` table (``origin_canton_id`` / ``dest_canton_id`` /
``main_mode`` / ``following_purpose`` / ``departure_time``).

For a hub canton C it returns one record per (other canton, mode, purpose) with
trip counts bucketed into 15-minute bins — the exact array shape
``DestinationZones.jsx`` consumes::

    [{ role, origin, destination, mode, purpose, time_bins: {"HH:MM": count} }]

``role="origin"`` rows are outflow (C → other); ``role="destination"`` rows are
inflow (other → C). Intra-canton trips (other == C) are excluded — the module
visualizes flows *between* cantons (its destination list/arcs already drop the
hub). ``purpose`` is the trip's destination activity (``following_purpose``),
which is what the frontend's purpose filter expects (work/education/shop/leisure).
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor
from .result_cache import make_cache
from .zone_registry import get_registry, zone_col

_cget, _cput = make_cache(maxsize=48)


def _resolve_canton(value: str) -> int | None:
    """Resolve a zone name or ID string to a zone ID integer via the dataset's
    zone registry."""
    return get_registry().resolve_zone(value)


def _bin_key(bin15: int) -> str:
    """15-minute bin index (floor(seconds/900)) → "HH:MM" label.

    Matches the frontend bucketing (idx = h*4 + minute//15). Trips after
    midnight (departure_time ≥ 24 h) yield HH ≥ 24; the frontend's 0–96 slider
    naturally drops them, so they're harmless to include.
    """
    h = bin15 // 4
    m = (bin15 % 4) * 15
    return f"{h:02d}:{m:02d}"


_PARAMS = [
    Param("canton", "Hub canton name or ID", required=True),
    Param("zone", "Hub zone name or ID; alias of canton"),
    Param("source", "Data source", enum=["synthetic", "microcensus"]),
]


class DestinationZonesProvider(DataProvider):
    """Outflow/inflow trip flows for a hub canton, per (canton, mode, purpose).

    Example: /data/{id}/destination_zones.json?canton=Zurich
    """

    ROUTE = "destination_zones.json"
    PARAMS = _PARAMS

    def deliver(self, params: dict):
        raw = (params.get("canton") or params.get("zone") or "").strip()
        if not raw:
            return {"error": "canton parameter is required"}
        cid = _resolve_canton(raw)
        if cid is None:
            return {"error": f"Unknown canton: {raw}"}

        ckey, hit = _cget(self.ROUTE, params)
        if hit is not None:
            return hit

        source = (params.get("source") or "synthetic").strip().lower()
        if source not in ("synthetic", "microcensus"):
            source = "synthetic"
        try:
            cur = get_source_cursor(source)
        except Exception as exc:
            return {"error": f"destination_zones data unavailable: {exc}"}

        reg = get_registry()
        ocol = zone_col(source, "trips", "origin")
        dcol = zone_col(source, "trips", "dest")

        # One scan, both directions. Each row is tagged with the hub's role and
        # the "other" canton; intra-canton trips and rows missing a canton id are
        # excluded. 15-min bin index = floor(departure_time / 900).
        query = f"""
            SELECT role, other_id, main_mode, following_purpose, bin15,
                   COUNT(*)::INTEGER AS cnt
            FROM (
                SELECT 'origin' AS role, {dcol} AS other_id,
                       main_mode, following_purpose,
                       CAST(departure_time // 900 AS INTEGER) AS bin15
                FROM trips
                WHERE {ocol} = ? AND {dcol} IS NOT NULL
                  AND {dcol} <> ?
                UNION ALL
                SELECT 'destination' AS role, {ocol} AS other_id,
                       main_mode, following_purpose,
                       CAST(departure_time // 900 AS INTEGER) AS bin15
                FROM trips
                WHERE {dcol} = ? AND {ocol} IS NOT NULL
                  AND {ocol} <> ?
            )
            GROUP BY role, other_id, main_mode, following_purpose, bin15
        """
        try:
            rows = cur.execute(query, [cid, cid, cid, cid]).fetchall()
        except Exception as exc:
            return {"error": str(exc)}

        hub = reg.zone_name(cid)
        # Collapse to one record per (role, other, mode, purpose) carrying a
        # {"HH:MM": count} time_bins dict.
        records: dict[tuple, dict] = {}
        for role, other_id, mode, purpose, bin15, cnt in rows:
            other = reg.zone_name(other_id)
            key = (role, other_id, mode, purpose)
            rec = records.get(key)
            if rec is None:
                rec = {
                    "role": role,
                    "origin": hub if role == "origin" else other,
                    "destination": other if role == "origin" else hub,
                    "mode": mode,
                    "purpose": purpose,
                    "time_bins": {},
                }
                records[key] = rec
            rec["time_bins"][_bin_key(bin15)] = cnt

        result = list(records.values())
        _cput(ckey, result)
        return result
