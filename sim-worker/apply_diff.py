"""Apply a broker-approved scenario diff to a MATSim input bundle copy.

Input:  a working directory containing the base run's prepared inputs
        (switzerland_network.xml.gz, switzerland_transit_schedule.xml.gz,
        switzerland_transit_vehicles.xml.gz, switzerland_population.xml.gz)
Output: the same files, mutated in place, plus a diff report dict.

Fail-fast philosophy: every referenced id must exist, and destructive
network edits must not break the transit schedule — we detect that and
abort with an actionable message ("close it instead / remove the line
first") BEFORE burning compute hours.

MATSim unit notes: freespeed is m/s (DSL speaks km/h), coordinates are
EPSG:2056; the DSL speaks lon/lat and we transform here.
"""

from __future__ import annotations

import gzip
import math
from pathlib import Path

from lxml import etree

KMH = 3.6  # m/s → km/h

CLOSED_CAPACITY = 0.01
CLOSED_FREESPEED_MS = 0.1


class DiffError(RuntimeError):
    """User-actionable problem in the diff (wrong ids, unsafe removal...)."""


# ─── IO helpers ──────────────────────────────────────────────────────────

def _read_xml(path: Path) -> etree._ElementTree:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as f:
        return etree.parse(f)


def _write_xml(tree: etree._ElementTree, path: Path) -> None:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "wb") as f:
        tree.write(f, xml_declaration=True, encoding="utf-8")


def _lonlat_to_lv95(lon: float, lat: float) -> tuple[float, float]:
    from pyproj import Transformer
    t = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
    return t.transform(lon, lat)


def _point_in_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


# ─── Network ─────────────────────────────────────────────────────────────

class Network:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.tree = _read_xml(path)
        root = self.tree.getroot()
        self.nodes_el = root.find("nodes")
        self.links_el = root.find("links")
        if self.nodes_el is None or self.links_el is None:
            raise DiffError("network file has no <nodes>/<links> section")
        self.nodes = {n.get("id"): n for n in self.nodes_el.iter("node")}
        self.links = {l.get("id"): l for l in self.links_el.iter("link")}

    def save(self) -> None:
        _write_xml(self.tree, self.path)

    # -- selection ---------------------------------------------------------

    def select(self, selector: dict) -> list[str]:
        if selector.get("link_ids"):
            ids = [str(i) for i in selector["link_ids"]]
            missing = [i for i in ids if i not in self.links]
            if missing:
                raise DiffError(f"unknown link id(s): {missing[:10]}"
                                + (" ..." if len(missing) > 10 else ""))
            return ids
        f = selector["filter"]
        ring_2056 = None
        if f.get("polygon"):
            ring_2056 = [_lonlat_to_lv95(p[0], p[1]) for p in f["polygon"]]
        road_types = set(f.get("road_type_in") or [])
        want_modes = set(f.get("modes_any") or [])
        fs, cap = f.get("freespeed_kmh") or {}, f.get("capacity") or {}
        out = []
        for lid, l in self.links.items():
            if road_types:
                if (l.get("type") or "") not in road_types:
                    continue
            if want_modes:
                have = set((l.get("modes") or "").split(","))
                if not (want_modes & have):
                    continue
            v = float(l.get("freespeed") or 0) * KMH
            if fs.get("gte") is not None and v < fs["gte"]:
                continue
            if fs.get("lte") is not None and v > fs["lte"]:
                continue
            c = float(l.get("capacity") or 0)
            if cap.get("gte") is not None and c < cap["gte"]:
                continue
            if cap.get("lte") is not None and c > cap["lte"]:
                continue
            if ring_2056 is not None:
                fn = self.nodes.get(l.get("from"))
                tn = self.nodes.get(l.get("to"))
                if fn is None or tn is None:
                    continue
                mx = (float(fn.get("x")) + float(tn.get("x"))) / 2
                my = (float(fn.get("y")) + float(tn.get("y"))) / 2
                if not _point_in_ring(mx, my, ring_2056):
                    continue
            out.append(lid)
        if not out:
            raise DiffError("link filter matched no links")
        return out

    # -- operations --------------------------------------------------------

    def modify(self, ids: list[str], set_: dict | None, scale: dict | None) -> None:
        set_ = set_ or {}
        scale = scale or {}
        for lid in ids:
            l = self.links[lid]
            if set_.get("freespeed_kmh") is not None:
                l.set("freespeed", f"{set_['freespeed_kmh'] / KMH:.4f}")
            if set_.get("capacity") is not None:
                l.set("capacity", f"{set_['capacity']:.2f}")
            if set_.get("lanes") is not None:
                l.set("permlanes", f"{set_['lanes']:.2f}")
            if set_.get("modes"):
                l.set("modes", ",".join(set_["modes"]))
            if scale.get("freespeed"):
                l.set("freespeed",
                      f"{float(l.get('freespeed')) * scale['freespeed']:.4f}")
            if scale.get("capacity"):
                l.set("capacity",
                      f"{float(l.get('capacity')) * scale['capacity']:.2f}")
            if scale.get("lanes"):
                l.set("permlanes",
                      f"{float(l.get('permlanes') or 1) * scale['lanes']:.2f}")

    def close(self, ids: list[str]) -> None:
        for lid in ids:
            l = self.links[lid]
            l.set("capacity", str(CLOSED_CAPACITY))
            l.set("freespeed", str(CLOSED_FREESPEED_MS))
            l.set("permlanes", "1.0")

    def remove(self, ids: list[str]) -> None:
        for lid in ids:
            self.links_el.remove(self.links[lid])
            del self.links[lid]

    def add_node(self, node_id: str, lon: float, lat: float) -> None:
        if node_id in self.nodes:
            raise DiffError(f"node id already exists: {node_id}")
        x, y = _lonlat_to_lv95(lon, lat)
        el = etree.SubElement(self.nodes_el, "node",
                              id=node_id, x=f"{x:.2f}", y=f"{y:.2f}")
        self.nodes[node_id] = el

    def add_link(self, o: dict) -> list[str]:
        created = []
        for lid, frm, to in ([(o["link_id"], o["from_node"], o["to_node"])]
                             + ([(o["link_id"] + "_r", o["to_node"], o["from_node"])]
                                if o.get("bidirectional") else [])):
            if lid in self.links:
                raise DiffError(f"link id already exists: {lid}")
            for n in (frm, to):
                if n not in self.nodes:
                    raise DiffError(f"unknown node: {n} (add_node first, or "
                                    "pick an existing node id)")
            if o.get("length_m"):
                length = float(o["length_m"])
            else:
                fn, tn = self.nodes[frm], self.nodes[to]
                length = max(1.0, math.dist(
                    (float(fn.get("x")), float(fn.get("y"))),
                    (float(tn.get("x")), float(tn.get("y")))))
            el = etree.SubElement(
                self.links_el, "link", id=lid,
                attrib={"from": frm, "to": to})
            el.set("length", f"{length:.2f}")
            el.set("freespeed", f"{o['freespeed_kmh'] / KMH:.4f}")
            el.set("capacity", f"{o['capacity']:.2f}")
            el.set("permlanes", f"{o['lanes']:.2f}")
            el.set("oneway", "1")
            el.set("modes", ",".join(o["modes"]))
            self.links[lid] = el
            created.append(lid)
        return created


