"""Shared constants used across multiple providers."""

CANTON_MAP: dict[int, str] = {
    1: "Zurich",
    2: "Bern",
    3: "Luzern",
    4: "Uri",
    5: "Schwyz",
    6: "Obwalden",
    7: "Nidwalden",
    8: "Glarus",
    9: "Zug",
    10: "Fribourg",
    11: "Solothurn",
    12: "Basel-Stadt",
    13: "Basel-Landschaft",
    14: "Schaffhausen",
    15: "AppenzellAusserrhoden",
    16: "AppenzellInnerrhoden",
    17: "StGallen",
    18: "Graubunden",
    19: "Aargau",
    20: "Thurgau",
    21: "Ticino",
    22: "Vaud",
    23: "Valais",
    24: "Neuchatel",
    25: "Geneve",
    26: "Jura",
}


# Pretty display names (accented) — mirrors the frontends' canton_alias.json.
# Used by the zone registry as `display_name` for canton-typed study areas.
CANTON_DISPLAY: dict[int, str] = {
    1: "Zürich",
    2: "Bern",
    3: "Luzern",
    4: "Uri",
    5: "Schwyz",
    6: "Obwalden",
    7: "Nidwalden",
    8: "Glarus",
    9: "Zug",
    10: "Fribourg",
    11: "Solothurn",
    12: "Basel-Stadt",
    13: "Basel-Landschaft",
    14: "Schaffhausen",
    15: "Appenzell Ausserrhoden",
    16: "Appenzell Innerrhoden",
    17: "St. Gallen",
    18: "Graubünden",
    19: "Aargau",
    20: "Thurgau",
    21: "Ticino",
    22: "Vaud",
    23: "Valais",
    24: "Neuchâtel",
    25: "Genève",
    26: "Jura",
}


def canton_name(canton_id: int | str) -> str:
    try:
        return CANTON_MAP.get(int(canton_id), str(canton_id))
    except Exception:
        return str(canton_id)


# Public transport subscription types
SUBS: list[str] = ["ga", "halbtax", "verbund", "strecke", "gleis7", "junior", "other"]
SUB_LABELS: dict[str, str] = {s: s.capitalize() for s in SUBS}

# Default age bins used by providers that group by age
DEFAULT_AGE_BINS: list[tuple[int, int, str]] = [
    (6,  15, "[6, 15)"),
    (15, 18, "[15, 18)"),
    (18, 24, "[18, 24)"),
    (24, 30, "[24, 30)"),
    (30, 45, "[30, 45)"),
    (45, 65, "[45, 65)"),
    (65, 80, "[65, 80)"),
]
