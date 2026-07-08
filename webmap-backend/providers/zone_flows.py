"""Traffic flows between origin and destination cantons (v2 schema).

Selects car trips that start in one canton and end in another, then returns
the link-level volumes of those trips' routes (car only — only car routes are
stored in ``spider_routes``), grouped by the canton each link passes through.

Uses the precomputed canton columns from the pipeline — ``trips`` has
``origin_canton_id`` / ``dest_canton_id`` and ``network_links`` has
``canton_id`` — so the whole thing is plain integer joins, no spatial work and
no per-dataset cache.

Query params
------------
origin_canton      (str, required)  : Origin canton name or ID.
destination_canton (str, required)  : Destination canton name or ID.
direction          (str)            : "origin_to_dest", "dest_to_origin", or "both" (default).
source             (str)            : Data source (default "synthetic"; only synthetic has routes).
minute_start       (int, 0-1440)    : Time window start (minutes from midnight).
minute_end         (int, 0-1440)    : Time window end (minutes from midnight).
"""

from __future__ import annotations

import json
from collections import OrderedDict

from .base import DataProvider, Param
from .connection import get_source_cursor
from .result_cache import make_cache
from .zone_registry import get_registry, zone_col

_cget, _cput = make_cache(maxsize=48)


_COORD_DECIMALS = 6  # ~0.1 m — plenty for the map; keeps the payload small


def _round_geom(geom: dict) -> dict:
    """Round LineString/MultiLineString coords in place to _COORD_DECIMALS.

    Deterministic, so a link and its reversed-coordinate twin round identically
    and pair into one segment via _geom_key."""
    t = geom.get("type")
    c = geom.get("coordinates")
    if not c:
        return geom
    if t == "LineString":
        geom["coordinates"] = [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in c]
    elif t == "MultiLineString":
        geom["coordinates"] = [
            [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in line]
            for line in c
        ]
    return geom


def _geom_key(geom: dict) -> str:
    """Direction-independent geometry key (smaller of forward/reversed coord
    sequence) so a link and its reversed twin land in one bucket."""
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "LineString":
        pts = c
    elif t == "MultiLineString":
        pts = [p for line in c for p in line]
    else:
        return ""
    parts = [f"{x},{y}" for x, y in pts]
    fwd = ";".join(parts)
    rev = ";".join(reversed(parts))
    return fwd if fwd <= rev else rev


def _resolve_canton(value: str) -> int | None:
    """Resolve a zone name or ID string to a zone ID integer via the dataset's
    zone registry."""
    return get_registry().resolve_zone(value)


_ZONE_FLOWS_PARAMS = [
    Param("origin_canton", "Origin canton name or ID", required=True),
    Param("destination_canton", "Destination canton name or ID", required=True),
    Param("origin_zone", "Origin zone name or ID; alias of origin_canton"),
    Param("destination_zone", "Destination zone name or ID; alias of destination_canton"),
    Param("direction", "Flow direction", enum=["origin_to_dest", "dest_to_origin", "both"]),
    Param("source", "Data source (only synthetic has routes)", enum=["synthetic", "microcensus"]),
    Param("minute_start", "Time window start (minutes from midnight, 0-1440)", param_type="integer"),
    Param("minute_end", "Time window end (minutes from midnight, 0-1440)", param_type="integer"),
]


