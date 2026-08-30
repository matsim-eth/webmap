"""apply_diff against realistic MATSim fixture XMLs — every operation,
plus the safety rails (unknown ids, transit-conflict on remove)."""

from __future__ import annotations

import gzip
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from apply_diff import DiffError, Network, Transit, apply_diff  # noqa: E402

NETWORK = """<?xml version="1.0" encoding="utf-8"?>
<network>
 <nodes>
  <node id="n1" x="2683000" y="1247000"/>
  <node id="n2" x="2683500" y="1247000"/>
  <node id="n3" x="2684000" y="1247000"/>
 </nodes>
 <links>
  <link id="L1" from="n1" to="n2" length="500" freespeed="13.88" capacity="1200" permlanes="2" oneway="1" modes="car,bus" type="primary"/>
  <link id="L2" from="n2" to="n3" length="500" freespeed="8.33" capacity="600" permlanes="1" oneway="1" modes="car" type="residential"/>
  <link id="pt_1" from="n1" to="n3" length="1000" freespeed="27.7" capacity="9999" permlanes="1" oneway="1" modes="pt" type=""/>
 </links>
</network>
"""

SCHEDULE = """<?xml version="1.0" encoding="utf-8"?>
<transitSchedule>
 <transitStops>
  <stopFacility id="s1" x="2683000" y="1247000" linkRefId="L1" name="Start"/>
  <stopFacility id="s2" x="2684000" y="1247000" linkRefId="pt_1" name="End"/>
 </transitStops>
 <transitLine id="bus-80" name="80">
  <transitRoute id="r1">
   <transportMode>bus</transportMode>
   <routeProfile>
    <stop refId="s1" departureOffset="00:00:00"/>
    <stop refId="s2" arrivalOffset="00:10:00"/>
   </routeProfile>
   <route>
    <link refId="L1"/>
    <link refId="pt_1"/>
   </route>
   <departures>
    <departure id="d1" departureTime="08:00:00" vehicleRefId="v1"/>
    <departure id="d2" departureTime="08:20:00" vehicleRefId="v2"/>
    <departure id="d3" departureTime="08:40:00" vehicleRefId="v1"/>
   </departures>
  </transitRoute>
 </transitLine>
 <transitLine id="tram-9" name="9">
  <transitRoute id="r2">
   <transportMode>tram</transportMode>
   <routeProfile><stop refId="s1" departureOffset="00:00:00"/></routeProfile>
   <route><link refId="pt_1"/></route>
   <departures>
    <departure id="t1" departureTime="09:00:00" vehicleRefId="v3"/>
   </departures>
  </transitRoute>
 </transitLine>
</transitSchedule>
"""

VEHICLES = """<?xml version="1.0" encoding="UTF-8"?>
<vehicleDefinitions xmlns="http://www.matsim.org/files/dtd">
 <vehicleType id="bus_type">
  <capacity><seats persons="40"/><standingRoom persons="20"/></capacity>
 </vehicleType>
 <vehicle id="v1" type="bus_type"/>
 <vehicle id="v2" type="bus_type"/>
 <vehicle id="v3" type="bus_type"/>
</vehicleDefinitions>
"""

POPULATION = """<?xml version="1.0" encoding="utf-8"?>
<population>
 <person id="p1">
  <plan selected="yes">
   <activity type="home" link="L2" x="2683600" y="1247000" end_time="07:00:00"/>
   <leg mode="car"><route type="links">L2 L1</route></leg>
   <activity type="work" link="L1" x="2683100" y="1247000"/>
  </plan>
 </person>
 <person id="p2">
  <plan selected="yes">
   <activity type="home" link="L1" x="2683050" y="1247000" end_time="08:00:00"/>
   <leg mode="car"><route type="links">L1</route></leg>
   <activity type="shop" link="L1" x="2683200" y="1247000"/>
  </plan>
 </person>
</population>
"""


@pytest.fixture()
def bundle(tmp_path: Path) -> Path:
    for name, content in (("switzerland_network.xml.gz", NETWORK),
                          ("switzerland_transit_schedule.xml.gz", SCHEDULE),
                          ("switzerland_transit_vehicles.xml.gz", VEHICLES),
                          ("switzerland_population.xml.gz", POPULATION)):
        with gzip.open(tmp_path / name, "wt") as f:
            f.write(content)
    return tmp_path


def _net(bundle: Path) -> Network:
    return Network(bundle / "switzerland_network.xml.gz")


def test_modify_set_and_scale(bundle):
    apply_diff(bundle, {"operations": [
        {"op": "modify_links", "select": {"link_ids": ["L1"]},
         "set": {"freespeed_kmh": 30, "capacity": 800},
         "scale": {"lanes": 0.5}},
    ]})
    l1 = _net(bundle).links["L1"]
    assert abs(float(l1.get("freespeed")) - 30 / 3.6) < 0.01
    assert float(l1.get("capacity")) == 800
    assert float(l1.get("permlanes")) == 1.0


def test_filter_selection_road_type_and_speed(bundle):
    apply_diff(bundle, {"operations": [
        {"op": "modify_links",
         "select": {"filter": {"road_type_in": ["residential"]}},
         "scale": {"freespeed": 0.5}},
    ]})
    net = _net(bundle)
    assert abs(float(net.links["L2"].get("freespeed")) - 8.33 / 2) < 0.01
    assert float(net.links["L1"].get("freespeed")) == 13.88   # untouched


