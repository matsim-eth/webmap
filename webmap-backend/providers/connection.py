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
# Signature (mtime_ns, size) the pooled connection for each path was opened
# with, so we can detect a file being replaced on disk (admin re-upload) and
# reopen instead of serving the old inode forever.
_pool_sigs: dict[str, tuple] = {}
_pool_lock = threading.Lock()


import os


def _file_sig(db_path: str) -> tuple | None:
    """(mtime_ns, size) for *db_path*, or None if it can't be stat'd."""
    try:
        st = os.stat(db_path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None

# Spill directory for hash-aggregates/sorts that exceed memory. The dataset
# directories are mounted read-only, so DuckDB's default (`<db>.tmp` next to
# the file) fails on a read-only filesystem; point it at a writable temp dir.
_TEMP_DIR = os.getenv("DUCKDB_TEMP_DIR", "/tmp/duckdb_spill")


def _open_readonly(db_path: str) -> duckdb.DuckDBPyConnection:
    """Open a DuckDB read-only with spatial extension loaded."""
    con = duckdb.connect(db_path, read_only=True)
    try:
        con.execute("LOAD spatial;")
    except Exception:
        # Extension may need install on first use
        con.execute("INSTALL spatial; LOAD spatial;")
    try:
        os.makedirs(_TEMP_DIR, exist_ok=True)
        con.execute(f"SET temp_directory = '{_TEMP_DIR}';")
    except Exception:
        # Non-fatal: queries that don't spill still work.
        pass
    return con


def get_db_connection(db_path: str) -> duckdb.DuckDBPyConnection:
    """Return the pooled read-only connection for *db_path*. Caller should
    use ``.cursor()`` to obtain a thread-safe cursor.

    If the file on disk has been replaced since we opened it (admin re-upload,
    detected via mtime/size), open a fresh connection. The stale one is dropped
    from the pool, not force-closed: in-flight cursors keep reading the old
    (now-unlinked) inode safely and the connection is GC'd once they finish."""
    sig = _file_sig(db_path)
    with _pool_lock:
        con = _pool.get(db_path)
        # Reopen on a real, observed signature change; if the file briefly can't
        # be stat'd (sig is None) keep the existing connection rather than churn.
        stale = con is not None and sig is not None and _pool_sigs.get(db_path) != sig
        if con is None or stale:
            con = _open_readonly(db_path)
            _pool[db_path] = con
            _pool_sigs[db_path] = sig
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
