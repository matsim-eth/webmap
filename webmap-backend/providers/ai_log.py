"""Failure log for the AI agent — one JSON line per problem.

The agent auto-retries and usually recovers, but every failed tool call
is a prompt/tool-design bug candidate. This file collects them
persistently (JSONL) so they can be reviewed and fixed in batches every
few days instead of scrolling container stdout:

    webmap-backend/ai_logs/agent_failures.jsonl   (AI_LOG_DIR overrides)

Record shape: {ts, kind, dataset, convo, question, tool, detail, error}
kind ∈ tool_error | llm_error | llm_stream_retry | step_limit.
Rotation keeps one 5 MB generation (.jsonl.1). Never raises.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

_LOCK = threading.Lock()
MAX_BYTES = 5 * 1024 * 1024


def _log_path() -> Path:
    base = os.getenv("AI_LOG_DIR")
    root = Path(base) if base else Path(__file__).resolve().parent.parent / "ai_logs"
    return root / "agent_failures.jsonl"


def _dataset_tag() -> str | None:
    try:
        from .paths import dataset_root_path
        return Path(dataset_root_path()).name or None
    except Exception:
        return None


def log_failure(kind: str, **fields) -> None:
    """Append one failure record; best effort, never raises."""
    try:
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "kind": kind, "dataset": _dataset_tag()}
        for k, v in fields.items():
            if v is None:
                continue
            rec[k] = v[:2000] if isinstance(v, str) else v
        line = json.dumps(rec, ensure_ascii=False, default=str)
        path = _log_path()
        with _LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > MAX_BYTES:
                path.rename(path.with_suffix(".jsonl.1"))
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except Exception:
        pass
