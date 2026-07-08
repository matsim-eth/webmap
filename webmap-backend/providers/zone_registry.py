"""Per-dataset zone registry — the core of the study-area generalization.

Every dataset declares its own study area: a ``study_area`` JSON asset in the
``static_assets`` table of its ``synthetic.duckdb`` (see
GENERALIZATION_PLAN.md §1.1) plus one ``hot_polygons`` row per primary zone
(``{primary_zone_type}:{zone_id}``). The registry loads both once per dataset
and answers every name↔id↔label question that used to go through the
hardcoded Swiss ``CANTON_MAP``.

Legacy Swiss datasets have no ``study_area`` asset: the registry synthesizes
the Swiss default (primary type ``canton``, EPSG:2056, Switzerland extent)
and falls back to ``CANTON_MAP`` for names, so existing datasets behave
byte-identically.

Contract: :func:`get_registry` **never raises** — any failure degrades to the
Swiss-default registry. Cached per :func:`paths.dataset_key` (which folds in
the duckdb file signature, so a re-uploaded dataset invalidates itself).

Column probing: v3 builders write ``zone_id`` / ``origin_zone_id`` /
``dest_zone_id`` columns; v2 files spell them ``canton_id`` /
``origin_canton_id`` / ``dest_canton_id``. :func:`zone_col` probes the actual
table and returns the right spelling, so SQL works against both layouts.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from collections import OrderedDict

from .constants import CANTON_DISPLAY, CANTON_MAP

# Swiss defaults synthesized for datasets without a `study_area` asset.
# bbox/center/zoom match the webmap's historical hardcoded map init.
SWISS_DEFAULT_META: dict = {
    "schema_version": 2,
    "name": "Switzerland",
    "crs": "EPSG:2056",
    "primary_zone_type": "canton",
    "zone_types": [
        {"type": "canton", "label": "Canton", "label_plural": "Cantons"}
    ],
    "bbox": [5.9559, 45.8180, 10.4921, 47.8084],
    "center": [8.1642, 46.7592],
    "zoom": 7,
}

# Validated so the CRS string is safe to inline into SQL (ST_Transform).
_CRS_RE = re.compile(r"^EPSG:\d{1,6}$")


def norm_name(s: str) -> str:
    """Normalise a zone name for matching: strip accents, lowercase, and drop
    non-alphanumerics so 'Zürich', 'St. Gallen', 'Appenzell Ausserrhoden' all
    match their ASCII spellings."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return "".join(ch for ch in s.lower() if ch.isalnum())


class ZoneRegistry:
    """Name↔id↔label resolution for one dataset's primary zones."""

    def __init__(self, meta: dict, zones: dict[int, str]):
        self.meta: dict = meta
        self.primary_type: str = str(meta.get("primary_zone_type") or "canton")
        crs = str(meta.get("crs") or "EPSG:2056")
        self.crs: str = crs if _CRS_RE.match(crs) else "EPSG:2056"
        self.zones: dict[int, str] = dict(zones)
        self._name_to_id: dict[str, int] = {}
        for zid, name in self.zones.items():
            key = norm_name(name)
            if key:
                self._name_to_id.setdefault(key, zid)
        if self.primary_type == "canton":
            # Accept the canonical Swiss spellings (and their display aliases)
            # even when hot_polygons names differ slightly.
            for zid, name in CANTON_MAP.items():
                self._name_to_id.setdefault(norm_name(name), zid)
            for zid, name in CANTON_DISPLAY.items():
                self._name_to_id.setdefault(norm_name(name), zid)

    # ── identity ─────────────────────────────────────────────────────────

    @property
    def prefix(self) -> str:
        """The polygon_id prefix of primary zones, e.g. ``'canton:'``."""
        return self.primary_type + ":"

    def is_primary(self, polygon_id: str) -> bool:
        return bool(polygon_id) and polygon_id.startswith(self.prefix)

    # ── names / labels ───────────────────────────────────────────────────

    def zone_name(self, zid) -> str:
        """Zone id (int or numeric string) → canonical name.

        For canton-typed study areas the canonical ``CANTON_MAP`` spelling
        wins over whatever ``hot_polygons`` stores — the legacy providers
        always labelled through ``CANTON_MAP``, and response labels must stay
        byte-identical for existing Swiss datasets."""
        try:
            zid = int(zid)
        except (TypeError, ValueError):
            return str(zid)
        if self.primary_type == "canton" and zid in CANTON_MAP:
            return CANTON_MAP[zid]
        name = self.zones.get(zid)
        if name:
            return name
        return str(zid)

    def zone_display_name(self, zid) -> str:
        """Pretty display name (accented) where known; falls back to
        :meth:`zone_name`."""
        try:
            izid = int(zid)
        except (TypeError, ValueError):
            return str(zid)
        if self.primary_type == "canton" and izid in CANTON_DISPLAY:
            return CANTON_DISPLAY[izid]
        return self.zone_name(izid)

    def zone_label(self, polygon_id: str) -> str:
        """polygon_id → human label. Primary-type ids resolve to zone names;
        legacy ``canton:*`` ids keep resolving on any dataset; anything else
        returns the id unchanged (matches the old ``canton_label``)."""
        pid = polygon_id or ""
        if pid.startswith(self.prefix):
            return self.zone_name(pid[len(self.prefix):])
        if pid.startswith("canton:"):
            try:
                return CANTON_MAP.get(int(pid.split(":", 1)[1]), pid)
            except (ValueError, IndexError):
                return pid
        return pid

    def zone_type_labels(self) -> tuple[str, str]:
        """(singular, plural) UI label of the primary zone type."""
        for zt in self.meta.get("zone_types") or []:
            if isinstance(zt, dict) and zt.get("type") == self.primary_type:
                lab = str(zt.get("label") or self.primary_type.capitalize())
                return lab, str(zt.get("label_plural") or lab + "s")
        if self.primary_type == "canton":
            return "Canton", "Cantons"
        lab = self.primary_type.replace("_", " ").capitalize()
        return lab, lab + "s"

    # ── resolution ───────────────────────────────────────────────────────

    def resolve_zone(self, value) -> int | None:
        """Zone name or numeric id → zone id int, or None if unknown to this
        dataset."""
        v = str(value or "").strip()
        if not v:
            return None
        try:
            zid = int(v)
        except ValueError:
            return self._name_to_id.get(norm_name(v))
        if zid in self.zones:
            return zid
        if self.primary_type == "canton" and zid in CANTON_MAP:
            return zid
        if not self.zones:
            # No zone rows to validate against (degraded dataset) — accept.
            return zid
        return None

    def resolve_to_polygon_id(self, value) -> str | None:
        """Zone name or id → ``'{primary_type}:{zid}'``, or None."""
        zid = self.resolve_zone(value)
        return f"{self.primary_type}:{zid}" if zid is not None else None

    def all_zone_polygon_ids(self) -> list[str]:
        """All primary-zone polygon_ids in numeric order."""
        return [f"{self.primary_type}:{z}" for z in sorted(self.zones)]

    def zones_sorted(self) -> list[tuple[int, str]]:
        """[(zone_id, name), ...] in numeric order."""
        return [(z, self.zones[z]) for z in sorted(self.zones)]


