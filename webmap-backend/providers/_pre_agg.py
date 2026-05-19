"""Shared utilities for fast-path providers backed by hot_polygon_* tables.

These helpers do the boring work that every demographic / trip / out-of-home
provider needs:

  * resolve polygon_ids (or default to all cantons)
  * SELECT the relevant rows from hot_polygon_demo / hot_polygon_trips /
    hot_polygon_out_of_home
  * compute the per-source/per-polygon-label share dict
  * append the implicit "All" rollup

Providers stay thin: they just declare which columns they want and which
labels to group those columns under.
"""

from __future__ import annotations

from typing import Iterable

from .connection import get_source_cursor
from .helpers import (
    canton_label,
    all_canton_ids,
    get_hot_polygon_meta,
    parse_source_param,
    polygon_ids_from_params,
)


# ─── Tiny SQL utilities ───────────────────────────────────────────────────

def _select_hot_row(con, table: str, polygon_ids: list[str], columns: list[str]) -> dict[str, dict[str, int | float]]:
    """SELECT polygon_id, <columns…> FROM <table> WHERE polygon_id IN (...).

    Missing polygons are silently omitted (caller decides what to do with
    that). Returns ``{polygon_id: {col: value}}``.
    """
    if not polygon_ids:
        return {}
    placeholders = ",".join(["?"] * len(polygon_ids))
    cols_sql = ", ".join(columns)
    rows = con.execute(
        f"SELECT polygon_id, {cols_sql} FROM {table} WHERE polygon_id IN ({placeholders})",
        polygon_ids,
    ).fetchall()
    return {r[0]: dict(zip(columns, r[1:])) for r in rows}


def _sum_grid(con, grid_table: str, columns: list[str]) -> dict[str, int | float]:
    """Sum *columns* across all cells of a grid table → dict."""
    cols_sql = ", ".join(f"COALESCE(SUM({c}),0)" for c in columns)
    row = con.execute(f"SELECT {cols_sql} FROM {grid_table}").fetchone()
    return dict(zip(columns, row))


# ─── Resolution helpers ───────────────────────────────────────────────────

def resolve_polygon_ids(con, params: dict, default_type: str = "canton") -> list[str]:
    """Resolve the list of polygon_ids for this request.

    Order of precedence:
      1. custom polygon (``polygon`` param, GeoJSON) → returns ``["custom:<json>"]``
      2. ``polygon_id`` / ``polygon_ids`` / legacy ``canton`` parameter
      3. all polygons of *default_type* (e.g., all 26 cantons)

    The connection is needed to enumerate "all cantons" from the dataset's
    own hot_polygons table.
    """
    from .helpers import parse_polygon_geojson

    geo = parse_polygon_geojson(params)
    if geo is not None:
        # Normalise to a single Polygon/MultiPolygon: extract first feature
        # if it's a Feature/FeatureCollection.
        gtype = geo.get("type")
        if gtype == "Feature":
            geo = geo.get("geometry", geo)
        elif gtype == "FeatureCollection":
            feats = geo.get("features") or []
            if feats:
                geo = feats[0].get("geometry", {})
        import json
        return [f"custom:{json.dumps(geo, separators=(',', ':'))}"]

    pids = polygon_ids_from_params(params)
    if pids:
        return pids
    if default_type == "canton":
        return all_canton_ids(con)
    rows = con.execute(
        "SELECT polygon_id FROM hot_polygons WHERE polygon_type = ? "
        "ORDER BY polygon_id",
        [default_type],
    ).fetchall()
    return [r[0] for r in rows]


# ─── Response builders ───────────────────────────────────────────────────

