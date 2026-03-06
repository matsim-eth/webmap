"""Shared helper functions for data providers."""

from .constants import CANTON_MAP, canton_name


_NAME_TO_ID = {v: k for k, v in CANTON_MAP.items()}


def canton_filter_sql(canton_param: str | None, column: str = "canton_id") -> str:
    """Return a SQL WHERE clause fragment for canton filtering.

    Supports: single canton name, comma-separated canton names, or None (all).
    """
    if not canton_param:
        return ""
    cantons = [c.strip() for c in canton_param.split(",")]
    ids = []
    for c in cantons:
        if c in _NAME_TO_ID:
            ids.append(str(_NAME_TO_ID[c]))
        else:
            try:
                ids.append(str(int(c)))
            except ValueError:
                continue
    if not ids:
        return ""
    return f" AND {column} IN ({','.join(ids)})"


def gender_filter_sql(params: dict, column: str = "sex") -> str:
    g = params.get("gender")
    if g in ("0", "1"):
        return f" AND {column} = {int(g)}"
    return ""


def age_filter_sql(params: dict, column: str = "age") -> str:
    clauses = []
    if params.get("age_min"):
        try:
            clauses.append(f" AND {column} >= {int(params['age_min'])}")
        except ValueError:
            pass
    if params.get("age_max"):
        try:
            clauses.append(f" AND {column} < {int(params['age_max'])}")
        except ValueError:
            pass
    return "".join(clauses)


def build_canton_lookup(seen_cantons: set) -> tuple[list[str], dict[str, int | str]]:
    canton_names = [canton_name(cid) for cid in sorted(seen_cantons)]
    canton_ids_by_name = {canton_name(cid): cid for cid in sorted(seen_cantons)}
    return canton_names, canton_ids_by_name


def parse_source_param(params: dict) -> list[str]:
    source = params.get("source", "").strip().lower()
    if source == "synthetic":
        return ["Synthetic"]
    elif source == "microcensus":
        return ["Microcensus"]
    return ["Synthetic", "Microcensus"]


def mode_filter_sql(params: dict, column: str = "mode") -> str:
    modes = params.get("mode")
    if not modes:
        return ""
    vals = ", ".join(f"'{m.strip()}'" for m in modes.split(","))
    return f" AND {column} IN ({vals})"


def purpose_filter_sql(params: dict, column: str = "purpose") -> str:
    purposes = params.get("purpose")
    if not purposes:
        return ""
    vals = ", ".join(f"'{p.strip()}'" for p in purposes.split(","))
    return f" AND {column} IN ({vals})"
