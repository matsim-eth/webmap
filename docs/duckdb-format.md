# DuckDB Dataset Format

The contract between the **eqasim pipeline** (producer) and the **webmap
backend** (consumer). One dataset = one directory:

```
data/dataset-storage/public/{id}/
  synthetic.duckdb        # the MATSim simulation run (required)
  microcensus.duckdb      # Mikrozensus survey reference (optional but expected)
```

Both files share the same *person/trip/activity* schema so every chart can be
computed per source and compared. `microcensus.duckdb` has **no network, no
link_speeds, no spider tables** (it is a survey, not a simulation) — the map
modules are synthetic-only by design.

## Global conventions

* **CRS**: all `GEOMETRY` columns are **LV95 / EPSG:2056**. The backend
  transforms to WGS84 per query (`ST_Transform(geom,'EPSG:2056','EPSG:4326',
  always_xy := true)`). Ship geometries in LV95, never pre-transformed.
* **canton_id**: integer `1..26` following `providers/constants.py::CANTON_MAP`
  (1 = Zurich, 2 = Bern, … 26 = Jura). Precomputed by point-in-polygon in the
  pipeline — the backend does **no** spatial canton joins at request time.
  Populate it in **both** files (`persons`, `trips` origin/dest, `activities`,
  and in synthetic also `network_links`, `network_nodes`, `link_speeds`).
* **time_bin**: 15-minute slot **index** `0..95` (bin 32 = 08:00–08:15).
  Hour-bucketed columns are `*_h0 .. *_h23`.
* **times** (`start_time`, `end_time`, `departure_time`, `travel_time`):
  seconds from midnight (DOUBLE).
* **Scaling**: all transit counts inside `static_assets`
  (boardings, transfers) are **scaled to the full population**
  (raw count × 1/sample_rate) so runs with different sample rates are
  comparable. Table-level data (`trips`, `persons`, …) stays **raw**;
  the `metadata` static asset carries the factor.
* **modes**: `car, car_passenger, pt, bike, walk` (+ `taxi, truck` on links).
* **purposes**: `home, work, education, shop, leisure, other`.

## Tables — synthetic.duckdb

### Core entities

| Table | Row = | Key columns |
|---|---|---|
| `persons` | one agent | `person_id, household_id, age, sex(0/1), car_availability(always/sometimes/never), has_driving_license, employed, subscriptions_{ga,halbtax,verbund,strecke,gleis7,junior,other}, canton_id, n_activities, home_pt, home_h3_res{6,9,12}, hilbert_idx` |
| `households` | one household | `household_id, income_class, n_cars_class, n_bikes_class, ovgk` |
| `trips` | one person-trip | `person_id, trip_index, departure_time, travel_time, main_mode, preceding_purpose, following_purpose, network_distance, crowfly_distance, origin_pt, dest_pt, origin/dest_canton_id, origin/dest_h3_res{6,9}, hilbert_origin` |
| `activities` | one activity | `person_id, activity_index, purpose, start_time, end_time, is_first, is_last, location_pt, canton_id` |
| `metadata` | exactly 1 row | `schema_version, build_date, source_type, matsim_run_id, eqasim_commit_hash, person_count, trip_count, activity_count, grid_resolutions_m, bbox_lv95, hot_polygon_types, h3_resolutions, has_pt_static` |

### Network & speeds (map modules)

| Table | Row = | Notes |
|---|---|---|
| `network_links` | one MATSim link | `link_id, from_node, to_node, length, capacity, freespeed, permlanes, modes, road_type, canton_id, geom` |
| `network_nodes` | one node | `node_id, canton_id, geom` |
| `link_speeds` | link × time_bin | `avg_speed, volume, freespeed, road_type, canton_id` — **volume counts every vehicle entering the link** (cars *and* PT vehicles), from events. `freespeed`/`avg_speed` in m/s; the backend converts to km/h and derives the congestion index |

### Routed trips (spider / node-flow / zone-flow modules)

| Table | Row = | Notes |
|---|---|---|
| `spider_routes` | one routed trip | `person_id, trip_index, departure_time, route_links VARCHAR[]` — the ordered link sequence of the trip's network route (from output plans) |
| `spider_link_index` | trip × link | inverted index: `link_id, person_id, trip_index, departure_time, position, route_length` — "which trips traverse link X and where in their route" |
| `node_flow_matrix` | node × from_link × to_link | precomputed turning movements: `n_trips` |
| `spider_link_volumes_by_hex_res6` | home-hex × link | `n_traversals` (spider filtered by home location) |
| `zone_flow_link_volumes_hex_res6` | O-hex × D-hex × link | `n_trips` (zone-to-zone flows on the network) |

### Pre-aggregations (fast dashboard paths)