def _polygon_area_km2(geojson_str: str) -> float:
    """Return the polygon area in km² (LV95 metres), best-effort.

    Uses any pooled connection — area calculation is cheap and doesn't
    touch dataset tables.
    """
    try:
        # First connection in pool gets us a working spatial context
        from .connection import _pool, get_db_connection
        any_db = next(iter(_pool.values()), None)
        if any_db is None:
            # Cold start: open the synthetic.duckdb of the active dataset
            any_db = get_db_connection(__import__("os").environ.get("WEBMAP_ROOT", "") + "/synthetic.duckdb")
        cur = any_db.cursor()
        cur.execute("LOAD spatial;")
        gj = geojson_str.replace("'", "''")
        return float(cur.execute(f"""
            SELECT ST_Area(ST_Transform(ST_GeomFromGeoJSON('{gj}'),
                                        'EPSG:4326', 'EPSG:2056', always_xy := true)) / 1e6
        """).fetchone()[0])
    except Exception:
        return 0.0


def pick_custom_grid(table: str, geojson_str: str, summary_grid: str) -> str:
    """Choose the appropriate grid table for a custom-polygon query.

    For demo grids we have 100m / 500m / 5000m available.
    For trip / out-of-home grids only 500m exists (the schema doesn't
    pre-aggregate trip flows at 100m).
    """
    if table == "hot_polygon_trips":
        return "trip_grid_origin_500m"
    if table == "hot_polygon_out_of_home":
        return "out_of_home_grid_500m"
    if table == "hot_polygon_demo":
        area = _polygon_area_km2(geojson_str)
        if area < 1.0:
            return "demo_grid_100m"
        if area < 100.0:
            return "demo_grid_500m"
        return "demo_grid_5000m"
    return summary_grid


def custom_polygon_filter_clause(geojson_str: str, person_alias: str = "p", point_col: str = "home_pt") -> tuple[str, str, str, list, callable]:
    """Build a clause that filters by an arbitrary GeoJSON polygon (in WGS84).

    The GeoJSON is passed inline as a SQL constant via ``ST_GeomFromGeoJSON``
    and reprojected to EPSG:2056 to match the dataset's native CRS. The
    polygon is materialised in a CTE so DuckDB can use the R-tree index on
    ``persons.home_pt`` (or whatever ``point_col`` is).

    Returns ``(join_clause, where_clause, group_by_expr, bind, label_fn)``
    matching the shape of :func:`polygon_filter_clause`.

    The single resulting "polygon group" gets the synthetic id ``custom``
    and the label ``"Custom"``.
    """
    # We can't bind GeoJSON as a parameter cleanly in DuckDB Spatial, so we
    # inline it. Caller is responsible for passing a trustworthy string
    # (sanitised by parse_polygon_geojson at the helpers layer).
    geojson_sql = geojson_str.replace("'", "''")
    cte = (
        " JOIN ( "
        f"   SELECT ST_Transform(ST_GeomFromGeoJSON('{geojson_sql}'), "
        "                        'EPSG:4326', 'EPSG:2056', always_xy := true) AS geom "
        " ) AS custom_poly ON 1=1 "
    )
    where = f" AND ST_Within({person_alias}.{point_col}, custom_poly.geom)"
    return (
        cte,
        where,
        "'custom'",  # group_by_expr — single bucket
        [],
        lambda v: "Custom",
    )


def polygon_filter_clause(polygon_ids: list[str], person_alias: str = "p") -> tuple[str, str, str, list, callable]:
    """Return ``(join_clause, where_clause, group_by_expr, bind, label_fn)``
    for filtering persons by a list of polygon IDs.

    Optimisation: when **all** polygon IDs are of type ``canton:*``, we can
    skip the ST_Within spatial join entirely and use the precomputed
    ``canton_id`` integer column on ``persons`` (and ``trips`` via JOIN
    persons). This is roughly 100-500x faster than ST_Within on big tables.

    Otherwise we fall back to a JOIN onto ``hot_polygons`` with R-tree
    spatial filtering.
    """
    if not polygon_ids:
        return "", "", "NULL", [], (lambda v: "")
    # Custom GeoJSON polygon — single bucket, named "Custom"
    if len(polygon_ids) == 1 and polygon_ids[0].startswith("custom:"):
        geojson_str = polygon_ids[0].split(":", 1)[1]
        return custom_polygon_filter_clause(geojson_str, person_alias=person_alias)
    if all(pid.startswith("canton:") for pid in polygon_ids):
        try:
            ids = [int(pid.split(":", 1)[1]) for pid in polygon_ids]
        except ValueError:
            ids = []
        if ids:
            ph = ",".join("?" * len(ids))
            return (
                "",
                f" AND {person_alias}.canton_id IN ({ph})",
                f"{person_alias}.canton_id",
                ids,
                lambda v: f"canton:{int(v)}",
            )
    ph = ",".join("?" * len(polygon_ids))
    join = (
        f" JOIN hot_polygons hp ON hp.polygon_id IN ({ph})"
        f"    AND ST_Within({person_alias}.home_pt, hp.polygon_geom) "
    )
    return join, "", "hp.polygon_id", list(polygon_ids), lambda v: str(v)