# ─── Transit schedule / vehicles ─────────────────────────────────────────

class Transit:
    def __init__(self, schedule_path: Path, vehicles_path: Path) -> None:
        self.schedule_path = schedule_path
        self.vehicles_path = vehicles_path
        self.schedule = _read_xml(schedule_path)
        self.vehicles = _read_xml(vehicles_path)
        self.lines = {l.get("id"): l
                      for l in self.schedule.getroot().iter("transitLine")}
        vroot = self.vehicles.getroot()
        self.vns = vroot.nsmap.get(None)
        self.veh_by_id = {v.get("id"): v for v in self._viter("vehicle")}
        self.type_by_id = {t.get("id"): t for t in self._viter("vehicleType")}

    def _vtag(self, tag: str) -> str:
        return f"{{{self.vns}}}{tag}" if self.vns else tag

    def _viter(self, tag: str):
        return self.vehicles.getroot().iter(self._vtag(tag))

    def save(self) -> None:
        _write_xml(self.schedule, self.schedule_path)
        _write_xml(self.vehicles, self.vehicles_path)

    def select(self, selector: dict) -> list[str]:
        if selector.get("line_ids"):
            ids = [str(i) for i in selector["line_ids"]]
            missing = [i for i in ids if i not in self.lines]
            if missing:
                raise DiffError(f"unknown transit line id(s): {missing[:10]}")
            return ids
        f = selector["filter"]
        modes = set(f.get("mode_in") or [])
        needle = (f.get("name_contains") or "").lower()
        out = []
        for lid, line in self.lines.items():
            if modes:
                route_modes = {r.findtext("transportMode") or ""
                               for r in line.iter("transitRoute")}
                if not (modes & route_modes):
                    continue
            if needle:
                name = (line.get("name") or lid).lower()
                if needle not in name:
                    continue
            out.append(lid)
        if not out:
            raise DiffError("transit filter matched no lines")
        return out

    def links_used(self) -> set[str]:
        used: set[str] = set()
        root = self.schedule.getroot()
        for sf in root.iter("stopFacility"):
            if sf.get("linkRefId"):
                used.add(sf.get("linkRefId"))
        for route in root.iter("transitRoute"):
            for l in route.iter("link"):
                if l.get("refId"):
                    used.add(l.get("refId"))
        return used

    def remove_lines(self, ids: list[str]) -> None:
        for lid in ids:
            line = self.lines.pop(lid)
            line.getparent().remove(line)

    def _departures(self, line_ids: list[str]):
        for lid in line_ids:
            for route in self.lines[lid].iter("transitRoute"):
                deps = route.find("departures")
                if deps is not None:
                    yield lid, route, deps

    @staticmethod
    def _t2s(t: str) -> int:
        h, m, s = (t.split(":") + ["0", "0"])[:3]
        return int(h) * 3600 + int(m) * 60 + int(float(s))

    @staticmethod
    def _s2t(s: int) -> str:
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"

    def scale_frequency(self, line_ids: list[str], factor: float) -> dict:
        added = removed = 0
        for lid, _route, deps in self._departures(line_ids):
            dep_list = sorted(deps.findall("departure"),
                              key=lambda d: self._t2s(d.get("departureTime")))
            if factor < 1 and len(dep_list) > 1:
                keep_every = max(1, round(1 / factor))
                for i, d in enumerate(dep_list):
                    if i % keep_every != 0:
                        deps.remove(d)
                        removed += 1
            elif factor > 1 and len(dep_list) > 1:
                extra_per_gap = int(round(factor)) - 1
                for i in range(len(dep_list) - 1):
                    t0 = self._t2s(dep_list[i].get("departureTime"))
                    t1 = self._t2s(dep_list[i + 1].get("departureTime"))
                    for k in range(1, extra_per_gap + 1):
                        t = t0 + (t1 - t0) * k // (extra_per_gap + 1)
                        base_veh = dep_list[i].get("vehicleRefId")
                        new_dep_id = f"{dep_list[i].get('id')}_x{k}"
                        new_veh_id = f"{base_veh}_x{new_dep_id}"
                        self._clone_vehicle(base_veh, new_veh_id)
                        etree.SubElement(deps, "departure", id=new_dep_id,
                                         departureTime=self._s2t(t),
                                         vehicleRefId=new_veh_id)
                        added += 1
        return {"departures_added": added, "departures_removed": removed}

    def _clone_vehicle(self, base_id: str, new_id: str) -> None:
        base = self.veh_by_id.get(base_id)
        if base is None:
            raise DiffError(f"vehicle {base_id} not found in transit vehicles")
        clone = etree.SubElement(base.getparent(), self._vtag("vehicle"),
                                 id=new_id, type=base.get("type"))
        self.veh_by_id[new_id] = clone

    def scale_vehicle_capacity(self, line_ids: list[str], factor: float) -> dict:
        # vehicles serving the selected lines
        veh_ids = {d.get("vehicleRefId")
                   for _lid, _r, deps in self._departures(line_ids)
                   for d in deps.findall("departure")}
        veh_ids.discard(None)
        scaled_types: dict[str, str] = {}
        changed = 0
        for vid in veh_ids:
            veh = self.veh_by_id.get(vid)
            if veh is None:
                continue
            old_type = veh.get("type")
            new_type = scaled_types.get(old_type)
            if new_type is None:
                new_type = f"{old_type}_x{factor:g}"
                if new_type not in self.type_by_id:
                    self._clone_scaled_type(old_type, new_type, factor)
                scaled_types[old_type] = new_type
            veh.set("type", new_type)
            changed += 1
        return {"vehicles_retyped": changed,
                "types_created": len(scaled_types)}

    def _clone_scaled_type(self, old_id: str, new_id: str, factor: float) -> None:
        base = self.type_by_id.get(old_id)
        if base is None:
            raise DiffError(f"vehicle type {old_id} not found")
        import copy
        clone = copy.deepcopy(base)
        clone.set("id", new_id)
        for cap_tag in ("capacity",):
            cap = clone.find(self._vtag(cap_tag))
            if cap is None:
                continue
            # v1 DTD: <capacity><seats persons="x"/><standingRoom persons="y"/>
            for sub in ("seats", "standingRoom"):
                el = cap.find(self._vtag(sub))
                if el is not None and el.get("persons"):
                    el.set("persons",
                           str(max(1, round(int(el.get("persons")) * factor))))
            # v2 DTD: <capacity seats="x" standingRoomInPersons="y">
            for attr in ("seats", "standingRoomInPersons"):
                if cap.get(attr):
                    cap.set(attr, str(max(1, round(int(cap.get(attr)) * factor))))
        base.getparent().append(clone)
        self.type_by_id[new_id] = clone


