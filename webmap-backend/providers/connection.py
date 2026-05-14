"""Per-thread DuckDB connection pool.

Each thread in the asyncio thread pool gets its own in-memory DuckDB
connection, reused across requests.  This avoids creating a new
connection on every request and lets DuckDB cache Parquet metadata.
"""

import threading

import duckdb

_local = threading.local()


def get_connection() -> duckdb.DuckDBPyConnection:
    """Return the current thread's reusable DuckDB connection."""
    if not hasattr(_local, "connection"):
        _local.connection = duckdb.connect()
    return _local.connection