def make_label_resolver(con, polygon_ids: list[str], use_canton_fast_path: bool):
    """Return a function ``poly_key → human label`` for query results.

    For canton fast path, ``poly_key`` is an int canton_id; we use
    ``canton_name``. For a single custom GeoJSON polygon the SQL grouping
    column is the literal string ``'custom'`` and we always return
    ``"Custom"``. Otherwise ``poly_key`` is a polygon_id string and we
    look up its name in ``hot_polygons``.
    """
    if use_canton_fast_path:
        from .constants import canton_name
        def fn(v):
            try:
                return canton_name(int(v))
            except (TypeError, ValueError):
                return str(v)
        return fn
    if len(polygon_ids) == 1 and polygon_ids[0].startswith("custom:"):
        return lambda v: "Custom"
    meta = get_hot_polygon_meta(con, polygon_ids)
    def fn(v):
        return label_for(str(v), meta)
    return fn


def label_for(polygon_id: str, meta: dict | None = None) -> str:
    """Human-readable label for a polygon_id.

    Cantons → canonical Swiss name (matches the legacy
    ``CANTON_MAP`` mapping). Other types fall back to the polygon's
    ``polygon_name`` from the meta lookup, then the polygon_id itself.
    """
    if polygon_id.startswith("canton:"):
        return canton_label(polygon_id)
    if meta and polygon_id in meta:
        return meta[polygon_id].get("name") or polygon_id
    return polygon_id