| Table | Row = | Notes |
|---|---|---|
| `hot_polygons` | one polygon | `polygon_id ("canton:1", "gemeinde:261", …), polygon_type, polygon_name, parent_id, polygon_geom` |
| `hot_polygon_demo` | polygon | demographic counts: `n_persons, age_*, sex_*, car_avail_*, has_driving_license, employed, subs_*, cars_*, sum_activities` |
| `hot_polygon_trips` | polygon | trip counts: `mode_*, purpose_*, dist_bucket_*, time_h0..h23, sum_network/crowfly_distance` |
| `hot_polygon_out_of_home` | polygon | persons away from home per hour: `away_h0..h23` |
| `hot_polygon_flows` | O-polygon × D-polygon | `n_trips, mode_*` |
| `demo_hex_res6/9/12` | H3 cell | same demographic columns + `cell_geom, cell_center, h3_parent_*` |
| `trip_hex_origin_res9` | H3 cell | same trip columns as hot_polygon_trips |
| `oh_hex_res9` | H3 cell | out-of-home per hour |
| `flow_hex_res9` | O-cell × D-cell | `n_trips, mode_*` |

> ⚠️ When base columns change (e.g. subscriptions filled in), the
> pre-aggregations **must be rebuilt** — the backend prefers them for speed and
> will otherwise serve stale zeros.

### static_assets

`static_assets(key VARCHAR, content_type VARCHAR, payload BLOB)` — precomputed
JSON/GeoJSON blobs served (near-)verbatim:

| Key | Format |
|---|---|
| `metadata` | JSON: `{"sample_rate": 0.01, "run_name": "...", "scaled_to_full_population": true}` — **required**; the whole 1%-vs-5% comparability rests on it |
| `boarding_data_by_line` | JSON list per transit line: `{line_id, line_name, modes[], cantons[<canton_id>], stops:[{stop_id, name, bfs, canton_id, data:[{hour, boardings, alightings}]}]}` — counts scaled to full population |
| `stop_transfer_data_by_canton` | JSON list per canton: `{canton_id, total_transfers, stops:[{stop_id, name, bfs, transfers, line_transfers:{fromLine:{toLine:n}}, stop_transfers:{destStopId:n}, total_transfers_in, total_transfers_out}]}` |
| `transit_routes` | GeoJSON FeatureCollection, one LineString per route: properties `{line_id, route_id, line_name, mode}`, coordinates WGS84 |
| `merged_segments:{cid}` | GeoJSON per canton (1..26): merged road segments with per-direction link ids/volumes in pipe-separated properties (`per_id_keys`, `per_id_arrows`, `per_id_daily_avgs`, `angle`, …) — the map's network layer |
| `municipalities` | GeoJSON of municipality polygons (`bfs` ids) |
| `stop_municipality` | JSON lookup stop_id → municipality/bfs |

**stop_id format** must be consistent across all transit assets
(e.g. `8503003:0:3.link:pt_8503003:0:3`) — the frontends join on it. The link
id embedded after `.link:` must exist in `network_links` (the backend derives
stop coordinates from that link's `to_node`).

## Tables — microcensus.duckdb

Same schema as synthetic for: `persons`, `households`, `trips`, `activities`,
`metadata`, `hot_polygons`, `hot_polygon_demo`, `hot_polygon_trips`,
`hot_polygon_out_of_home`, `demo_hex_res6/9/12`, `oh_hex_res9`,
`trip_hex_origin_res9`, `static_assets`.

**Everything the dashboard compares must be populated on both sides** — in
particular (historically these were NULL in microcensus and the charts showed
nothing / zeros): `persons.car_availability`, `has_driving_license`,
`employed`, all seven `subscriptions_*`, `n_activities`,
`activities.canton_id`, `trips.preceding_purpose`. Survey-sampled columns may
be NULL for non-interviewed household members; the backend aggregates over
`IS NOT NULL`. If a column is genuinely unavailable, leave it NULL everywhere —
the backend then **omits the source** for that chart instead of showing zeros.

## Validation checklist (run before shipping a dataset)

```sql
-- 1. metadata asset present and sane
SELECT payload FROM static_assets WHERE key='metadata';

-- 2. no forgotten empty columns (repeat per critical column)
SELECT COUNT(car_availability), COUNT(*) FROM persons;
SELECT COUNT(canton_id), COUNT(*) FROM activities;

-- 3. transit assets complete
SELECT key FROM static_assets ORDER BY key;   -- expect boarding_data_by_line,
   -- stop_transfer_data_by_canton, transit_routes, metadata,
   -- municipalities, stop_municipality, merged_segments:1..26

-- 4. link_speeds schema (v2): avg_speed + freespeed present, time_bin 0..95
PRAGMA table_info(link_speeds);
SELECT MIN(time_bin), MAX(time_bin) FROM link_speeds;

-- 5. file opens read-only and reaches its end (catches truncated uploads)
SELECT COUNT(*) FROM spider_link_index;
```

Requests for additions/changes to this contract are tracked in
`PIPELINE_DATA_REQUESTS.md` at the repo root.
