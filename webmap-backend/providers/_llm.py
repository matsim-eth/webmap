"""Minimal LLM adapter for the AI query feature.

Provider-agnostic surface with two implementations selected by
``LLM_PROVIDER``:

  gemini  (default) — Google Gemini REST, key from GEMINI_API_KEY
  openai            — any OpenAI-compatible endpoint (OpenAI, Ollama,
                      vLLM, …), LLM_BASE_URL + optional LLM_API_KEY

Three entry points:
  generate_json          — one structured-output completion (legacy single-shot)
  chat_with_tools        — one function-calling turn for the agent loop
  chat_with_tools_stream — same turn, but text arrives via on_delta while
                           the model responds (the agent's streaming path)

API keys stay server-side (.env → container env); the browser only ever
talks to the webmap backend. Blocking httpx — callers run this via
``asyncio.to_thread``.
"""

from __future__ import annotations

import json
import os

import httpx

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini").strip().lower()
LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.5-flash").strip()
LLM_BASE_URL = (os.getenv("LLM_BASE_URL") or "").strip().rstrip("/")
API_KEY = (os.getenv("GEMINI_API_KEY") or os.getenv("LLM_API_KEY") or "").strip()

_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_GEMINI_STREAM_URL = ("https://generativelanguage.googleapis.com/v1beta/"
                      "models/{model}:streamGenerateContent?alt=sse")


def is_configured() -> bool:
    if LLM_PROVIDER == "openai":
        return bool(LLM_BASE_URL)          # Ollama etc. need no key
    return bool(API_KEY)


class LLMError(RuntimeError):
    pass


class LLMCancelled(LLMError):
    """The caller cancelled the request mid-stream (user pressed stop)."""


def generate_json(system_prompt: str, messages: list[dict]) -> dict:
    """One structured-output completion. *messages* = [{role: 'user'|'model',
    text: str}, …] ending with the user turn. Returns the parsed JSON object
    the model produced. Raises LLMError on transport/parse problems."""
    if not API_KEY:
        raise LLMError("no LLM API key configured")
    if LLM_PROVIDER != "gemini":
        raise LLMError(f"unsupported LLM_PROVIDER: {LLM_PROVIDER}")

    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {"role": m["role"], "parts": [{"text": m["text"]}]} for m in messages
        ],
        "generationConfig": {
            "response_mime_type": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": 2048,
        },
    }
    import time

    resp = None
    for attempt in range(3):                # retry overload/rate-limit twice
        try:
            resp = httpx.post(
                _GEMINI_URL.format(model=LLM_MODEL),
                headers={"x-goog-api-key": API_KEY},
                json=body,
                timeout=30.0,
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"request failed: {exc}") from exc
        if resp.status_code in (429, 503) and attempt < 2:
            time.sleep(1.5 * (attempt + 1))
            continue
        break
    if resp.status_code != 200:
        # Surface a short human message, not the raw JSON blob
        try:
            msg = resp.json()["error"]["message"]
        except Exception:
            msg = resp.text[:200]
        if resp.status_code in (429, 503):
            raise LLMError("the AI model is overloaded right now - please try again in a moment")
        raise LLMError(f"HTTP {resp.status_code}: {msg}")
    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except Exception as exc:
        raise LLMError(f"could not parse LLM response: {exc}") from exc


# ─── Function-calling (agent loop) ───────────────────────────────────────
#
# Normalized message format the agent uses; adapters translate per provider:
#   {"role": "user"|"assistant", "text": str}
#   {"role": "assistant", "tool_calls": [{"id", "name", "args"}]}
#   {"role": "tool", "tool_call_id", "name", "result": str}
# chat_with_tools() returns {"text": str|None,
#                            "tool_calls": [{"id","name","args"}]}.


