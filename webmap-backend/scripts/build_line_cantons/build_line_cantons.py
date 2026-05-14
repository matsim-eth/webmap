"""Rewrite `cantons` on each entry of boarding_data_by_line.json.

The upstream postprocess derives `cantons` from where the line had a
recorded boarding/alighting in the simulation. For low-ridership long-haul
lines (e.g. IC2 with 2 stops with boardings) this excludes the mid-route
cantons the line actually traverses, which downstream the dashboard treats
as "the line is not present here" — muni overlays, inter-cantonal stops,
and counts all get pruned.

This script replaces `cantons` with the true geographic set: the union of
cantons whose per-canton stops file lists a feature whose `lines` array
contains this line_id.

Input/output paths follow the same convention as build_stop_municipality:
the public dataset by default, override on the CLI.
"""

from __future__ import annotations

import json
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any


CANTONS = [
    "Aargau", "AppenzellAusserrhoden", "AppenzellInnerrhoden",
    "Basel-Landschaft", "Basel-Stadt", "Bern", "Fribourg", "Geneve",
    "Glarus", "Graubunden", "Jura", "Luzern", "Neuchatel", "Nidwalden",
    "Obwalden", "Schaffhausen", "Schwyz", "Solothurn", "StGallen",
    "Ticino", "Thurgau", "Uri", "Valais", "Vaud", "Zug", "Zurich",
]

CDN_BASE = "https://matsim-eth.github.io/webmap/data/matsim/transit/stops_by_canton"


def _fetch_canton_stops(canton: str, local_dir: Path | None) -> dict[str, Any] | None:
    if local_dir is not None:
        path = local_dir / f"{canton}_stops.geojson"
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    url = f"{CDN_BASE}/{canton}_stops.geojson"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [{canton}] fetch failed: {exc}")
        return None


def _parse_lines(raw) -> list[dict]:
    if isinstance(raw, list):
        return [l for l in raw if isinstance(l, dict)]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
        return _parse_lines(parsed)
    return []


def _build_line_canton_map(local_dir: Path | None) -> dict[str, set[str]]:
    """line_id → set of canton names whose stops file lists this line."""
    line_to_cantons: dict[str, set[str]] = defaultdict(set)
    for canton in CANTONS:
        geo = _fetch_canton_stops(canton, local_dir)
        if not geo:
            continue
        feats = geo.get("features") or []
        for feat in feats:
            for line in _parse_lines((feat.get("properties") or {}).get("lines")):
                lid = line.get("line_id")
                if lid is None:
                    continue
                line_to_cantons[str(lid)].add(canton)
        print(f"  [{canton}] {len(feats)} stop features scanned")
    return line_to_cantons


def build_line_cantons(
    boarding_path: Path,
    output_path: Path,
    local_stops_dir: Path | None = None,
) -> None:
    with open(boarding_path, "r", encoding="utf-8") as f:
        boarding = json.load(f)

    line_to_cantons = _build_line_canton_map(local_stops_dir)
    print(f"Built line-to-cantons map for {len(line_to_cantons)} lines.")

    if not isinstance(boarding, dict):
        raise RuntimeError(
            f"boarding_data_by_line.json must be a dict keyed by `${{line_id}}_${{line_name}}`; "
            f"got {type(boarding).__name__}"
        )

    rewritten = 0
    unchanged = 0
    missing = 0
    for key, entry in boarding.items():
        if not isinstance(entry, dict):
            continue
        lid = entry.get("line_id")
        if lid is None:
            continue
        discovered = line_to_cantons.get(str(lid))
        if not discovered:
            missing += 1
            continue
        new_cantons = sorted(discovered)
        old_cantons = entry.get("cantons")
        if old_cantons == new_cantons:
            unchanged += 1
        else:
            entry["cantons"] = new_cantons
            rewritten += 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(boarding, f, separators=(",", ":"), ensure_ascii=False)

    print(
        f"Wrote {output_path}: rewrote {rewritten}, unchanged {unchanged}, "
        f"no stops match {missing}."
    )
