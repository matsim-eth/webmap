"""Per-canton destination/origin trip flows for the Destination Zones module.

Backend replacement for the old CDN ``destination_data/{canton}.json`` asset.
Derived from the v2 ``trips`` table (``origin_canton_id`` / ``dest_canton_id`` /
``main_mode`` / ``following_purpose`` / ``departure_time``).

For a hub canton C it returns one record per (other canton, mode, purpose) with
trip counts bucketed into 15-minute bins — the exact array shape
``DestinationZones.jsx`` consumes::

    [{ role, origin, destination, mode, purpose, time_bins: {"HH:MM": count} }]

``role="origin"`` rows are outflow (C → other); ``role="destination"`` rows are
inflow (other → C). Intra-canton trips (other == C) are included in both role
branches — the frontend shows them as a pinned "Within C" list row and scales
the hub marker by them (its arcs still drop the hub, so no self-loop arc is
drawn). ``purpose`` is the trip's destination activity (``following_purpose``),
which is what the frontend's purpose filter expects (work/education/shop/leisure).

Query params
------------
canton         (str, required)  : Hub canton name or ID.
zone           (str)            : Hub zone name or ID; alias of canton.
source         (str)            : Data source (default "synthetic").
gender         (str)            : "0" (male) or "1" (female) → persons.sex.
age_min        (int)            : Inclusive lower age bound → persons.age.
age_max        (int)            : Exclusive upper age bound → persons.age.
income_class   (str)            : Comma-separated income classes → households.income_class.
subscription   (str)            : Comma-separated PT subscriptions (ga,halbtax,…); match if ANY selected.
"""

from __future__ import annotations

from .base import DataProvider, Param
from .connection import get_source_cursor
from .helpers import socio_trip_filter
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
    Param("gender", "Person sex filter", enum=["0", "1"]),
    Param("age_min", "Inclusive lower age bound", param_type="integer"),
    Param("age_max", "Exclusive upper age bound", param_type="integer"),
    Param("income_class", "Household income class(es), comma-separated"),
    Param("subscription", "PT subscription(s), comma-separated (ga,halbtax,…); match if ANY selected"),
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

        # Optional socioeconomic person filters (gender/age/income/subscription).
        # Empty strings when no socio param is set, so the common path is
        # unchanged. Both UNION branches scan `trips`, so both carry the join.
        socio_join, socio_where = socio_trip_filter(params, trip_alias="t")

        # One scan, both directions. Each row is tagged with the hub's role and
        # the "other" canton; rows missing a canton id are excluded. Intra-canton
        # trips (other == hub) appear once per role branch, which is once per
        # direction view since the frontend filters by role. 15-min bin index =
        # floor(departure_time / 900).
        query = f"""
            SELECT role, other_id, main_mode, following_purpose, bin15,
                   COUNT(*)::INTEGER AS cnt
            FROM (
                SELECT 'origin' AS role, t.{dcol} AS other_id,
                       t.main_mode, t.following_purpose,
                       CAST(t.departure_time // 900 AS INTEGER) AS bin15
                FROM trips t
                {socio_join}
                WHERE t.{ocol} = ? AND t.{dcol} IS NOT NULL
                  {socio_where}
                UNION ALL
                SELECT 'destination' AS role, t.{ocol} AS other_id,
                       t.main_mode, t.following_purpose,
                       CAST(t.departure_time // 900 AS INTEGER) AS bin15
                FROM trips t
                {socio_join}
                WHERE t.{dcol} = ? AND t.{ocol} IS NOT NULL
                  {socio_where}
            )
            GROUP BY role, other_id, main_mode, following_purpose, bin15
        """
        try:
            rows = cur.execute(query, [cid, cid]).fetchall()
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


def warm() -> None:
    """Prime the module for the dataset currently in scope (called by
    ``warmup.WARM_STEPS``).

    Runs the real query for the lowest-numbered zone rather than a synthetic
    "touch the columns" scan: the WHERE is on the origin/dest id, so DuckDB
    reads the whole ``trips`` table either way, and using an actual hub
    additionally leaves that hub's result in the cache. Every *other* hub is
    fast afterwards too — what makes the first request expensive is paging the
    trips columns in, not the group-by."""
    zones = get_registry().zones_sorted()
    if not zones:
        return
    DestinationZonesProvider().deliver({"canton": str(zones[0][0])})
