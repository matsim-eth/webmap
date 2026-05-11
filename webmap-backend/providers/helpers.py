"""Shared helper functions for data providers.

Two kinds of filters:

1. **Spatial filters** (polygon-based) — translate a request's polygon spec
   (canton name, polygon_id, GeoJSON, …) into either:
     • a ``polygon_id`` for hot-polygon lookup, or
     • a SQL WHERE-clause that uses an R-tree spatial index, or
     • a request to use the precomputed grid tables.

2. **Attribute filters** (gender, age, mode, …) — small WHERE-clause
   fragments. Same spirit as the legacy ``*_filter_sql`` helpers.

The aggregation utilities (``share_by_canton_source``, …) are kept under
the same names so existing providers don't all need to change at once,
but their inputs are now hot-polygon rows or pre-aggregated grid sums.
"""

from __future__ import annotations

import json
from typing import Any

from .constants import CANTON_MAP, canton_name


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

_NAME_TO_CANTON_ID = {v.lower(): k for k, v in CANTON_MAP.items()}


def resolve_canton_to_polygon_id(value: str) -> str | None:
    """Map a canton name or numeric ID to a hot_polygons polygon_id.

    Returns 'canton:N' or None if unresolvable.
    """
    v = (value or "").strip()
    if not v:
        return None
    # numeric ID
    try:
        cid = int(v)
        if cid in CANTON_MAP:
            return f"canton:{cid}"
    except ValueError:
        pass
    cid = _NAME_TO_CANTON_ID.get(v.lower())
    return f"canton:{cid}" if cid is not None else None


def polygon_ids_from_params(params: dict) -> list[str]:
    """Extract the list of hot-polygon IDs from request params.

    Recognised parameters (in priority order):
      polygon_id  : 'canton:1' or comma-separated list ('canton:1,canton:2')
      polygon_ids : same, alternative spelling
      canton      : legacy: name(s) or ID(s); each becomes 'canton:N'

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

    canton_param = (params.get("canton") or "").strip()
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
    """Return all 'canton:*' polygon IDs in canonical order (by canton_id ASC)."""
    rows = con.execute(
        "SELECT polygon_id FROM hot_polygons WHERE polygon_type = 'canton' "
        "ORDER BY CAST(SUBSTR(polygon_id, 8) AS INTEGER)"
    ).fetchall()
    return [r[0] for r in rows]


def canton_label(polygon_id: str) -> str:
    """Convert a 'canton:N' polygon_id to a human-readable label."""
    if not polygon_id.startswith("canton:"):
        return polygon_id
    try:
        return canton_name(int(polygon_id.split(":", 1)[1]))
    except (ValueError, IndexError):
        return polygon_id


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
