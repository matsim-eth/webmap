"""The one raw-XML fact :mod:`ingest` needs that ``parsers/`` does not provide.

``persons.home_pt`` is the person's first *home* activity in
``eqasim_activities.csv`` — but ~15 % of a synthetic population never leaves
home and has no row in that file at all (12,880 of 88,013 on the reference 1 %
run). Their home coordinate does exist in ``output_plans.xml``, and without it
they land with a NULL ``home_pt`` and drop out of every demographic aggregate.

The reference pipeline (``eqasim-switzerland@webmap_export``,
``raw_entities.load_persons_synthetic``) fills those from a STATPOP pickle
instead. That pickle is not part of the ingestion staging contract, and its
join is *wrong* in the shipped dataset — see the :mod:`ingest` module docstring
for the measurement — so the plans file is both the available source and the
correct one.

Everything else that once lived here (PT transfers, per-link passenger
occupancy) is now produced by ``parsers.events`` in its single pass, which is
where it belongs: this module would otherwise stream the whole events file a
second time to recompute numbers the parser already has.
"""

from __future__ import annotations

import gzip
import logging
from collections.abc import Callable
from pathlib import Path

from lxml import etree

logger = logging.getLogger(__name__)


def _open(path: str | Path):
    """Open ``path`` as a binary stream, transparently gunzipping ``.gz``."""
    path = str(path)
    return gzip.open(path, "rb") if path.endswith(".gz") else open(path, "rb")


def plan_homes(plans_path: str | Path, wanted: set[str] | None = None,
               progress: Callable[[str], None] | None = None) -> dict[str, tuple[float, float]]:
    """``person_id → (x, y)`` of each person's first activity in their plan.

    ``wanted`` restricts the result to the person ids that still need a home,
    which is what makes this cheap — a few tens of thousands of entries instead
    of one per agent. Pass None for everyone. Coordinates are LV95 exactly as
    the XML writes them.

    Only the first activity of the **selected** plan is read — the same choice
    ``parsers.plans`` makes, and it matters: a person can carry several scored
    plans and the unselected ones come first in the file. Falls back to the
    first plan when nothing is marked selected.
    """
    homes: dict[str, tuple[float, float]] = {}
    person: str | None = None
    skip = False
    selected = False
    best: tuple[float, float] | None = None      # selected plan's first activity
    fallback: tuple[float, float] | None = None  # first plan's first activity
    have_plan_act = False
    n = 0

    def flush():
        if person is not None:
            home = best if best is not None else fallback
            if home is not None:
                homes[person] = home

    with _open(plans_path) as fh:
        for ev, el in etree.iterparse(fh, events=("start", "end"),
                                      tag=("person", "plan", "activity")):
            tag = el.tag
            if tag == "person":
                if ev == "start":
                    flush()
                    person = el.get("id")
                    best = fallback = None
                    n += 1
                    skip = wanted is not None and person not in wanted
                else:
                    # A plans file is one flat list of <person> children;
                    # clearing the element is not enough, the parent keeps a
                    # reference to every sibling already seen.
                    el.clear()
                    parent = el.getparent()
                    if parent is not None:
                        del parent[0]
                    if progress is not None and n % 100_000 == 0:
                        progress(f"plan homes: {n:,} persons")
            elif tag == "plan":
                if ev == "start":
                    selected = el.get("selected") == "yes"
                    have_plan_act = False
            elif ev == "end" and not skip and not have_plan_act:
                have_plan_act = True
                x, y = el.get("x"), el.get("y")
                if x is None or y is None:
                    continue
                xy = (float(x), float(y))
                if selected:
                    if best is None:
                        best = xy
                elif fallback is None:
                    fallback = xy
    flush()
    logger.info("ingest_extras: %d plan homes from %d persons", len(homes), n)
    return homes
