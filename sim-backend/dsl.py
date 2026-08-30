"""Scenario-diff DSL — what a custom simulation run may change.

The single source of truth for custom runs. An LLM (or later a UI) builds
one of these documents; THIS validation is the security boundary (same
philosophy as the webmap query DSL: model output is untrusted input).
The worker never re-validates — it receives broker-approved JSON only.

Design rules:
  * extra="forbid" everywhere — a mistyped field must fail loudly.
  * Every operation is a discriminated union member on "op".
  * Selectors accept explicit ids OR attribute/spatial filters, so both
    "remove link 103313" and "reduce speed on all residential roads
    inside this polygon by 20%" are single operations.
  * Only operations the worker actually implements are representable.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

MAX_OPERATIONS = 40
MAX_EXPLICIT_IDS = 5000
MAX_POLYGON_POINTS = 1000


class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


class NumRange(_Strict):
    gte: Optional[float] = None
    lte: Optional[float] = None


# ─── Selectors ───────────────────────────────────────────────────────────

class LinkFilter(_Strict):
    """Attribute/spatial filter over network links."""
    road_type_in: Optional[list[str]] = None
    modes_any: Optional[list[str]] = Field(
        default=None, description="links allowing ANY of these modes")
    freespeed_kmh: Optional[NumRange] = None
    capacity: Optional[NumRange] = None
    polygon: Optional[list[list[float]]] = Field(
        default=None, max_length=MAX_POLYGON_POINTS,
        description="[lon,lat] ring — only links whose midpoint lies inside")

    @model_validator(mode="after")
    def _something_set(self):
        if not any([self.road_type_in, self.modes_any, self.freespeed_kmh,
                    self.capacity, self.polygon]):
            raise ValueError("link filter needs at least one criterion")
        if self.polygon is not None and len(self.polygon) < 3:
            raise ValueError("polygon needs at least 3 points")
        return self


class LinkSelector(_Strict):
    """Either explicit link ids or a filter (exactly one)."""
    link_ids: Optional[list[str]] = Field(default=None,
                                          max_length=MAX_EXPLICIT_IDS)
    filter: Optional[LinkFilter] = None

    @model_validator(mode="after")
    def _exactly_one(self):
        if bool(self.link_ids) == bool(self.filter):
            raise ValueError("select links via link_ids OR filter (exactly one)")
        return self


class TransitLineFilter(_Strict):
    mode_in: Optional[list[str]] = None          # bus, tram, rail, ...
    name_contains: Optional[str] = Field(default=None, max_length=60)

    @model_validator(mode="after")
    def _something_set(self):
        if not self.mode_in and not self.name_contains:
            raise ValueError("transit filter needs mode_in or name_contains")
        return self


class TransitSelector(_Strict):
    line_ids: Optional[list[str]] = Field(default=None,
                                          max_length=MAX_EXPLICIT_IDS)
    filter: Optional[TransitLineFilter] = None

    @model_validator(mode="after")
    def _exactly_one(self):
        if bool(self.line_ids) == bool(self.filter):
            raise ValueError("select lines via line_ids OR filter (exactly one)")
        return self


# ─── Network operations ──────────────────────────────────────────────────

class LinkSet(_Strict):
    """Absolute attribute values."""
    freespeed_kmh: Optional[float] = Field(default=None, gt=0, le=300)
    capacity: Optional[float] = Field(default=None, gt=0, le=100_000)
    lanes: Optional[float] = Field(default=None, gt=0, le=12)
    modes: Optional[list[str]] = Field(default=None, min_length=1)


class LinkScale(_Strict):
    """Multiplicative changes (0.05×..20×)."""
    freespeed: Optional[float] = Field(default=None, ge=0.05, le=20)
    capacity: Optional[float] = Field(default=None, ge=0.05, le=20)
    lanes: Optional[float] = Field(default=None, ge=0.05, le=20)


class ModifyLinks(_Strict):
    """Change attributes of selected links (absolute and/or scaled)."""
    op: Literal["modify_links"]
    select: LinkSelector
    set: Optional[LinkSet] = None
    scale: Optional[LinkScale] = None

    @model_validator(mode="after")
    def _has_change(self):
        set_any = self.set and any(v is not None for v in self.set.model_dump().values())
        scale_any = self.scale and any(v is not None
                                       for v in self.scale.model_dump().values())
        if not set_any and not scale_any:
            raise ValueError("modify_links needs at least one set/scale value")
        return self


class CloseLinks(_Strict):
    """Make links practically unusable WITHOUT deleting them (safe default
    for 'remove this road': capacity→~0, freespeed→crawl; routes stay
    valid and traffic reroutes around)."""
    op: Literal["close_links"]
    select: LinkSelector


class RemoveLinks(_Strict):
    """Physically delete links. Existing plans routed over them are
    scrubbed (route cleared → MATSim re-routes those agents)."""
    op: Literal["remove_links"]
    select: LinkSelector


class AddNode(_Strict):
    op: Literal["add_node"]
    node_id: str = Field(min_length=1, max_length=100)
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class AddLink(_Strict):
    """Add a link between two (existing or newly added) nodes."""
    op: Literal["add_link"]
    link_id: str = Field(min_length=1, max_length=100)
    from_node: str
    to_node: str
    freespeed_kmh: float = Field(default=50, gt=0, le=300)
    capacity: float = Field(default=1000, gt=0, le=100_000)
    lanes: float = Field(default=1, gt=0, le=12)
    modes: list[str] = Field(default_factory=lambda: ["car"])
    length_m: Optional[float] = Field(
        default=None, gt=0,
        description="straight-line distance between nodes if omitted")
    bidirectional: bool = Field(
        default=False, description="also create the reverse link (id + '_r')")


# ─── Transit operations ──────────────────────────────────────────────────

class RemoveTransitLines(_Strict):
    op: Literal["remove_transit_lines"]
    select: TransitSelector


class ScaleTransitFrequency(_Strict):
    """factor 2 = double the service (departures at midpoints between
    existing ones), factor 0.5 = keep every 2nd departure."""
    op: Literal["scale_transit_frequency"]
    select: TransitSelector
    factor: float = Field(ge=0.1, le=10)


class ScaleTransitVehicleCapacity(_Strict):
    """Scale seat + standing capacity of the vehicles serving the selected
    lines (scaled copies of their vehicle types)."""
    op: Literal["scale_transit_vehicle_capacity"]
    select: TransitSelector
    factor: float = Field(ge=0.1, le=10)


Operation = Annotated[
    Union[ModifyLinks, CloseLinks, RemoveLinks, AddNode, AddLink,
          RemoveTransitLines, ScaleTransitFrequency,
          ScaleTransitVehicleCapacity],
    Field(discriminator="op"),
]


# ─── Run parameters ──────────────────────────────────────────────────────

class RunParams(_Strict):
    iterations: int = Field(default=40, ge=1, le=200)
    random_seed: Optional[int] = Field(default=None, ge=0)
    # Escape hatch for admins: raw --config:module.param=value overrides.
    # Key format is validated; VALUE content is free — hence admin-gated
    # in the broker.
    config_overrides: Optional[dict[str, str]] = None

    @model_validator(mode="after")
    def _override_keys(self):
        import re
        for k in (self.config_overrides or {}):
            if not re.fullmatch(r"[A-Za-z0-9_]+(\.[A-Za-z0-9_:\[\]]+)+", k):
                raise ValueError(f"invalid config override key: {k}")
        if self.config_overrides and len(self.config_overrides) > 20:
            raise ValueError("too many config overrides")
        return self


class ScenarioDiff(_Strict):
    """The full request: base dataset + operations + run parameters."""
    base_dataset_id: int = Field(ge=1)
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(default="", max_length=2000)
    operations: list[Operation] = Field(min_length=1,
                                        max_length=MAX_OPERATIONS)
    params: RunParams = RunParams()


def summarize(diff: ScenarioDiff) -> list[str]:
    """Human-readable one-liners per operation (for confirmation UIs)."""
    out = []
    for o in diff.operations:
        if o.op in ("modify_links", "close_links", "remove_links"):
            sel = o.select
            what = (f"{len(sel.link_ids)} link(s)" if sel.link_ids
                    else "links matching filter")
            verb = {"modify_links": "modify", "close_links": "close",
                    "remove_links": "remove"}[o.op]
            extra = ""
            if o.op == "modify_links":
                changes = []
                for src in (o.set, o.scale):
                    if src:
                        changes += [f"{k}{'×' if src is o.scale else '='}{v}"
                                    for k, v in src.model_dump().items()
                                    if v is not None]
                extra = f" ({', '.join(changes)})"
            out.append(f"{verb} {what}{extra}")
        elif o.op == "add_node":
            out.append(f"add node {o.node_id} @ ({o.lon:.5f}, {o.lat:.5f})")
        elif o.op == "add_link":
            out.append(f"add link {o.link_id}: {o.from_node}→{o.to_node} "
                       f"({o.freespeed_kmh:g} km/h, cap {o.capacity:g}"
                       f"{', bidirectional' if o.bidirectional else ''})")
        elif o.op == "remove_transit_lines":
            sel = o.select
            what = (f"{len(sel.line_ids)} line(s)" if sel.line_ids
                    else "lines matching filter")
            out.append(f"remove transit {what}")
        elif o.op == "scale_transit_frequency":
            out.append(f"scale transit frequency ×{o.factor:g}")
        elif o.op == "scale_transit_vehicle_capacity":
            out.append(f"scale transit vehicle capacity ×{o.factor:g}")
    return out
