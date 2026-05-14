"""Shared helper functions for data providers."""

from .constants import CANTON_MAP, canton_name


def is_summary_only(params: dict) -> bool:
    """Check if the client requested summary-only (All canton aggregate)."""
    return params.get("summary_only", "").lower() in ("true", "1", "yes")


def has_person_filters(params: dict) -> bool:
    """Check if any person-level filters are active (gender, age)."""
    return bool(
        params.get("gender")
        or params.get("age_min")
        or params.get("age_max")
    )


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


def parse_source_param(params: dict, paths=None) -> list[str]:
    from .paths import get_data_paths
    if paths is None:
        paths = get_data_paths()

    source = params.get("source", "").strip().lower()
    if source == "synthetic":
        return ["Synthetic"] if paths.has_synthetic else []
    elif source == "microcensus":
        return ["Microcensus"] if paths.has_microcensus else []

    available = []
    if paths.has_synthetic:
        available.append("Synthetic")
    if paths.has_microcensus:
        available.append("Microcensus")
    return available


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


def aggregate_with_all_rollup(grouped_rows):
    """Tally per-(source, canton, bin) counts and the implicit "All" canton
    rollup from a stream of grouped SQL rows.

    Args:
        grouped_rows: iterable of (source_label, canton_id, bin_key, count)
            tuples — typically the result of a SQL ``GROUP BY canton_id, <bin>``
            with a ``COUNT(*)`` aggregate.

    Returns:
        ``(counts, totals, canton_names, canton_ids_by_name)`` where
        ``counts[(source, cid, bin_key)]`` and ``totals[(source, cid)]`` carry
        both real canton ids (int) and the special ``"All"`` rollup. Canton
        ordering is by canton id (matches ``build_canton_lookup``).
    """
    counts: dict = {}
    totals: dict = {}
    seen_cantons: set = set()
    for source, cid, bk, cnt in grouped_rows:
        cid_int = int(cid)
        bk_str = str(bk)
        seen_cantons.add(cid_int)
        counts[(source, cid_int, bk_str)] = counts.get((source, cid_int, bk_str), 0) + cnt
        totals[(source, cid_int)]         = totals.get((source, cid_int), 0)         + cnt
        counts[(source, "All", bk_str)]   = counts.get((source, "All", bk_str), 0)   + cnt
        totals[(source, "All")]           = totals.get((source, "All"), 0)           + cnt
    canton_names, canton_ids_by_name = build_canton_lookup(seen_cantons)
    return counts, totals, canton_names, canton_ids_by_name


def share_by_canton_source(
    grouped_rows,
    *,
    sources: list[str],
    bin_keys: list[str] | None = None,
    round_digits: int | None = None,
) -> dict:
    """Build ``{canton_name: {source: {bin_key: share}}}`` from grouped rows,
    including the ``"All"`` canton rollup. ``sources`` is iterated in the
    given order so requested-but-empty sources still appear with all-zero
    shares (matches the pre-refactor providers byte-for-byte).

    ``bin_keys`` controls bin ordering and which bins must be present in the
    output even when their count is zero — pass an explicit list when the
    desired ordering isn't lexicographic (custom age bins, numeric car-class
    keys, etc.). ``None`` sorts the union of bins seen in the input.
    """
    counts, totals, canton_names, canton_ids_by_name = aggregate_with_all_rollup(grouped_rows)
    if bin_keys is None:
        bin_keys = sorted({k[2] for k in counts.keys()})
    out: dict = {}
    for cname in canton_names + ["All"]:
        cid = canton_ids_by_name.get(cname, "All")
        for source in sources:
            denom = float(totals.get((source, cid), 0))
            for bk in bin_keys:
                num = float(counts.get((source, cid, bk), 0))
                share = (num / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                out.setdefault(cname, {}).setdefault(source, {})[bk] = share
    return out


def share_rows_by_canton_source(
    grouped_rows,
    *,
    sources: list[str],
    bin_field: str,
    bin_keys: list[str] | None = None,
    round_digits: int | None = None,
    max_share_field: str | None = None,
) -> dict:
    """Build ``{source: [{canton_name, <bin_field>, share}, ...]}`` from grouped
    rows. The ``"All"`` canton row is included in each source list. When
    ``max_share_field`` is given, an extra top-level entry holds the per-bin
    max share *excluding* the ``"All"`` rollup (matches mode/purpose share's
    ``max_share_per_*`` payload).
    """
    counts, totals, canton_names, canton_ids_by_name = aggregate_with_all_rollup(grouped_rows)
    if bin_keys is None:
        bin_keys = sorted({k[2] for k in counts.keys()})
    result: dict = {}
    max_share: dict = {}
    for source in sources:
        source_rows = []
        for cname in canton_names + ["All"]:
            cid = canton_ids_by_name.get(cname, "All")
            denom = float(totals.get((source, cid), 0))
            for bk in bin_keys:
                num = float(counts.get((source, cid, bk), 0))
                share = (num / denom) if denom > 0 else 0.0
                if round_digits is not None:
                    share = round(share, round_digits)
                source_rows.append({"canton_name": cname, bin_field: bk, "share": share})
                if cname != "All":
                    max_share[bk] = max(max_share.get(bk, 0.0), share)
        result[source] = source_rows
    if max_share_field is not None:
        result[max_share_field] = max_share
    return result