def _post_with_retry(url: str, headers: dict, body: dict) -> httpx.Response:
    import time
    resp = None
    for attempt in range(3):
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=60.0)
        except httpx.HTTPError as exc:
            raise LLMError(f"request failed: {exc}") from exc
        if resp.status_code in (429, 503) and attempt < 2:
            time.sleep(1.5 * (attempt + 1))
            continue
        break
    if resp.status_code != 200:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:
            msg = resp.text[:200]
        if resp.status_code in (429, 503):
            raise LLMError("the AI model is overloaded right now - please try again in a moment")
        raise LLMError(f"HTTP {resp.status_code}: {msg}")
    return resp


def _inline_refs(schema: dict) -> dict:
    """Resolve local $refs so providers that don't support them (Gemini)
    get a self-contained schema."""
    defs = schema.get("$defs", {})

    def walk(node, depth=0):
        if depth > 20 or not isinstance(node, (dict, list)):
            return node
        if isinstance(node, list):
            return [walk(n, depth + 1) for n in node]
        if "$ref" in node:
            name = node["$ref"].split("/")[-1]
            return walk(dict(defs.get(name, {})), depth + 1)
        return {k: walk(v, depth + 1) for k, v in node.items() if k != "$defs"}

    return walk(schema)


def _gemini_schema(schema: dict) -> dict:
    """Reduce a JSON schema to the subset Gemini function declarations
    accept: no $refs, no anyOf (collapsed to the non-null variant),
    whitelisted keys only."""
    schema = _inline_refs(schema)
    KEEP = {"type", "description", "enum", "properties", "required", "items",
            "nullable", "minimum", "maximum", "format"}

    def walk(node):
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        if "anyOf" in node:
            variants = [v for v in node["anyOf"]
                        if not (isinstance(v, dict) and v.get("type") == "null")]
            merged = dict(variants[0]) if variants else {"type": "string"}
            merged.setdefault("description", node.get("description", ""))
            merged["nullable"] = True
            node = merged
        out = {}
        for k, v in node.items():
            if k not in KEEP:
                continue
            if k in ("properties",):
                out[k] = {pk: walk(pv) for pk, pv in v.items()}
            elif k == "items":
                out[k] = walk(v)
            else:
                out[k] = v
        # Gemini requires a type; objects without properties confuse it
        if "type" not in out:
            out["type"] = "string"
        if out.get("type") == "object" and not out.get("properties"):
            out.pop("required", None)
        return out

    return walk(schema)


