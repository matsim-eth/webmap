"""Shared helper functions for data providers.

Two kinds of filters:

1. **Spatial filters** (polygon-based) — translate a request's polygon spec
   (zone name, polygon_id, GeoJSON, …) into either:
     • a ``polygon_id`` for hot-polygon lookup, or
     • a SQL WHERE-clause that uses an R-tree spatial index, or
     • a request to use the precomputed grid tables.

2. **Attribute filters** (gender, age, mode, …) — small WHERE-clause
   fragments. Same spirit as the legacy ``*_filter_sql`` helpers.

The aggregation utilities (``share_by_canton_source``, …) are kept under
the same names so existing providers don't all need to change at once,
but their inputs are now hot-polygon rows or pre-aggregated grid sums.

Zone name/id/label resolution is delegated to the per-dataset
:mod:`.zone_registry` (``get_registry()``), so the same helpers work for any
study area's primary zone type — Swiss cantons fall out of the registry's
default synthesis, so legacy datasets keep behaving byte-identically.
"""

from __future__ import annotations

import json
from typing import Any


# ─── Static assets (JSON/GeoJSON BLOBs stored in the duckdb) ───────────────

def load_static_asset(source: str, key: str):
    """Load a JSON/GeoJSON asset stored as a BLOB in the ``static_assets`` table
    of the dataset's duckdb. Returns the parsed object, or None if absent.

    v2 datasets ship these assets inside the duckdb (no more json_preview files).
    """
    from .connection import get_source_cursor
    try:
        cur = get_source_cursor(source)
        row = cur.execute(
            "SELECT payload FROM static_assets WHERE key = ?", [key]
        ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    return json.loads(bytes(row[0]))


def load_static_asset_bytes(source: str, key: str) -> bytes | None:
    """Return the raw payload bytes of a ``static_assets`` entry (no JSON
    parsing — for serving a GeoJSON/JSON blob straight through)."""
    from .connection import get_source_cursor
    try:
        cur = get_source_cursor(source)
        row = cur.execute(
            "SELECT payload FROM static_assets WHERE key = ?", [key]
        ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    return bytes(row[0])


# ─── Source resolution ────────────────────────────────────────────────────

def parse_source_param(params: dict) -> list[str]:
    """Return the list of sources requested. 'synthetic'/'microcensus' or
    both. Order matches request preference; defaults to all available."""
    from .connection import available_sources
    avail = available_sources()
    src = (params.get("source") or "").strip().lower()
    if src == "synthetic":
        return ["synthetic"] if "synthetic" in avail else []
    if src == "microcensus":
        return ["microcensus"] if "microcensus" in avail else []
    return avail


# ─── Polygon resolution ───────────────────────────────────────────────────

def resolve_canton_to_polygon_id(value: str) -> str | None:
    """Map a zone name or numeric ID to a hot_polygons polygon_id.

    Delegates to the dataset's :class:`~.zone_registry.ZoneRegistry`, which
    validates the value against the dataset's own primary zones. Returns e.g.
    ``'canton:1'`` (or ``'{primary_type}:N'`` for a non-Swiss study area), or
    None if unresolvable.
    """
    from .zone_registry import get_registry
    return get_registry().resolve_to_polygon_id(value)


def polygon_ids_from_params(params: dict) -> list[str]:
    """Extract the list of hot-polygon IDs from request params.

    Recognised parameters (in priority order):
      polygon_id  : 'canton:1' or comma-separated list ('canton:1,canton:2')
      polygon_ids : same, alternative spelling
      canton      : legacy: name(s) or ID(s); each becomes '{primary_type}:N'
      zone        : documented alias of ``canton`` (any study area's primary zone)

    Returns an empty list if no polygons selected (= "All", no spatial filter).
    """
    raw = (
        params.get("polygon_id")
        or params.get("polygon_ids")
        or ""
    ).strip()
    out: list[str] = []
    if raw:
        for tok in raw.split(","):
            t = tok.strip()
            if t:
                out.append(t)
        return out

    canton_param = (params.get("canton") or params.get("zone") or "").strip()
    if canton_param:
        for tok in canton_param.split(","):
            pid = resolve_canton_to_polygon_id(tok)
            if pid:
                out.append(pid)
    return out


def parse_polygon_geojson(params: dict) -> dict | None:
    """Return a parsed GeoJSON polygon dict, or None.

    Recognises ``polygon`` query param holding a JSON-encoded
    GeoJSON Polygon/MultiPolygon/Feature/FeatureCollection.
    """
    raw = params.get("polygon") or params.get("polygon_geojson")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def is_summary_only(params: dict) -> bool:
    return params.get("summary_only", "").lower() in ("true", "1", "yes")


# ─── Attribute filters ────────────────────────────────────────────────────

def gender_filter_sql(params: dict, column: str = "sex") -> str:
    g = params.get("gender") or params.get("sex")
    if g in ("0", "1"):
        return f" AND {column} = {int(g)}"
    return ""


def age_filter_sql(params: dict, column: str = "age") -> str:
    parts = []
    if params.get("age_min"):
        try:
            parts.append(f" AND {column} >= {int(params['age_min'])}")
        except ValueError:
            pass
    if params.get("age_max"):
        try:
            parts.append(f" AND {column} < {int(params['age_max'])}")
        except ValueError:
            pass
    return "".join(parts)


def mode_filter_sql(params: dict, column: str = "main_mode") -> str:
    modes = params.get("mode")
    if not modes:
        return ""
    vals = ", ".join(f"'{m.strip()}'" for m in modes.split(","))
    return f" AND {column} IN ({vals})"


def purpose_filter_sql(params: dict, column: str = "following_purpose") -> str:
    purposes = params.get("purpose")
    if not purposes:
        return ""
    vals = ", ".join(f"'{p.strip()}'" for p in purposes.split(","))
    return f" AND {column} IN ({vals})"


def has_person_filters(params: dict) -> bool:
    """Check if any person-level attribute filter is active."""
    return bool(
        params.get("gender")
        or params.get("sex")
        or params.get("age_min")
        or params.get("age_max")
    )


def socio_trip_filter(params: dict, person_alias: str = "p", household_alias: str = "h",
                      trip_alias: str = "t") -> tuple[str, str]:
    """Return (join_sql, where_sql) applying socioeconomic person filters to a
    trips query aliased ``trip_alias``. Empty strings when no socio param is
    present, so the unfiltered path pays nothing.

    Recognised params: ``gender`` (0/1), ``age_min``/``age_max``,
    ``income_class`` (comma-separated ints → households.income_class), and
    ``subscription`` (comma-separated subset of ``SUBS`` → any selected
    ``persons.subscriptions_{s}`` column is TRUE). The households join is added
    only when ``income_class`` is present."""
    from .constants import SUBS

    p = person_alias
    h = household_alias

    gender = params.get("gender") or params.get("sex")
    has_gender = gender in ("0", "1")
    has_age = bool(params.get("age_min") or params.get("age_max"))

    # Validate each income token with int() and skip non-numeric ones, so only
    # sanitised ints are interpolated — never raw user input.
    income_vals: list[int] = []
    income_raw = (params.get("income_class") or "").strip()
    for tok in income_raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            income_vals.append(int(tok))
        except ValueError:
            pass

    sub_raw = (params.get("subscription") or "").strip()
    subs = [s.strip().lower() for s in sub_raw.split(",") if s.strip().lower() in SUBS] if sub_raw else []

    if not (has_gender or has_age or income_vals or subs):
        return "", ""

    join_sql = f"JOIN persons {p} ON {trip_alias}.person_id = {p}.person_id"
    if income_vals:
        join_sql += f" JOIN households {h} ON {p}.household_id = {h}.household_id"

    where_sql = ""
    where_sql += gender_filter_sql(params, column=f"{p}.sex")
    where_sql += age_filter_sql(params, column=f"{p}.age")
    if income_vals:
        vals = ", ".join(str(v) for v in income_vals)
        where_sql += f" AND CAST({h}.income_class AS INTEGER) IN ({vals})"
    if subs:
        ors = " OR ".join(f"{p}.subscriptions_{s} = TRUE" for s in subs)
        where_sql += f" AND ({ors})"

    return join_sql, where_sql


# ─── Legacy compatibility shims ───────────────────────────────────────────
# These are only imported by code paths that have not yet been migrated;
# they raise loud errors if invoked. New code should use the polygon API
# (polygon_ids_from_params, build_share_response, …).

def canton_filter_sql(canton_param, column: str = "canton_id") -> str:
    """Deprecated. Translate via polygon_ids_from_params + ST_Within instead."""
    raise NotImplementedError(
        "canton_filter_sql is gone. Use polygon_ids_from_params + hot_polygon_demo / "
        "ST_Within filtering. See age.py for an example."
    )


def share_by_canton_source(*args, **kwargs):  # noqa: D401
    raise NotImplementedError(
        "share_by_canton_source is gone. Use _pre_agg.build_share_response "
        "or build a hot_polygon_* row aggregation directly."
    )


def share_rows_by_canton_source(*args, **kwargs):  # noqa: D401
    raise NotImplementedError(
        "share_rows_by_canton_source is gone. Use _pre_agg.build_share_response "
        "or hot_polygon_* lookup."
    )


def aggregate_with_all_rollup(*args, **kwargs):  # noqa: D401
    raise NotImplementedError(
        "aggregate_with_all_rollup is gone. Use _pre_agg.build_share_response."
    )


def build_canton_lookup(*args, **kwargs):
    raise NotImplementedError("build_canton_lookup is gone.")


# ─── Hot-polygon row helpers ──────────────────────────────────────────────

def get_hot_polygon_meta(con, polygon_ids: list[str]) -> dict[str, dict]:
    """Return ``{polygon_id: {name, type, parent_id}}`` for the given IDs."""
    if not polygon_ids:
        return {}
    placeholders = ",".join(["?"] * len(polygon_ids))
    rows = con.execute(
        f"SELECT polygon_id, polygon_name, polygon_type, parent_id "
        f"FROM hot_polygons WHERE polygon_id IN ({placeholders})",
        polygon_ids,
    ).fetchall()
    return {pid: {"name": n, "type": t, "parent_id": pp} for pid, n, t, pp in rows}


def all_canton_ids(con) -> list[str]:
    """Return all primary-zone polygon IDs in canonical order (numeric asc).

    Generalised over the dataset's primary zone type (``canton`` for legacy
    Swiss datasets, any type for other study areas). Falls back to the
    registry's synthesized list if the query fails or the table has no rows.
    """
    from .zone_registry import get_registry
    reg = get_registry()
    ptype = reg.primary_type
    try:
        rows = con.execute(
            "SELECT polygon_id FROM hot_polygons WHERE polygon_type = ?",
            [ptype],
        ).fetchall()
    except Exception:
        return reg.all_zone_polygon_ids()
    if not rows:
        return reg.all_zone_polygon_ids()

    plen = len(ptype) + 1  # length of the '{ptype}:' prefix

    def _suffix_int(pid: str) -> int:
        try:
            return int(pid[plen:])
        except (ValueError, TypeError):
            return 0

    return [r[0] for r in sorted(rows, key=lambda r: _suffix_int(r[0]))]


def canton_label(polygon_id: str) -> str:
    """Convert a primary-zone polygon_id to a human-readable label.

    Delegates to the dataset's zone registry (which still resolves legacy
    ``canton:*`` ids on any dataset)."""
    from .zone_registry import get_registry
    return get_registry().zone_label(polygon_id)


# ─── Generic share-by-bucket helper for hot polygon rollup ────────────────

def share_by_polygon_source(
    rows_by_source: dict[str, list[tuple[str, dict]]],
    *,
    bin_keys: list[str] | None = None,
    round_digits: int | None = None,
    include_all: bool = True,
) -> dict:
    """Build the legacy-shaped ``{polygon_label: {source: {bin: share}}}``.

    rows_by_source: ``{source_label: [(polygon_label, {bin_key: count, ...}), ...]}``

    The 'All' rollup is added by summing all polygons per source. If
    ``bin_keys`` is provided, missing bins are filled with 0.
    """
    out: dict[str, dict[str, dict[str, float]]] = {}
    all_totals: dict[str, dict[str, int]] = {}

    for source, items in rows_by_source.items():
        for label, counts in items:
            denom = sum(counts.values())
            keys = bin_keys if bin_keys is not None else list(counts.keys())
            entry = out.setdefault(label, {}).setdefault(source, {})
            for k in keys:
                v = counts.get(k, 0)
                share = (v / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                entry[k] = share
            if include_all:
                bag = all_totals.setdefault(source, {})
                for k, v in counts.items():
                    bag[k] = bag.get(k, 0) + v

    if include_all:
        for source, counts in all_totals.items():
            denom = sum(counts.values())
            keys = bin_keys if bin_keys is not None else list(counts.keys())
            entry = out.setdefault("All", {}).setdefault(source, {})
            for k in keys:
                v = counts.get(k, 0)
                share = (v / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                entry[k] = share

    return out
