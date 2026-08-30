"""PT passenger link volumes for the Transit Volumes module.

Serves the schema the frontend (useTransitVolumesLayer) expects — the same
shape as the old precomputed CDN asset
``matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_<canton>.json``:

    [{"link_id": "...", "modes_list": ["bus", ...],
      "lines": [{"line_id": "...", "line_name": "S1", "mode": "rail",
                 "hourly_avg_volumes": {"07:15": 400, ...}}]}]

Data source: the ``pt_link_volumes`` table written by
scripts/build_transit_volumes (per link × line × 15-min bin, raw sample
counts). Volumes are scaled to the full population here, like boardings.
Line names/modes come from the ``boarding_data_by_line`` asset.

Datasets built before this table exists raise → the /matsim asset route
returns 404 → the frontend falls back to the GitHub CDN as before.
"""

from __future__ import annotations

from .connection import get_source_cursor
from .helpers import load_static_asset
from .paths import dataset_key
from .result_cache import make_cache

_cget, _cput = make_cache(maxsize=32)

_line_meta_cache: dict[str, dict] = {}


def _line_meta() -> dict[str, tuple[str, str | None]]:
    """line_id → (line_name, mode) from the boarding asset."""
    dk = dataset_key()
    if dk in _line_meta_cache:
        return _line_meta_cache[dk]
    meta: dict[str, tuple[str, str | None]] = {}
    try:
        for line in load_static_asset("synthetic", "boarding_data_by_line") or []:
            modes = line.get("modes") or []
            meta[str(line.get("line_id"))] = (
                line.get("line_name") or str(line.get("line_id")),
                modes[0] if modes else None,
            )
    except Exception:
        pass
    if len(_line_meta_cache) > 8:
        _line_meta_cache.clear()
    _line_meta_cache[dk] = meta
    return meta


def _sample_rate() -> float:
    try:
        meta = load_static_asset("synthetic", "metadata") or {}
        sr = float(meta.get("sample_rate") or 1.0)
        return sr if sr > 0 else 1.0
    except Exception:
        return 1.0


def _bin_key(tbin: int) -> str:
    return f"{tbin // 4:02d}:{(tbin % 4) * 15:02d}"


def pt_link_volumes_by_canton(canton_id: int) -> list[dict]:
    """Frontend-shaped PT link volumes for one canton. Raises if the
    dataset has no pt_link_volumes table (older builds → CDN fallback)."""
    ck, hit = _cget("pt_link_volumes", {"canton": canton_id})
    if hit is not None:
        return hit

    con = get_source_cursor("synthetic")
    rows = con.execute("""
        SELECT v.link_id, v.line_id, v.time_bin, v.volume
        FROM pt_link_volumes v
        JOIN network_links nl USING (link_id)
        WHERE nl.canton_id = ?
        ORDER BY v.link_id, v.line_id, v.time_bin""", [canton_id]).fetchall()

    scale = 1.0 / _sample_rate()
    meta = _line_meta()

    links: dict[str, dict] = {}
    for link_id, line_id, tbin, volume in rows:
        entry = links.get(link_id)
        if entry is None:
            entry = links[link_id] = {"link_id": link_id, "_lines": {}}
        line = entry["_lines"].get(line_id)
        if line is None:
            name, mode = meta.get(str(line_id), (str(line_id), None))
            line = entry["_lines"][line_id] = {
                "line_id": line_id, "line_name": name, "mode": mode,
                "hourly_avg_volumes": {},
            }
        line["hourly_avg_volumes"][_bin_key(int(tbin))] = int(round(volume * scale))

    out = []
    for entry in links.values():
        lines = list(entry.pop("_lines").values())
        modes = sorted({l["mode"] for l in lines if l["mode"]})
        out.append({"link_id": entry["link_id"], "modes_list": modes,
                    "lines": lines})

    _cput(ck, out)
    return out