# ─── Population scrub (after remove_links) ───────────────────────────────

def scrub_population(pop_path: Path, removed: set[str]) -> int:
    """Drop <route> elements referencing removed links and detach affected
    activity link refs — those agents get re-routed by MATSim. Returns the
    number of scrubbed routes."""
    tree = _read_xml(pop_path)
    scrubbed = 0
    for route in tree.getroot().iter("route"):
        text = route.text or ""
        if not text.strip():
            continue
        if removed & set(text.split()):
            route.getparent().remove(route)
            scrubbed += 1
    for act in tree.getroot().iter("activity", "act"):
        if act.get("link") in removed:
            del act.attrib["link"]
    if scrubbed:
        _write_xml(tree, pop_path)
    return scrubbed


# ─── Orchestration ───────────────────────────────────────────────────────

def apply_diff(workdir: Path, diff: dict, prefix: str = "switzerland_",
               log=print) -> dict:
    """Apply all operations to the bundle copy in *workdir*. Returns a
    report dict. Raises DiffError on any user-actionable problem."""
    net_path = workdir / f"{prefix}network.xml.gz"
    sched_path = workdir / f"{prefix}transit_schedule.xml.gz"
    veh_path = workdir / f"{prefix}transit_vehicles.xml.gz"
    pop_path = workdir / f"{prefix}population.xml.gz"
    for p in (net_path, sched_path, veh_path, pop_path):
        if not p.exists():
            raise DiffError(f"bundle file missing: {p.name}")

    ops = diff.get("operations") or []
    needs_net = any(o["op"] in ("modify_links", "close_links", "remove_links",
                                "add_node", "add_link") for o in ops)
    needs_transit = any(o["op"].startswith(("remove_transit",
                                            "scale_transit")) for o in ops)
    log("parsing network ..." if needs_net else "network untouched")
    net = Network(net_path) if needs_net else None
    log("parsing transit ..." if needs_transit else "transit untouched")
    transit = (Transit(sched_path, veh_path)
               if needs_transit or any(o["op"] == "remove_links" for o in ops)
               else None)

    report: dict = {"operations": []}
    removed_links: set[str] = set()

    for o in ops:
        op = o["op"]
        if op == "modify_links":
            ids = net.select(o["select"])
            net.modify(ids, o.get("set"), o.get("scale"))
            report["operations"].append({"op": op, "links": len(ids)})
        elif op == "close_links":
            ids = net.select(o["select"])
            net.close(ids)
            report["operations"].append({"op": op, "links": len(ids)})
        elif op == "remove_links":
            ids = net.select(o["select"])
            if transit is None:
                transit = Transit(sched_path, veh_path)
            conflict = set(ids) & transit.links_used()
            if conflict:
                raise DiffError(
                    f"link(s) {sorted(conflict)[:5]} are used by the transit "
                    "schedule - close_links them instead, or remove the "
                    "affected transit lines first")
            net.remove(ids)
            removed_links |= set(ids)
            report["operations"].append({"op": op, "links": len(ids)})
        elif op == "add_node":
            net.add_node(o["node_id"], o["lon"], o["lat"])
            report["operations"].append({"op": op, "node": o["node_id"]})
        elif op == "add_link":
            created = net.add_link(o)
            report["operations"].append({"op": op, "links": created})
        elif op == "remove_transit_lines":
            ids = transit.select(o["select"])
            transit.remove_lines(ids)
            report["operations"].append({"op": op, "lines": len(ids)})
        elif op == "scale_transit_frequency":
            ids = transit.select(o["select"])
            r = transit.scale_frequency(ids, o["factor"])
            report["operations"].append({"op": op, "lines": len(ids), **r})
        elif op == "scale_transit_vehicle_capacity":
            ids = transit.select(o["select"])
            r = transit.scale_vehicle_capacity(ids, o["factor"])
            report["operations"].append({"op": op, "lines": len(ids), **r})
        else:
            raise DiffError(f"unknown operation: {op}")

    if removed_links:
        log(f"scrubbing population routes over {len(removed_links)} removed link(s) ...")
        report["routes_scrubbed"] = scrub_population(pop_path, removed_links)

    if net is not None:
        log("writing network ...")
        net.save()
    if transit is not None and needs_transit:
        log("writing transit files ...")
        transit.save()
    return report