def test_polygon_filter(bundle):
    # ring around node n1/n2 midpoint only (lon/lat around 8.53/47.38 →
    # use a huge ring covering everything vs. a tiny far-away ring)
    everything = [[5, 45], [11, 45], [11, 48.5], [5, 48.5]]
    apply_diff(bundle, {"operations": [
        {"op": "close_links",
         "select": {"filter": {"modes_any": ["car"], "polygon": everything}}},
    ]})
    net = _net(bundle)
    assert float(net.links["L1"].get("capacity")) == 0.01
    assert float(net.links["pt_1"].get("capacity")) == 9999   # pt untouched


def test_unknown_link_fails(bundle):
    with pytest.raises(DiffError, match="unknown link"):
        apply_diff(bundle, {"operations": [
            {"op": "close_links", "select": {"link_ids": ["nope"]}}]})


def test_remove_link_conflicts_with_transit(bundle):
    with pytest.raises(DiffError, match="used by the transit"):
        apply_diff(bundle, {"operations": [
            {"op": "remove_links", "select": {"link_ids": ["L1"]}}]})


def test_remove_link_scrubs_population(bundle):
    report = apply_diff(bundle, {"operations": [
        {"op": "remove_links", "select": {"link_ids": ["L2"]}}]})
    assert report["routes_scrubbed"] == 1
    net = _net(bundle)
    assert "L2" not in net.links
    with gzip.open(bundle / "switzerland_population.xml.gz", "rt") as f:
        pop = f.read()
    assert "L2 L1" not in pop            # p1's route gone
    assert 'link="L2"' not in pop        # activity ref detached
    assert ">L1<" in pop                 # p2's route intact


def test_add_node_and_bidirectional_link(bundle):
    apply_diff(bundle, {"operations": [
        {"op": "add_node", "node_id": "n_new", "lon": 8.54, "lat": 47.38},
        {"op": "add_link", "link_id": "L_new", "from_node": "n1",
         "to_node": "n_new", "freespeed_kmh": 80, "capacity": 2000,
         "lanes": 2, "modes": ["car"], "bidirectional": True},
    ]})
    net = _net(bundle)
    assert "n_new" in net.nodes
    assert "L_new" in net.links and "L_new_r" in net.links
    assert float(net.links["L_new"].get("length")) > 1
    assert abs(float(net.links["L_new"].get("freespeed")) - 80 / 3.6) < 0.01


def test_add_link_unknown_node_fails(bundle):
    with pytest.raises(DiffError, match="unknown node"):
        apply_diff(bundle, {"operations": [
            {"op": "add_link", "link_id": "x", "from_node": "n1",
             "to_node": "ghost", "freespeed_kmh": 50, "capacity": 1000,
             "lanes": 1, "modes": ["car"]}]})


def test_remove_transit_line(bundle):
    apply_diff(bundle, {"operations": [
        {"op": "remove_transit_lines", "select": {"line_ids": ["tram-9"]}}]})
    t = Transit(bundle / "switzerland_transit_schedule.xml.gz",
                bundle / "switzerland_transit_vehicles.xml.gz")
    assert "tram-9" not in t.lines and "bus-80" in t.lines


def test_transit_filter_by_mode(bundle):
    t = Transit(bundle / "switzerland_transit_schedule.xml.gz",
                bundle / "switzerland_transit_vehicles.xml.gz")
    assert t.select({"filter": {"mode_in": ["tram"]}}) == ["tram-9"]
    assert t.select({"filter": {"name_contains": "80"}}) == ["bus-80"]


def test_scale_frequency_up_and_down(bundle):
    report = apply_diff(bundle, {"operations": [
        {"op": "scale_transit_frequency",
         "select": {"line_ids": ["bus-80"]}, "factor": 2.0}]})
    entry = report["operations"][0]
    assert entry["departures_added"] == 2      # one midpoint per gap
    t = Transit(bundle / "switzerland_transit_schedule.xml.gz",
                bundle / "switzerland_transit_vehicles.xml.gz")
    deps = [d for _l, _r, ds in t._departures(["bus-80"])
            for d in ds.findall("departure")]
    assert len(deps) == 5
    times = sorted(t._t2s(d.get("departureTime")) for d in deps)
    assert times == sorted([28800, 29400, 30000, 30600, 31200])
    # cloned vehicles exist for the new departures
    for d in deps:
        assert d.get("vehicleRefId") in t.veh_by_id

    report2 = apply_diff(bundle, {"operations": [
        {"op": "scale_transit_frequency",
         "select": {"line_ids": ["bus-80"]}, "factor": 0.5}]})
    assert report2["operations"][0]["departures_removed"] == 2


def test_scale_vehicle_capacity(bundle):
    report = apply_diff(bundle, {"operations": [
        {"op": "scale_transit_vehicle_capacity",
         "select": {"line_ids": ["bus-80"]}, "factor": 1.5}]})
    entry = report["operations"][0]
    assert entry["vehicles_retyped"] == 2 and entry["types_created"] == 1
    t = Transit(bundle / "switzerland_transit_schedule.xml.gz",
                bundle / "switzerland_transit_vehicles.xml.gz")
    new_type = t.type_by_id["bus_type_x1.5"]
    seats = new_type.find(t._vtag("capacity")).find(t._vtag("seats"))
    assert seats.get("persons") == "60"
    assert t.veh_by_id["v1"].get("type") == "bus_type_x1.5"
    assert t.veh_by_id["v3"].get("type") == "bus_type"       # tram untouched