class ZoneFlowsProvider(DataProvider):
    """Link-level car-traffic volumes for trips between two cantons.

    Example: /data/{id}/zone_flows.json?origin_canton=Zurich&destination_canton=Bern
    """

    ROUTE = "zone_flows.json"
    PARAMS = _ZONE_FLOWS_PARAMS

    def deliver(self, params: dict) -> dict:
        raw_origin = (params.get("origin_canton") or params.get("origin_zone") or "").strip()
        raw_dest = (params.get("destination_canton") or params.get("destination_zone") or "").strip()
        if not raw_origin:
            return {"error": "origin_canton parameter is required"}
        if not raw_dest:
            return {"error": "destination_canton parameter is required"}

        origin_id = _resolve_canton(raw_origin)
        dest_id = _resolve_canton(raw_dest)
        if origin_id is None:
            return {"error": f"Unknown canton: {raw_origin}"}
        if dest_id is None:
            return {"error": f"Unknown canton: {raw_dest}"}

        ckey, hit = _cget(self.ROUTE, params)
        if hit is not None:
            return hit

        source = (params.get("source") or "synthetic").strip().lower()
        if source not in ("synthetic", "microcensus"):
            source = "synthetic"

        reg = get_registry()
        ocol = zone_col(source, "trips", "origin")
        dcol = zone_col(source, "trips", "dest")

        direction = (params.get("direction") or "both").strip().lower()
        if direction not in ("origin_to_dest", "dest_to_origin", "both"):
            direction = "both"

        if direction == "origin_to_dest":
            pair_clause = f"t.{ocol} = ? AND t.{dcol} = ?"
            pair_bind = [origin_id, dest_id]
        elif direction == "dest_to_origin":
            pair_clause = f"t.{ocol} = ? AND t.{dcol} = ?"
            pair_bind = [dest_id, origin_id]
        else:  # both
            pair_clause = (
                f"(t.{ocol} = ? AND t.{dcol} = ?) OR "
                f"(t.{ocol} = ? AND t.{dcol} = ?)"
            )
            pair_bind = [origin_id, dest_id, dest_id, origin_id]

        # Optional time window on trips.departure_time (seconds from midnight).
        time_clause = ""
        time_bind: list = []
        minute_start = params.get("minute_start")
        if minute_start is not None and minute_start != "":
            try:
                time_bind.append(float(int(minute_start) * 60))
                time_clause += " AND t.departure_time >= ?"
            except ValueError:
                pass
        minute_end = params.get("minute_end")
        if minute_end is not None and minute_end != "":
            try:
                me = int(minute_end)
                if me < 1440:  # full-day slider → no upper cap (include >24:00 trips)
                    time_bind.append(float(me * 60))
                    time_clause += " AND t.departure_time < ?"
            except ValueError:
                pass

        try:
            cur = get_source_cursor(source)
        except Exception as exc:
            return {"error": f"zone_flows data unavailable: {exc}"}

        matching_cte = f"""
            matching_trips AS (
                SELECT t.person_id, t.trip_index
                FROM trips t
                WHERE t.main_mode = 'car'
                  AND ({pair_clause})
                  {time_clause}
            )
        """

        nlcol = zone_col(source, "network_links", "zone")
        crs = reg.crs
        link_query = f"""
            WITH {matching_cte},
            route_links AS (
                SELECT UNNEST(sr.route_links) AS link_id
                FROM spider_routes sr
                JOIN matching_trips mt USING (person_id, trip_index)
            ),
            link_volumes AS (
                SELECT link_id, COUNT(*)::INTEGER AS volume
                FROM route_links GROUP BY link_id
            )
            SELECT nl.{nlcol} AS canton_id, lv.link_id, lv.volume,
                   ST_AsGeoJSON(
                       ST_Transform(nl.geom, '{crs}', 'EPSG:4326', always_xy := true)
                   ) AS gj
            FROM link_volumes lv
            JOIN network_links nl USING (link_id)
            WHERE nl.{nlcol} IS NOT NULL
            ORDER BY lv.volume DESC
        """
        count_query = f"WITH {matching_cte} SELECT COUNT(*) FROM matching_trips"

        bind = pair_bind + time_bind
        try:
            rows = cur.execute(link_query, bind).fetchall()
            total_trips = cur.execute(count_query, bind).fetchone()[0]
        except Exception as exc:
            return {"error": str(exc)}

        links_by_canton: dict[str, dict] = {}
        # One GeoJSON feature per visual segment: forward + reverse links that
        # share a geometry merge into one line carrying the max of the two
        # directions' volumes (mirrors the old client-side applyFlowsToSource).
        # Sending only the flow links' geometry — straight off the network_links
        # join already in this query — replaces the frontend downloading every
        # route canton's *full* network just to draw this thin subset.
        groups: "OrderedDict[str, dict]" = OrderedDict()
        for canton_id, link_id, volume, gj in rows:
            if canton_id is None:
                continue
            name = reg.zone_name(canton_id)
            links_by_canton.setdefault(name, {})[link_id] = volume
            if not gj:
                continue
            geom = _round_geom(json.loads(gj))
            key = _geom_key(geom) or f"link:{link_id}"
            grp = groups.get(key)
            if grp is None:
                groups[key] = {
                    "geometry": geom,
                    "volume": volume,
                    "canton": name,
                    "link_ids": [str(link_id)],
                }
            else:
                grp["link_ids"].append(str(link_id))
                if volume > grp["volume"]:
                    grp["volume"] = volume

        features = [
            {
                "type": "Feature",
                "properties": {
                    "volume": grp["volume"],
                    "canton": grp["canton"],
                    "link_ids": "|".join(grp["link_ids"]),
                },
                "geometry": grp["geometry"],
            }
            for grp in groups.values()
        ]

        result = {
            "origin_canton": reg.zone_name(origin_id),
            "destination_canton": reg.zone_name(dest_id),
            "direction": direction,
            "total_trips": total_trips,
            "links_by_canton": links_by_canton,
            "flow_geojson": {"type": "FeatureCollection", "features": features},
        }
        _cput(ckey, result)
        return result
