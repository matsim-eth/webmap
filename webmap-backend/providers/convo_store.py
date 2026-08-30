"""Per-conversation result registry for the AI agent.

Every chart/table a tool produces is registered here under a short id
(r1, r2, ...) so follow-up commands can reference it: "edit chart r2",
"average of r1 and r3". In-memory with TTL — conversations are ephemeral
by design (decision: server cache per session, no persistence).

Thread-safe; the agent loop runs in worker threads.
"""

from __future__ import annotations

import threading
import time

TTL_S = 3600            # conversation lifetime after last touch
MAX_CONVOS = 500        # LRU-ish bound across all users
MAX_RESULTS = 40        # per conversation

_lock = threading.Lock()
_convos: dict[str, dict] = {}   # convo_id -> {"ts": float, "seq": int, "results": {rid: entry}}


def _prune_locked() -> None:
    now = time.monotonic()
    dead = [cid for cid, c in _convos.items() if now - c["ts"] > TTL_S]
    for cid in dead:
        del _convos[cid]
    while len(_convos) > MAX_CONVOS:
        oldest = min(_convos, key=lambda c: _convos[c]["ts"])
        del _convos[oldest]


def put(convo_id: str, kind: str, summary: str, data: dict) -> str:
    """Register a result; returns its id (r1, r2, ...)."""
    if not convo_id:
        return ""
    with _lock:
        _prune_locked()
        c = _convos.setdefault(convo_id, {"ts": 0, "seq": 0, "results": {}})
        c["ts"] = time.monotonic()
        c["seq"] += 1
        rid = f"r{c['seq']}"
        c["results"][rid] = {"id": rid, "kind": kind,
                             "summary": (summary or "")[:200], "data": data}
        while len(c["results"]) > MAX_RESULTS:
            del c["results"][next(iter(c["results"]))]
        return rid


def get(convo_id: str, rid: str) -> dict | None:
    with _lock:
        c = _convos.get(convo_id or "")
        if not c:
            return None
        c["ts"] = time.monotonic()
        return c["results"].get((rid or "").strip())


def list_results(convo_id: str) -> list[dict]:
    with _lock:
        c = _convos.get(convo_id or "")
        if not c:
            return []
        c["ts"] = time.monotonic()
        return [{"id": e["id"], "kind": e["kind"], "summary": e["summary"]}
                for e in c["results"].values()]