# ─── Loading / caching ─────────────────────────────────────────────────────

_registry_cache: "OrderedDict[str, ZoneRegistry]" = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_MAX = 32


def _load_study_area_meta(cur) -> dict | None:
    """Read the `study_area` static_assets blob, or None (legacy dataset)."""
    try:
        row = cur.execute(
            "SELECT payload FROM static_assets WHERE key = 'study_area'"
        ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    try:
        meta = json.loads(bytes(row[0]))
        return meta if isinstance(meta, dict) else None
    except Exception:
        return None


def _load_zones(cur, ptype: str) -> dict[int, str]:
    """{zone_id: name} from the primary-type rows of hot_polygons."""
    out: dict[int, str] = {}
    try:
        rows = cur.execute(
            "SELECT polygon_id, polygon_name FROM hot_polygons "
            "WHERE polygon_type = ?",
            [ptype],
        ).fetchall()
    except Exception:
        return out
    for pid, name in rows:
        try:
            zid = int(str(pid).split(":", 1)[1])
        except (ValueError, IndexError):
            continue
        out[zid] = name or str(zid)
    return out


def _build_registry() -> ZoneRegistry:
    meta: dict | None = None
    zones: dict[int, str] = {}
    try:
        from .connection import default_source, get_source_cursor

        src = default_source()
        if src:
            cur = get_source_cursor(src)
            meta = _load_study_area_meta(cur)
            ptype = str((meta or SWISS_DEFAULT_META).get("primary_zone_type") or "canton")
            zones = _load_zones(cur, ptype)
    except Exception:
        pass
    if meta is None:
        meta = dict(SWISS_DEFAULT_META)
    if not zones and str(meta.get("primary_zone_type") or "canton") == "canton":
        zones = dict(CANTON_MAP)
    return ZoneRegistry(meta, zones)


def get_registry() -> ZoneRegistry:
    """The ZoneRegistry for the dataset currently in scope. Never raises;
    degrades to the Swiss-default registry on any failure."""
    try:
        from .paths import dataset_key

        dk = dataset_key()
    except Exception:
        dk = ""
    with _cache_lock:
        reg = _registry_cache.get(dk)
        if reg is not None:
            _registry_cache.move_to_end(dk)
            return reg
    reg = _build_registry()  # DB work happens outside the lock
    with _cache_lock:
        _registry_cache[dk] = reg
        _registry_cache.move_to_end(dk)
        while len(_registry_cache) > _CACHE_MAX:
            _registry_cache.popitem(last=False)
    return reg


# ─── Zone-id column probing (v3 `zone_id` vs legacy `canton_id`) ───────────

_ROLE_CANDIDATES: dict[str, tuple[str, ...]] = {
    "zone": ("zone_id", "canton_id"),
    "origin": ("origin_zone_id", "origin_canton_id"),
    "dest": ("dest_zone_id", "dest_canton_id"),
}

_col_cache: dict[tuple, str] = {}
_col_lock = threading.Lock()


def zone_col(source: str, table: str, role: str = "zone") -> str:
    """Return the primary-zone id column name on *table* for *source*.

    Probes the table's actual columns (information_schema) and prefers the
    v3 spelling (``zone_id`` / ``origin_zone_id`` / ``dest_zone_id``), falling
    back to the legacy canton spelling so v2 datasets keep working. Cached per
    (dataset, source, table, role). On any error returns the legacy spelling.
    """
    cands = _ROLE_CANDIDATES.get(role) or (role,)
    try:
        from .paths import dataset_key

        key = (dataset_key(), source, table, role)
    except Exception:
        key = ("", source, table, role)
    with _col_lock:
        hit = _col_cache.get(key)
    if hit:
        return hit
    col = cands[-1]
    try:
        from .connection import get_source_cursor

        cur = get_source_cursor(source)
        rows = cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = ?",
            [table],
        ).fetchall()
        cols = {r[0] for r in rows}
        for cand in cands:
            if cand in cols:
                col = cand
                break
    except Exception:
        pass
    with _col_lock:
        if len(_col_cache) > 512:
            _col_cache.clear()
        _col_cache[key] = col
    return col