def _gemini_payload(system_prompt: str, messages: list[dict], tools: list[dict]) -> dict:
    """Request body shared by the blocking and the streaming Gemini turn."""
    contents = []
    for m in messages:
        if m["role"] == "tool":
            contents.append({"role": "user", "parts": [{"functionResponse": {
                "name": m["name"], "response": {"result": m["result"]}}}]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            contents.append({"role": "model", "parts": [
                {"functionCall": {"name": c["name"], "args": c["args"]}}
                for c in m["tool_calls"]]})
        else:
            role = "model" if m["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m.get("text", "")}]})

    return {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        **({"tools": [{"functionDeclarations": [{
            "name": t["name"],
            "description": t["description"],
            "parameters": _gemini_schema(t["input_schema"]),
        } for t in tools]}]} if tools else {}),
        # Thinking models (2.5-pro) spend "thought" tokens against this cap —
        # a low cap can leave ZERO parts for the actual answer.
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 16384},
    }


def _chat_gemini(system_prompt: str, messages: list[dict], tools: list[dict]) -> dict:
    body = _gemini_payload(system_prompt, messages, tools)
    parts = None
    for attempt in range(2):        # empty-response retry (thinking overrun)
        resp = _post_with_retry(_GEMINI_URL.format(model=LLM_MODEL),
                                {"x-goog-api-key": API_KEY}, body)
        try:
            cand = resp.json()["candidates"][0]
        except Exception as exc:
            raise LLMError(f"could not parse LLM response: {exc}") from exc
        parts = (cand.get("content") or {}).get("parts") or []
        if parts:
            break
        if attempt == 0:
            continue
        raise LLMError("empty LLM response "
                       f"(finishReason={cand.get('finishReason')})")
    text_chunks, calls = [], []
    for i, p in enumerate(parts):
        if "functionCall" in p:
            calls.append({"id": f"call_{len(calls)}",
                          "name": p["functionCall"].get("name", ""),
                          "args": p["functionCall"].get("args") or {}})
        elif "text" in p:
            text_chunks.append(p["text"])
    return {"text": "\n".join(text_chunks).strip() or None, "tool_calls": calls}


def _openai_headers() -> dict:
    headers = {}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    return headers


def _openai_payload(system_prompt: str, messages: list[dict], tools: list[dict]) -> dict:
    """Request body shared by the blocking and the streaming OpenAI turn."""
    msgs = [{"role": "system", "content": system_prompt}]
    for m in messages:
        if m["role"] == "tool":
            msgs.append({"role": "tool", "tool_call_id": m["tool_call_id"],
                         "content": m["result"]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            msgs.append({"role": "assistant", "content": m.get("text") or None,
                         "tool_calls": [{
                             "id": c["id"], "type": "function",
                             "function": {"name": c["name"],
                                          "arguments": json.dumps(c["args"])},
                         } for c in m["tool_calls"]]})
        else:
            msgs.append({"role": m["role"], "content": m.get("text", "")})

    return {
        "model": LLM_MODEL,
        "messages": msgs,
        **({"tools": [{"type": "function", "function": {
            "name": t["name"], "description": t["description"],
            "parameters": _inline_refs(t["input_schema"]),
        }} for t in tools]} if tools else {}),
        "temperature": 0.1,
    }


def _chat_openai(system_prompt: str, messages: list[dict], tools: list[dict]) -> dict:
    body = _openai_payload(system_prompt, messages, tools)
    resp = _post_with_retry(f"{LLM_BASE_URL}/chat/completions",
                            _openai_headers(), body)
    try:
        msg = resp.json()["choices"][0]["message"]
    except Exception as exc:
        raise LLMError(f"could not parse LLM response: {exc}") from exc
    calls = []
    for c in msg.get("tool_calls") or []:
        try:
            args = json.loads(c["function"].get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        calls.append({"id": c.get("id") or f"call_{len(calls)}",
                      "name": c["function"].get("name", ""), "args": args})
    text = msg.get("content")
    return {"text": (text or "").strip() or None, "tool_calls": calls}


def chat_with_tools(system_prompt: str, messages: list[dict], tools: list[dict]) -> dict:
    """One function-calling turn. Raises LLMError on transport problems."""
    if not is_configured():
        raise LLMError("no LLM configured")
    if LLM_PROVIDER == "openai":
        return _chat_openai(system_prompt, messages, tools)
    if LLM_PROVIDER == "gemini":
        return _chat_gemini(system_prompt, messages, tools)
    raise LLMError(f"unsupported LLM_PROVIDER: {LLM_PROVIDER}")


# ─── Streaming variants (SSE) ────────────────────────────────────────────
#
# Same normalized {text, tool_calls} result as chat_with_tools, but text is
# delivered incrementally through on_delta(chunk) while the response
# streams — the agent's streaming path forwards those deltas to the
# browser so the user watches the answer form. cancelled() is polled
# between chunks; pressing Stop tears the stream down mid-flight.


def _stream_sse(url: str, headers: dict, body: dict, handle, cancelled) -> None:
    """POST *body* and feed every SSE data payload to *handle*. Retries
    overload responses like _post_with_retry; raises LLMCancelled as soon
    as cancelled() turns true."""
    import time
    for attempt in range(3):
        try:
            with httpx.stream("POST", url, headers=headers, json=body,
                              timeout=httpx.Timeout(120.0, connect=10.0)) as resp:
                if resp.status_code in (429, 503) and attempt < 2:
                    resp.read()
                    time.sleep(1.5 * (attempt + 1))
                    continue
                if resp.status_code != 200:
                    resp.read()
                    try:
                        msg = resp.json()["error"]["message"]
                    except Exception:
                        msg = resp.text[:200]
                    if resp.status_code in (429, 503):
                        raise LLMError("the AI model is overloaded right now - "
                                       "please try again in a moment")
                    raise LLMError(f"HTTP {resp.status_code}: {msg}")
                for line in resp.iter_lines():
                    if cancelled is not None and cancelled():
                        raise LLMCancelled("stopped by the user")
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        if payload:
                            handle(payload)
            return
        except (LLMCancelled, LLMError):
            raise
        except httpx.HTTPError as exc:
            raise LLMError(f"request failed: {exc}") from exc


def _chat_gemini_stream(system_prompt: str, messages: list[dict],
                        tools: list[dict], on_delta, cancelled) -> dict:
    body = _gemini_payload(system_prompt, messages, tools)
    text_chunks: list[str] = []
    calls: list[dict] = []
    finish = {"reason": None}

    def handle(payload: str) -> None:
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            return
        cands = chunk.get("candidates") or []
        if not cands:
            return
        cand = cands[0]
        if cand.get("finishReason"):
            finish["reason"] = cand["finishReason"]
        for part in (cand.get("content") or {}).get("parts") or []:
            if "functionCall" in part:
                calls.append({"id": f"call_{len(calls)}",
                              "name": part["functionCall"].get("name", ""),
                              "args": part["functionCall"].get("args") or {}})
            elif part.get("text"):
                text_chunks.append(part["text"])
                if on_delta is not None:
                    on_delta(part["text"])

    _stream_sse(_GEMINI_STREAM_URL.format(model=LLM_MODEL),
                {"x-goog-api-key": API_KEY}, body, handle, cancelled)
    if not text_chunks and not calls:
        # Thinking overrun etc. — caller falls back to the blocking turn,
        # which has its own empty-response retry.
        raise LLMError("empty LLM response "
                       f"(finishReason={finish['reason']})")
    return {"text": "".join(text_chunks).strip() or None, "tool_calls": calls}


def _chat_openai_stream(system_prompt: str, messages: list[dict],
                        tools: list[dict], on_delta, cancelled) -> dict:
    body = {**_openai_payload(system_prompt, messages, tools), "stream": True}
    text_chunks: list[str] = []
    acc: dict[int, dict] = {}       # tool-call fragments by stream index

    def handle(payload: str) -> None:
        if payload == "[DONE]":
            return
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            return
        choices = chunk.get("choices") or []
        if not choices:
            return
        delta = choices[0].get("delta") or {}
        if delta.get("content"):
            text_chunks.append(delta["content"])
            if on_delta is not None:
                on_delta(delta["content"])
        for tc in delta.get("tool_calls") or []:
            slot = acc.setdefault(int(tc.get("index") or 0),
                                  {"id": None, "name": "", "args": ""})
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["name"] = fn["name"]
            if fn.get("arguments"):
                slot["args"] += fn["arguments"]

    _stream_sse(f"{LLM_BASE_URL}/chat/completions", _openai_headers(),
                body, handle, cancelled)
    calls = []
    for i in sorted(acc):
        slot = acc[i]
        try:
            args = json.loads(slot["args"] or "{}")
        except json.JSONDecodeError:
            args = {}
        calls.append({"id": slot["id"] or f"call_{len(calls)}",
                      "name": slot["name"], "args": args})
    return {"text": "".join(text_chunks).strip() or None, "tool_calls": calls}


def chat_with_tools_stream(system_prompt: str, messages: list[dict],
                           tools: list[dict], on_delta=None,
                           cancelled=None) -> dict:
    """Like chat_with_tools, but text arrives incrementally via
    *on_delta(chunk)* while the model responds. *cancelled()* is polled
    between chunks; when it turns true the stream is torn down and
    LLMCancelled raised. Returns the same {text, tool_calls} shape."""
    if not is_configured():
        raise LLMError("no LLM configured")
    if LLM_PROVIDER == "openai":
        return _chat_openai_stream(system_prompt, messages, tools,
                                   on_delta, cancelled)
    if LLM_PROVIDER == "gemini":
        return _chat_gemini_stream(system_prompt, messages, tools,
                                   on_delta, cancelled)
    raise LLMError(f"unsupported LLM_PROVIDER: {LLM_PROVIDER}")