def build_share_response(
    *,
    sources: list[str],
    polygon_ids: list[str],
    column_to_bin: dict[str, str],
    table: str = "hot_polygon_demo",
    summary_grid: str = "demo_grid_5000m",
    bin_order: list[str] | None = None,
    round_digits: int | None = None,
    include_all: bool = True,
) -> dict:
    """Build ``{label: {source: {bin: share}}}`` from a hot-polygon table.

    Args:
      sources:        e.g. ['synthetic','microcensus']
      polygon_ids:    list of hot-polygons to include
      column_to_bin:  {db_column: bin_label} — picks the relevant columns
      table:          hot_polygon_demo / hot_polygon_trips / hot_polygon_out_of_home
      summary_grid:   grid table used to build the "All" rollup
                      (must contain the same columns as *table*)
      bin_order:      ordered list of bin labels for stable output
      include_all:    add the "All" rollup row

    Sources that the dataset doesn't have are silently skipped. The
    response shape matches the legacy providers, so frontend code can
    consume it unchanged.
    """
    out: dict[str, dict[str, dict[str, float]]] = {}
    cols = list(column_to_bin.keys())

    # Custom GeoJSON polygon: not in hot_polygon_*, raw scan per source
    if len(polygon_ids) == 1 and polygon_ids[0].startswith("custom:"):
        geojson_str = polygon_ids[0].split(":", 1)[1].replace("'", "''")
        # Pick the grid resolution adaptively from polygon area:
        #   < 1 km²    → 100m  (urban district, small custom shapes)
        #   1-100 km²  → 500m  (gemeinde / bezirk-sized)
        #   > 100 km²  → 5000m (canton-sized or larger)
        # Demo grids exist in 100/500/5000m. Trip and OoH grids only at 500m
        # (no point pre-aggregating trip flows at 100m — too many cells).
        custom_grid = pick_custom_grid(table, geojson_str, summary_grid)
        cols_sql = ", ".join(f"COALESCE(SUM({c}),0)" for c in cols)
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            row = con.execute(f"""
                WITH custom_poly AS (
                    SELECT ST_Transform(ST_GeomFromGeoJSON('{geojson_str}'),
                                        'EPSG:4326', 'EPSG:2056', always_xy := true) AS geom
                )
                SELECT {cols_sql} FROM {custom_grid} g, custom_poly
                WHERE ST_Intersects(g.cell_geom, custom_poly.geom)
            """).fetchone()
            vals = dict(zip(cols, row))
            denom = sum(int(v or 0) for v in vals.values())
            if denom == 0:
                continue   # source has no data for this polygon
            entry = out.setdefault("Custom", {}).setdefault(_source_label(source), {})
            order = bin_order or list(column_to_bin.values())
            for col, bin_label in column_to_bin.items():
                num = float(vals.get(col, 0) or 0)
                share = (num / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                entry[bin_label] = share
            for b in order:
                entry.setdefault(b, 0.0)
    else:
        # Hot-polygons: regular path
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            rows = _select_hot_row(con, table, polygon_ids, cols)
            from .helpers import get_hot_polygon_meta
            meta = get_hot_polygon_meta(con, list(rows.keys()))
            for pid, vals in rows.items():
                denom = sum(int(v or 0) for v in vals.values())
                label = label_for(pid, meta)
                entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
                order = bin_order or list(column_to_bin.values())
                for col, bin_label in column_to_bin.items():
                    num = float(vals.get(col, 0) or 0)
                    share = (num / denom) if denom > 0 else 0.0
                    if round_digits is not None:
                        share = round(share, round_digits)
                    entry[bin_label] = share
                for b in order:
                    entry.setdefault(b, 0.0)

    # "All" rollup — sum across the whole dataset (not just selected polygons).
    # Skip a source entirely when its summary grid is empty (e.g. microcensus
    # in a build that didn't populate demo_grid_*).
    if include_all:
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            sums = _sum_grid(con, summary_grid, cols)
            denom = sum(int(v or 0) for v in sums.values())
            if denom == 0:
                continue
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            order = bin_order or list(column_to_bin.values())
            for col, bin_label in column_to_bin.items():
                num = float(sums.get(col, 0) or 0)
                share = (num / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                entry[bin_label] = share
            for b in order:
                entry.setdefault(b, 0.0)

    return out


def build_count_response(
    *,
    sources: list[str],
    polygon_ids: list[str],
    column_to_bin: dict[str, str],
    table: str = "hot_polygon_demo",
    summary_grid: str = "demo_grid_5000m",
    include_all: bool = True,
) -> dict:
    """Like build_share_response but returns absolute counts, not shares."""
    out: dict[str, dict[str, dict[str, int]]] = {}
    cols = list(column_to_bin.keys())

    for source in sources:
        try:
            con = get_source_cursor(source)
        except Exception:
            continue
        rows = _select_hot_row(con, table, polygon_ids, cols)
        from .helpers import get_hot_polygon_meta
        meta = get_hot_polygon_meta(con, list(rows.keys()))
        for pid, vals in rows.items():
            label = label_for(pid, meta)
            entry = out.setdefault(label, {}).setdefault(_source_label(source), {})
            for col, bin_label in column_to_bin.items():
                entry[bin_label] = int(vals.get(col, 0) or 0)

    if include_all:
        for source in sources:
            try:
                con = get_source_cursor(source)
            except Exception:
                continue
            sums = _sum_grid(con, summary_grid, cols)
            if sum(int(v or 0) for v in sums.values()) == 0:
                continue
            entry = out.setdefault("All", {}).setdefault(_source_label(source), {})
            for col, bin_label in column_to_bin.items():
                entry[bin_label] = int(sums.get(col, 0) or 0)

    return out


def _source_label(source: str) -> str:
    """Human-readable source label used in legacy responses."""
    return {"synthetic": "Synthetic", "microcensus": "Microcensus"}.get(source, source.capitalize())
