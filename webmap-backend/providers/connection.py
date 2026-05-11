"""DuckDB read-only connection pool, keyed by (db_path).

Per-source DuckDB files are opened **read-only** and **mmap'd** once per
worker process. Multiple readers share the same connection lock-free; we
use ``connection.cursor()`` per request to get a thread-safe cursor.

The pool also serves a "scratch" connection (no DB file) for legacy
providers that still want to issue ``SELECT FROM read_parquet(...)``-style
queries against external files. After the full migration this should
disappear.
"""

import threading

import duckdb

from .paths import db_path_for_source, get_data_paths


# ─── Per-DB-file persistent read-only connection pool ───────────────────

_pool: dict[str, duckdb.DuckDBPyConnection] = {}
_pool_lock = threading.Lock()


def _open_readonly(db_path: str) -> duckdb.DuckDBPyConnection:
    """Open a DuckDB read-only with spatial extension loaded."""
    con = duckdb.connect(db_path, read_only=True)
    try:
        con.execute("LOAD spatial;")
    except Exception:
        # Extension may need install on first use
        con.execute("INSTALL spatial; LOAD spatial;")
    return con


def get_db_connection(db_path: str) -> duckdb.DuckDBPyConnection:
    """Return the pooled read-only connection for *db_path*. Caller should
    use ``.cursor()`` to obtain a thread-safe cursor."""
    with _pool_lock:
        con = _pool.get(db_path)
        if con is None:
            con = _open_readonly(db_path)
            _pool[db_path] = con
        return con


def get_source_cursor(source: str) -> duckdb.DuckDBPyConnection:
    """Return a thread-safe cursor on the DuckDB file for *source*."""
    return get_db_connection(db_path_for_source(source)).cursor()


# ─── Legacy scratch connection (no DB file) ─────────────────────────────

_local = threading.local()


def get_connection() -> duckdb.DuckDBPyConnection:
    """Return the current thread's reusable DuckDB scratch connection.

    Used only for one-off queries that don't target a particular dataset
    (e.g., reading a static GeoJSON via ST_Read). All dataset queries
    should use :func:`get_source_cursor` instead.
    """
    if not hasattr(_local, "connection"):
        con = duckdb.connect()
        try:
            con.execute("LOAD spatial;")
        except Exception:
            try:
                con.execute("INSTALL spatial; LOAD spatial;")
            except Exception:
                pass
        _local.connection = con
    return _local.connection


# ─── Convenience: choose a default source for the current dataset ───────


def default_source() -> str | None:
    """Return the first available source for the current dataset, or None."""
    paths = get_data_paths()
    if paths.has_synthetic:
        return "synthetic"
    if paths.has_microcensus:
        return "microcensus"
    return None


def available_sources() -> list[str]:
    """Return sources that exist on disk for the current dataset, in
    canonical order ('synthetic' first)."""
    paths = get_data_paths()
    out = []
    if paths.has_synthetic:
        out.append("synthetic")
    if paths.has_microcensus:
        out.append("microcensus")
    return out
