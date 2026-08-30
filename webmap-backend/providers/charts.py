"""Composable charts for the AI agent.

The LLM builds a validated ChartSpec (Pydantic — same security model as the
query DSL): multiple series, chart types, axis options, and free math over
previous results via a SAFE expression evaluator (ast-based whitelist, no
eval). Series data comes inline, from a stored result (r1, r2, ...) or from
a formula over named inputs — "take the chart from r1 and r2, average them,
square it" is  expr="((a+b)/2)**2", inputs={"a": "r1:pt", "b": "r2:pt"}.
"""

from __future__ import annotations

import ast
import math
from typing import Literal, Optional

from pydantic import BaseModel, Field

MAX_POINTS = 500
MAX_SERIES = 8


class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


class SeriesSpec(_Strict):
    """One trace. Exactly one data source: inline y, source ref, or expr."""
    name: str = Field(max_length=60)
    type: Literal["bar", "line", "scatter", "area"] = "bar"
    x: Optional[list] = None                # inline x (else taken from source)
    y: Optional[list[float]] = None         # inline data
    source: Optional[str] = Field(
        default=None,
        description="result id (r1, r2, ...) to pull the series from")
    source_series: Optional[str] = Field(
        default=None, description="series/column name inside the source")
    expr: Optional[str] = Field(
        default=None,
        description="element-wise formula over 'inputs', e.g. '((a+b)/2)**2'")
    inputs: Optional[dict[str, str]] = Field(
        default=None,
        description="expr variables -> 'resultId' or 'resultId:seriesName'")


class ChartSpec(_Strict):
    title: str = Field(default="", max_length=120)
    x_title: str = Field(default="", max_length=60)
    y_title: str = Field(default="", max_length=60)
    y_log: bool = False
    stacked: bool = False
    series: list[SeriesSpec] = Field(min_length=1, max_length=MAX_SERIES)


# ─── Safe element-wise expression evaluator ──────────────────────────────

_ALLOWED_FUNCS = {
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
    "exp": math.exp, "abs": abs,
}
_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod)
_ALLOWED_UNARY = (ast.USub, ast.UAdd)


def _eval_node(node, env: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, env)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise ValueError(f"unknown variable '{node.id}' in expr")
        return env[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, _ALLOWED_BINOPS):
        left, right = _eval_node(node.left, env), _eval_node(node.right, env)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right if right != 0 else 0.0
        if isinstance(node.op, ast.Pow):
            return left ** right
        return left % right if right != 0 else 0.0
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, _ALLOWED_UNARY):
        val = _eval_node(node.operand, env)
        return -val if isinstance(node.op, ast.USub) else val
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id in _ALLOWED_FUNCS and len(node.args) == 1
            and not node.keywords):
        return _ALLOWED_FUNCS[node.func.id](_eval_node(node.args[0], env))
    raise ValueError(f"expression element not allowed: {ast.dump(node)[:60]}")


def eval_series_expr(expr: str, inputs: dict[str, list[float]]) -> list[float]:
    """Evaluate *expr* element-wise over equally long input lists."""
    if len(expr) > 200:
        raise ValueError("expr too long")
    tree = ast.parse(expr, mode="eval")
    lengths = {len(v) for v in inputs.values()}
    if not inputs:
        raise ValueError("expr needs at least one input series")
    if len(lengths) != 1:
        raise ValueError(f"input series have different lengths: {sorted(lengths)} "
                         "- use series over the same x axis")
    n = lengths.pop()
    out = []
    for i in range(n):
        env = {k: float(v[i]) for k, v in inputs.items()}
        try:
            out.append(float(_eval_node(tree, env)))
        except (ValueError, OverflowError) as exc:
            raise ValueError(f"expr failed at index {i}: {exc}") from exc
    return out


# ─── Series resolution against stored results ────────────────────────────

def _series_from_result(entry: dict, series_name: str | None) -> tuple[list, list[float]]:
    """(x, y) from a stored result. Results store {'x': [...], 'series':
    {name: [...]}} (charts) or {'columns': [...], 'rows': [...]} (tables)."""
    data = entry.get("data") or {}
    if "series" in data:
        series = data["series"]
        if series_name and series_name in series:
            return data.get("x") or [], series[series_name]
        if len(series) == 1 or not series_name:
            name = next(iter(series))
            return data.get("x") or [], series[name]
        raise ValueError(f"result {entry['id']} has series "
                         f"{list(series)} - pick one via source_series")
    if "columns" in data:
        cols, rows = data["columns"], data["rows"]
        num_cols = [i for i in range(len(cols))
                    if rows and isinstance(rows[0][i], (int, float))]
        if series_name and series_name in cols:
            ci = cols.index(series_name)
        elif num_cols:
            ci = num_cols[-1]
        else:
            raise ValueError(f"result {entry['id']} has no numeric column")
        xi = 0 if ci != 0 else (1 if len(cols) > 1 else 0)
        return ([r[xi] for r in rows], [float(r[ci] or 0) for r in rows])
    raise ValueError(f"result {entry['id']} ({entry.get('kind')}) has no "
                     "chartable data")


def resolve_chart(spec: ChartSpec, get_result) -> dict:
    """ChartSpec -> concrete display payload. *get_result(rid)* fetches a
    stored result entry (or None)."""
    traces = []
    for s in spec.series:
        modes = sum(1 for v in (s.y, s.source, s.expr) if v)
        if modes != 1:
            raise ValueError(f"series '{s.name}': set exactly ONE of "
                             "y (inline), source, or expr")
        if s.y is not None:
            x, y = (s.x if s.x is not None else list(range(len(s.y)))), s.y
        elif s.source:
            entry = get_result(s.source)
            if entry is None:
                raise ValueError(f"unknown result '{s.source}' - "
                                 "call list_results to see what exists")
            x, y = _series_from_result(entry, s.source_series)
            if s.x is not None:
                x = s.x
        else:  # expr
            resolved: dict[str, list[float]] = {}
            x = s.x
            for var, ref in (s.inputs or {}).items():
                rid, _, sname = ref.partition(":")
                entry = get_result(rid.strip())
                if entry is None:
                    raise ValueError(f"unknown result '{rid}' in inputs")
                rx, ry = _series_from_result(entry, sname.strip() or None)
                resolved[var] = ry
                if x is None:
                    x = rx
            y = eval_series_expr(s.expr, resolved)
            if x is None:
                x = list(range(len(y)))
        if len(y) > MAX_POINTS:
            raise ValueError(f"series '{s.name}' has {len(y)} points "
                             f"(max {MAX_POINTS}) - aggregate first")
        if len(x) != len(y):
            raise ValueError(f"series '{s.name}': x has {len(x)} values, "
                             f"y has {len(y)}")
        traces.append({"name": s.name, "type": s.type,
                       "x": list(x), "y": [round(float(v), 6) for v in y]})

    return {
        "type": "chart",
        "title": spec.title,
        "traces": traces,
        "layout": {"x_title": spec.x_title, "y_title": spec.y_title,
                   "y_log": spec.y_log, "stacked": spec.stacked},
    }
