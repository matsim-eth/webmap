"""Tiny per-dataset result cache shared by the heavy, scan-based providers.

Each of these providers scans tens/hundreds of millions of rows; cold that is
seconds. Map interactions (clicking nodes, picking cantons, drawing polygons)
re-issue the same query constantly, and the dataset is read-only — so a given
``(route, dataset, params)`` always yields the same result. Cache it.

Usage in a provider module::

    from .result_cache import make_cache
    _cget, _cput = make_cache(maxsize=24)

    def deliver(self, params):
        ckey, hit = _cget(self.ROUTE, params)
        if hit is not None:
            return hit
        ...
        _cput(ckey, result)
        return result
"""

from __future__ import annotations

from collections import OrderedDict

from .paths import dataset_key


def make_cache(maxsize: int = 24):
    """Return ``(get, put)`` for a bounded LRU keyed by (route, dataset, params)."""
    store: "OrderedDict[tuple, dict]" = OrderedDict()

    def get(route: str, params: dict):
        key = (route, dataset_key(),
               tuple(sorted((k, str(v)) for k, v in params.items() if v not in (None, ""))))
        hit = store.get(key)
        if hit is not None:
            store.move_to_end(key)
        return key, hit

    def put(key: tuple, value) -> None:
        # Don't cache error responses — let the next request retry.
        if isinstance(value, dict) and set(value.keys()) == {"error"}:
            return
        store[key] = value
        store.move_to_end(key)
        while len(store) > maxsize:
            store.popitem(last=False)

    return get, put
