"""Re-zone a v2/v3 dataset to a different study area / zone level.

Takes a dataset directory (synthetic.duckdb + microcensus.duckdb built from
the Swiss-wide pipeline), optionally filters it to one canton, and re-zones it
by a smaller admin level (gemeinde/municipality or bezirk/district) already
present in the dataset's own ``hot_polygons`` table. The output is a
self-contained v3 dataset whose *primary zones* are the chosen level — the
webapp then treats that area as the study area (see GENERALIZATION_PLAN.md).

This is the canonical implementation of the admin panel's "Study area" control
(POST /datasets/{id}/rezone runs it as a background thread; job status is
persisted to ``<out_root>/.rezone.json`` so any uvicorn worker can report it).
It is also runnable standalone:

  python rezone.py --source-dir <dataset dir> --out-dir <new dir> \
      --canton-id 1 --zone-type gemeinde --name "Canton Zürich"

Semantics (verified against the source builder's own aggregate rows):
  * persons: home inside a kept primary zone → new ``zone_id`` column
  * trips:   origin/dest inside OR by a kept person → ``origin_zone_id`` /
             ``dest_zone_id`` (hot_polygon_trips is origin-based)
  * activities: located inside OR by a kept person → ``zone_id``
  * network/link_speeds/spider/node_flow (synthetic only): filtered; link
    zone = centroid point-in-polygon
  * pt_link_volumes (synthetic only): zoned via the re-zoned ``network_links``;
    the ``pt_*`` stop pseudo-links are kept whole with a NULL zone (see
    ``_copy_pt_link_volumes``)
  * hot_polygon_* rows: copied for kept polygons (home-/origin-based ⇒ exact)
  * demo_hex_res6/9/12 + trip_hex_origin_res9: rebuilt exactly from the
    filtered tables (incl. the upstream ``cars_3_plus``='3+' quirk);
    oh_hex_res9 copy-filtered (its away_h* columns are unused by providers)
  * static assets: new ``study_area`` (v3), boarding stops re-tagged to the
    zone id via their ``bfs`` field (bezirk level maps bfs → parent bezirk),
    transit_routes/stop_municipality/municipalities filtered;
    ``merged_segments:{zone_id}`` rebuilt per primary zone from the re-zoned
    ``network_links`` (see below); stop_transfer_data_by_canton dropped
    (canton-level aggregate).

The legacy ``canton_id``-spelled columns are kept unchanged; the backend's
``zone_col()`` probe prefers the new ``zone_id`` spellings.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import traceback
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

JOB_FILE = ".rezone.json"

ZONE_TYPE_LABELS = {
    "gemeinde": ("Municipality", "Municipalities"),
    "bezirk": ("District", "Districts"),
    "canton": ("Canton", "Cantons"),
}


# ─── job status (file-based: shared across uvicorn workers) ────────────────

def _write_job(out_root: str | Path, **fields) -> None:
    path = Path(out_root) / JOB_FILE
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        current = {}
    current.update(fields, updated_at=datetime.now(timezone.utc).isoformat())
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current), encoding="utf-8")
    os.replace(tmp, path)


def read_job(out_root: str | Path) -> dict | None:
    path = Path(out_root) / JOB_FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"state": "error", "detail": "unreadable job file"}


# ─── SQL builders (formulas verified against source hot_polygon rows) ──────

def _demo_agg_sql(h3_col: str, cars3_expr: str) -> str:
    return f"""
        SELECT p.{h3_col} AS h3,
          COUNT(*)::INT AS n_persons,
          COUNT(*) FILTER (WHERE p.age >= 0  AND p.age < 6 )::INT AS age_0_6,
          COUNT(*) FILTER (WHERE p.age >= 6  AND p.age < 15)::INT AS age_6_15,
          COUNT(*) FILTER (WHERE p.age >= 15 AND p.age < 18)::INT AS age_15_18,
          COUNT(*) FILTER (WHERE p.age >= 18 AND p.age < 24)::INT AS age_18_24,
          COUNT(*) FILTER (WHERE p.age >= 24 AND p.age < 30)::INT AS age_24_30,
          COUNT(*) FILTER (WHERE p.age >= 30 AND p.age < 45)::INT AS age_30_45,
          COUNT(*) FILTER (WHERE p.age >= 45 AND p.age < 65)::INT AS age_45_65,
          COUNT(*) FILTER (WHERE p.age >= 65 AND p.age < 80)::INT AS age_65_80,
          COUNT(*) FILTER (WHERE p.age >= 80)::INT               AS age_80_plus,
          COUNT(*) FILTER (WHERE p.sex = 0)::INT AS sex_male,
          COUNT(*) FILTER (WHERE p.sex = 1)::INT AS sex_female,
          COUNT(*) FILTER (WHERE p.car_availability = 'always')::INT    AS car_avail_always,
          COUNT(*) FILTER (WHERE p.car_availability = 'sometimes')::INT AS car_avail_sometimes,
          COUNT(*) FILTER (WHERE p.car_availability = 'never')::INT     AS car_avail_never,
          COUNT(*) FILTER (WHERE p.has_driving_license)::INT AS has_driving_license,
          COUNT(*) FILTER (WHERE p.employed)::INT            AS employed,
          COUNT(*) FILTER (WHERE p.subscriptions_ga)::INT       AS subs_ga,
          COUNT(*) FILTER (WHERE p.subscriptions_halbtax)::INT  AS subs_halbtax,
          COUNT(*) FILTER (WHERE p.subscriptions_verbund)::INT  AS subs_verbund,
          COUNT(*) FILTER (WHERE p.subscriptions_strecke)::INT  AS subs_strecke,
          COUNT(*) FILTER (WHERE p.subscriptions_gleis7)::INT   AS subs_gleis7,
          COUNT(*) FILTER (WHERE p.subscriptions_junior)::INT   AS subs_junior,
          COUNT(*) FILTER (WHERE p.subscriptions_other)::INT    AS subs_other,
          COUNT(*) FILTER (WHERE h.n_cars_class = '0')::INT AS cars_0,
          COUNT(*) FILTER (WHERE h.n_cars_class = '1')::INT AS cars_1,
          COUNT(*) FILTER (WHERE h.n_cars_class = '2')::INT AS cars_2,
          {cars3_expr}::INT AS cars_3_plus,
          COALESCE(SUM(p.n_activities), 0)::INT AS sum_activities
        FROM persons p LEFT JOIN households h USING (household_id)
        WHERE p.{h3_col} IS NOT NULL
        GROUP BY 1
    """


def _trip_agg_sql(h3_col: str) -> str:
    time_cols = ",\n          ".join(
        f"COUNT(*) FILTER (WHERE t.departure_time < 86400 AND "
        f"CAST(t.departure_time / 3600 AS INT) = {h})::INT AS time_h{h}"
        for h in range(24)
    )
    return f"""
        SELECT t.{h3_col} AS h3,
          COUNT(*)::INT AS n_trips,
          COUNT(*) FILTER (WHERE t.main_mode = 'car')::INT           AS mode_car,
          COUNT(*) FILTER (WHERE t.main_mode = 'pt')::INT            AS mode_pt,
          COUNT(*) FILTER (WHERE t.main_mode = 'walk')::INT          AS mode_walk,
          COUNT(*) FILTER (WHERE t.main_mode = 'bike')::INT          AS mode_bike,
          COUNT(*) FILTER (WHERE t.main_mode = 'car_passenger')::INT AS mode_car_passenger,
          COUNT(*) FILTER (WHERE t.following_purpose = 'home')::INT      AS purpose_home,
          COUNT(*) FILTER (WHERE t.following_purpose = 'work')::INT      AS purpose_work,
          COUNT(*) FILTER (WHERE t.following_purpose = 'education')::INT AS purpose_education,
          COUNT(*) FILTER (WHERE t.following_purpose = 'shop')::INT      AS purpose_shop,
          COUNT(*) FILTER (WHERE t.following_purpose = 'leisure')::INT   AS purpose_leisure,
          COUNT(*) FILTER (WHERE t.following_purpose = 'other')::INT     AS purpose_other,
          COALESCE(SUM(t.network_distance), 0) AS sum_network_distance,
          COALESCE(SUM(t.crowfly_distance), 0) AS sum_crowfly_distance,
          COUNT(*) FILTER (WHERE t.network_distance < 1000)::INT  AS dist_bucket_0_1km,
          COUNT(*) FILTER (WHERE t.network_distance >= 1000  AND t.network_distance < 3000 )::INT AS dist_bucket_1_3km,
          COUNT(*) FILTER (WHERE t.network_distance >= 3000  AND t.network_distance < 10000)::INT AS dist_bucket_3_10km,
          COUNT(*) FILTER (WHERE t.network_distance >= 10000 AND t.network_distance < 30000)::INT AS dist_bucket_10_30km,
          COUNT(*) FILTER (WHERE t.network_distance >= 30000)::INT AS dist_bucket_30_plus_km,
          {time_cols}
        FROM trips t
        WHERE t.{h3_col} IS NOT NULL
        GROUP BY 1
    """


# ─── per-source build ──────────────────────────────────────────────────────

def _cols_of(con, catalog: str, table: str) -> list[str]:
    return [r[0] for r in con.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_catalog = ? AND table_name = ? ORDER BY ordinal_position",
        [catalog, table],
    ).fetchall()]


def _table_exists(con, catalog: str, table: str) -> bool:
    return bool(con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_catalog = ? AND table_name = ?",
        [catalog, table],
    ).fetchone())


def _count(con, table: str) -> int:
    return con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _star(alias: str, cols: list[str], drop: set[str]) -> str:
    """``alias.*`` minus any of *drop* that actually exist on the table.

    Re-zoning a dataset that was itself re-zoned earlier means the source
    tables already carry ``zone_id``-style columns; selecting ``p.*`` plus a
    new ``zone_id`` would silently create a duplicate column and every later
    query would read the stale one."""
    present = drop & set(cols)
    if not present:
        return f"{alias}.*"
    return f"{alias}.* EXCLUDE ({', '.join(sorted(present))})"


def _copy_pt_link_volumes(con) -> None:
    """Copy ``pt_link_volumes`` into the re-zoned dataset, adding ``zone_id``.

    The table mixes two kinds of ``link_id``, which need opposite treatment:

    * **real network links** — carried over by joining the already re-zoned
      ``network_links``, which both assigns the primary-zone id and filters the
      table to the study area. Every non-``pt_*`` link_id in the source joins
      (475,807 of 475,807 on the Swiss dataset), so nothing is lost but
      out-of-area rows.
    * **``pt_*`` stop pseudo-links** — no geometry, hence no zone. Kept whole
      with a NULL ``zone_id``: ``volumes_by_link_line`` filters on the zone and
      never wanted them (the frontend skips ``pt_*`` ids when building
      ``servedModes``), whereas ``stop_line_directions`` scans them *unfiltered*
      to tag each stop-line pair with the .H/.R directions that call there.
      Dropping them would silently make the transit direction filter inert.
      ~9k rows country-wide, so keeping the lot is free and also covers stops
      just outside the study area.

    The two halves are made explicitly disjoint rather than relying on ``pt_*``
    ids being absent from ``network_links``, so a pseudo-link that ever does
    match a real link can't be counted twice.
    """
    v_star = _star("v", _cols_of(con, "src", "pt_link_volumes"), {"zone_id"})
    con.execute(rf"""
        CREATE TABLE pt_link_volumes AS
        SELECT {v_star}, nl.zone_id
        FROM src.pt_link_volumes v JOIN network_links nl USING (link_id)
        WHERE v.link_id NOT LIKE 'pt\_%' ESCAPE '\'
        UNION ALL
        SELECT {v_star}, CAST(NULL AS INTEGER) AS zone_id
        FROM src.pt_link_volumes v
        WHERE v.link_id LIKE 'pt\_%' ESCAPE '\'
    """)


def _build_source(src_path: Path, out_path: Path, canton_id: int | None,
                  zone_type: str, is_synthetic: bool, progress) -> dict:
    import duckdb

    if out_path.exists():
        out_path.unlink()
    con = duckdb.connect(str(out_path))
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"ATTACH '{src_path.as_posix()}' AS src (READ_ONLY)")

    # ── hot_polygons subset ────────────────────────────────────────────────
    progress("hot_polygons")
    if canton_id is None:
        con.execute("CREATE TABLE hot_polygons AS SELECT * FROM src.hot_polygons")
    else:
        canton_pid = f"canton:{canton_id}"
        con.execute(f"""
            CREATE TABLE hot_polygons AS
            WITH lvl1 AS (
                SELECT * FROM src.hot_polygons WHERE parent_id = '{canton_pid}'
            ),
            keep AS (
                SELECT * FROM src.hot_polygons WHERE polygon_id = '{canton_pid}'
                UNION ALL SELECT * FROM lvl1
                UNION ALL
                SELECT g.* FROM src.hot_polygons g JOIN lvl1 b ON g.parent_id = b.polygon_id
                UNION ALL
                SELECT g.* FROM src.hot_polygons g
                WHERE g.polygon_type = '{zone_type}' AND g.parent_id = '{canton_pid}'
            )
            SELECT DISTINCT ON (polygon_id) * FROM keep
        """)
    n_zones = con.execute(
        "SELECT COUNT(*) FROM hot_polygons WHERE polygon_type = ?", [zone_type]
    ).fetchone()[0]
    if n_zones == 0:
        raise RuntimeError(f"no '{zone_type}' zones found in this dataset"
                           + (f" under canton {canton_id}" if canton_id else ""))
    con.execute("CREATE INDEX idx_hot_polygons_type ON hot_polygons(polygon_type)")
    try:
        con.execute("CREATE INDEX rtree_hot_polygons_geom ON hot_polygons USING RTREE(polygon_geom)")
    except Exception:
        pass
    con.execute(f"""
        CREATE VIEW gem AS
        SELECT CAST(SPLIT_PART(polygon_id, ':', 2) AS INT) AS zid, polygon_geom
        FROM hot_polygons WHERE polygon_type = '{zone_type}'
    """)

    # ── persons / households ───────────────────────────────────────────────
    progress("persons")
    p_star = _star("p", _cols_of(con, "src", "persons"), {"zone_id"})
    con.execute(f"""
        CREATE TABLE persons AS
        SELECT {p_star}, z.zid AS zone_id
        FROM src.persons p JOIN gem z ON ST_Within(p.home_pt, z.polygon_geom)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY p.person_id ORDER BY z.zid) = 1
    """)
    con.execute("""
        CREATE TABLE households AS
        SELECT h.* FROM src.households h
        WHERE h.household_id IN (SELECT DISTINCT household_id FROM persons)
    """)

    # ── trips ──────────────────────────────────────────────────────────────
    progress("trips")
    trip_cols = _cols_of(con, "src", "trips")
    have_pts = "origin_pt" in trip_cols and "dest_pt" in trip_cols
    if have_pts:
        con.execute("""
            CREATE TEMP TABLE _to AS
            SELECT t.person_id, t.trip_index, z.zid
            FROM src.trips t JOIN gem z ON ST_Within(t.origin_pt, z.polygon_geom)
            QUALIFY ROW_NUMBER() OVER (PARTITION BY t.person_id, t.trip_index ORDER BY z.zid) = 1
        """)
        con.execute("""
            CREATE TEMP TABLE _td AS
            SELECT t.person_id, t.trip_index, z.zid
            FROM src.trips t JOIN gem z ON ST_Within(t.dest_pt, z.polygon_geom)
            QUALIFY ROW_NUMBER() OVER (PARTITION BY t.person_id, t.trip_index ORDER BY z.zid) = 1
        """)
        t_star = _star("t", trip_cols, {"origin_zone_id", "dest_zone_id"})
        con.execute(f"""
            CREATE TABLE trips AS
            SELECT {t_star}, o.zid AS origin_zone_id, d.zid AS dest_zone_id
            FROM src.trips t
            LEFT JOIN _to o USING (person_id, trip_index)
            LEFT JOIN _td d USING (person_id, trip_index)
            WHERE o.zid IS NOT NULL OR d.zid IS NOT NULL
               OR t.person_id IN (SELECT person_id FROM persons)
        """)
    else:
        t_star = _star("t", trip_cols, {"origin_zone_id", "dest_zone_id"})
        con.execute(f"""
            CREATE TABLE trips AS
            SELECT {t_star}, CAST(NULL AS INT) AS origin_zone_id, CAST(NULL AS INT) AS dest_zone_id
            FROM src.trips t
            WHERE t.person_id IN (SELECT person_id FROM persons)
        """)

    # ── activities ─────────────────────────────────────────────────────────
    progress("activities")
    act_cols = _cols_of(con, "src", "activities")
    if "location_pt" in act_cols:
        con.execute("""
            CREATE TEMP TABLE _az AS
            SELECT a.person_id, a.activity_index, z.zid
            FROM src.activities a JOIN gem z ON ST_Within(a.location_pt, z.polygon_geom)
            QUALIFY ROW_NUMBER() OVER (PARTITION BY a.person_id, a.activity_index ORDER BY z.zid) = 1
        """)
        a_star = _star("a", act_cols, {"zone_id"})
        con.execute(f"""
            CREATE TABLE activities AS
            SELECT {a_star}, x.zid AS zone_id
            FROM src.activities a
            LEFT JOIN _az x USING (person_id, activity_index)
            WHERE x.zid IS NOT NULL
               OR a.person_id IN (SELECT person_id FROM persons)
        """)
    else:
        a_star = _star("a", act_cols, {"zone_id"})
        con.execute(f"""
            CREATE TABLE activities AS
            SELECT {a_star}, CAST(NULL AS INT) AS zone_id FROM src.activities a
            WHERE a.person_id IN (SELECT person_id FROM persons)
        """)

    # ── network / speeds / spider (synthetic only) ─────────────────────────
    if is_synthetic and _table_exists(con, "src", "network_links"):
        progress("network")
        canton_clause = f"l.canton_id = {canton_id} OR " if canton_id is not None else ""
        l_star = _star("l", _cols_of(con, "src", "network_links"), {"zone_id"})
        con.execute(f"""
            CREATE TABLE network_links AS
            SELECT {l_star}, z.zid AS zone_id
            FROM src.network_links l
            LEFT JOIN gem z ON ST_Within(ST_Centroid(l.geom), z.polygon_geom)
            WHERE {canton_clause}z.zid IS NOT NULL
            QUALIFY ROW_NUMBER() OVER (PARTITION BY l.link_id ORDER BY z.zid) = 1
        """)
        canton_clause_n = f"n.canton_id = {canton_id} OR " if canton_id is not None else ""
        n_star = _star("n", _cols_of(con, "src", "network_nodes"), {"zone_id"})
        con.execute(f"""
            CREATE TABLE network_nodes AS
            SELECT {n_star}, z.zid AS zone_id
            FROM src.network_nodes n
            LEFT JOIN gem z ON ST_Within(n.geom, z.polygon_geom)
            WHERE {canton_clause_n}z.zid IS NOT NULL
            QUALIFY ROW_NUMBER() OVER (PARTITION BY n.node_id ORDER BY z.zid) = 1
        """)
        if _table_exists(con, "src", "link_speeds"):
            progress("link_speeds")
            s_star = _star("s", _cols_of(con, "src", "link_speeds"), {"zone_id"})
            con.execute(f"""
                CREATE TABLE link_speeds AS
                SELECT {s_star}, nl.zone_id FROM src.link_speeds s
                JOIN network_links nl USING (link_id)
            """)
        if _table_exists(con, "src", "pt_link_volumes"):
            progress("pt_link_volumes")
            _copy_pt_link_volumes(con)
        if _table_exists(con, "src", "node_flow_matrix"):
            con.execute("""
                CREATE TABLE node_flow_matrix AS
                SELECT m.* FROM src.node_flow_matrix m
                WHERE m.node_id IN (SELECT node_id FROM network_nodes)
            """)
        if _table_exists(con, "src", "spider_routes"):
            progress("spider")
            con.execute("""
                CREATE TABLE spider_routes AS
                SELECT sr.* FROM src.spider_routes sr JOIN trips t USING (person_id, trip_index)
            """)
        if _table_exists(con, "src", "spider_link_index"):
            con.execute("""
                CREATE TABLE spider_link_index AS
                SELECT s.* FROM src.spider_link_index s
                JOIN trips t USING (person_id, trip_index)
                WHERE s.link_id IN (SELECT link_id FROM network_links)
            """)

    # ── hot_polygon_* rows: copy for kept polygons (exact) ─────────────────
    progress("aggregates")
    for t in ("hot_polygon_demo", "hot_polygon_trips", "hot_polygon_out_of_home"):
        if _table_exists(con, "src", t):
            con.execute(f"""
                CREATE TABLE {t} AS SELECT s.* FROM src.{t} s
                WHERE s.polygon_id IN (SELECT polygon_id FROM hot_polygons)
            """)
    if _table_exists(con, "src", "hot_polygon_flows"):
        con.execute("""
            CREATE TABLE hot_polygon_flows AS SELECT s.* FROM src.hot_polygon_flows s
            WHERE s.origin_polygon_id IN (SELECT polygon_id FROM hot_polygons)
              AND s.dest_polygon_id   IN (SELECT polygon_id FROM hot_polygons)
        """)

    # ── hex grids: rebuild demo + trip, copy-filter oh ─────────────────────
    progress("hex grids")
    cars3_src = con.execute(
        "SELECT COALESCE(SUM(cars_3_plus),0) FROM src.hot_polygon_demo").fetchone()[0]
    cars3_expr = ("COUNT(*) FILTER (WHERE h.n_cars_class = '3+')" if cars3_src == 0
                  else "COUNT(*) FILTER (WHERE h.n_cars_class IN ('3', '3+'))")
    for res in (6, 9, 12):
        t = f"demo_hex_res{res}"
        if not _table_exists(con, "src", t):
            continue
        struct = [c for c in _cols_of(con, "src", t)
                  if c in ("h3_index", "h3_parent_res6", "cell_geom", "cell_center")]
        struct_sql = ", ".join(f"s.{c}" for c in struct)
        con.execute(f"""
            CREATE TABLE {t} AS
            SELECT {struct_sql}, a.* EXCLUDE (h3)
            FROM ({_demo_agg_sql(f'home_h3_res{res}', cars3_expr)}) a
            JOIN src.{t} s ON s.h3_index = a.h3
        """)
    if _table_exists(con, "src", "trip_hex_origin_res9") and "origin_h3_res9" in trip_cols:
        struct = [c for c in _cols_of(con, "src", "trip_hex_origin_res9")
                  if c in ("h3_index", "h3_parent_res6", "cell_geom", "cell_center")]
        struct_sql = ", ".join(f"s.{c}" for c in struct)
        con.execute(f"""
            CREATE TABLE trip_hex_origin_res9 AS
            SELECT {struct_sql}, a.* EXCLUDE (h3)
            FROM ({_trip_agg_sql('origin_h3_res9')}) a
            JOIN src.trip_hex_origin_res9 s ON s.h3_index = a.h3
        """)
    if _table_exists(con, "src", "oh_hex_res9"):
        con.execute("""
            CREATE TABLE oh_hex_res9 AS
            SELECT s.* FROM src.oh_hex_res9 s
            WHERE s.h3_index IN (SELECT DISTINCT home_h3_res9 FROM persons
                                 WHERE home_h3_res9 IS NOT NULL)
        """)

    # ── metadata table ─────────────────────────────────────────────────────
    if _table_exists(con, "src", "metadata"):
        con.execute("CREATE TABLE metadata AS SELECT * FROM src.metadata")
        try:
            bbox = con.execute("""
                SELECT [MIN(ST_XMin(polygon_geom)), MIN(ST_YMin(polygon_geom)),
                        MAX(ST_XMax(polygon_geom)), MAX(ST_YMax(polygon_geom))]
                FROM hot_polygons WHERE polygon_type = ?
            """, [zone_type]).fetchone()[0]
            con.execute(
                "UPDATE metadata SET schema_version = 'v3', person_count = ?, "
                "trip_count = ?, activity_count = ?, bbox_lv95 = ?, hot_polygon_types = ?",
                [_count(con, "persons"), _count(con, "trips"), _count(con, "activities"),
                 bbox, [zone_type, "bezirk", "canton"]],
            )
        except Exception:
            pass

    con.execute("CREATE TABLE static_assets AS SELECT * FROM src.static_assets LIMIT 0")

    # ── sanity check: copied hot rows must equal the filtered tables ───────
    mism = con.execute(f"""
        SELECT COUNT(*) FROM hot_polygon_demo hp
        WHERE hp.polygon_id LIKE '{zone_type}:%'
          AND hp.n_persons <> (SELECT COUNT(*) FROM persons p
                               WHERE p.zone_id = CAST(SPLIT_PART(hp.polygon_id, ':', 2) AS INT))
    """).fetchone()[0]
    if mism:
        logger.warning("rezone: %d hot_polygon_demo rows mismatch the persons table "
                       "(border-geometry edge cases)", mism)

    # ── indexes ────────────────────────────────────────────────────────────
    progress("indexes")
    idx = [
        ("idx_persons_zone", "persons(zone_id)"),
        ("idx_persons_h3_r6", "persons(home_h3_res6)"),
        ("idx_persons_h3_r9", "persons(home_h3_res9)"),
        ("idx_persons_h3_r12", "persons(home_h3_res12)"),
        ("idx_trips_origin_zone", "trips(origin_zone_id)"),
        ("idx_trips_dest_zone", "trips(dest_zone_id)"),
        ("idx_trips_mode", "trips(main_mode)"),
        ("idx_activities_zone", "activities(zone_id)"),
        ("idx_activities_purpose", "activities(purpose)"),
    ]
    if is_synthetic and _table_exists(con, "src", "network_links"):
        idx += [
            ("idx_network_links_zone", "network_links(zone_id)"),
            ("idx_network_links_road_type", "network_links(road_type)"),
            ("idx_network_nodes_zone", "network_nodes(zone_id)"),
            ("idx_link_speeds_link", "link_speeds(link_id)"),
            ("idx_link_speeds_zone", "link_speeds(zone_id)"),
            ("idx_link_speeds_road_type", "link_speeds(road_type)"),
            ("idx_ptlv_zone", "pt_link_volumes(zone_id)"),
            ("idx_ptlv_link", "pt_link_volumes(link_id)"),
            ("idx_nfm_node", "node_flow_matrix(node_id)"),
            ("idx_spider_link", "spider_link_index(link_id)"),
            ("idx_spider_link_trip", "spider_link_index(person_id, trip_index)"),
        ]
    for name, spec in idx:
        try:
            con.execute(f"CREATE INDEX {name} ON {spec}")
        except Exception:
            pass
    rtrees = [("rtree_persons_home", "persons", "home_pt")]
    if have_pts:
        rtrees += [("rtree_trips_origin", "trips", "origin_pt"),
                   ("rtree_trips_dest", "trips", "dest_pt")]
    if "location_pt" in act_cols:
        rtrees += [("rtree_activities_loc", "activities", "location_pt")]
    if is_synthetic and _table_exists(con, "src", "network_links"):
        rtrees += [("rtree_network_links", "network_links", "geom"),
                   ("rtree_network_nodes", "network_nodes", "geom")]
    for res in (6, 9, 12):
        if _table_exists(con, "src", f"demo_hex_res{res}"):
            rtrees.append((f"rtree_demo_hex_res{res}", f"demo_hex_res{res}", "cell_geom"))
    for t, col in (("trip_hex_origin_res9", "cell_geom"), ("oh_hex_res9", "cell_geom")):
        if _table_exists(con, "src", t):
            rtrees.append((f"rtree_{t}", t, col))
    for name, table, col in rtrees:
        try:
            con.execute(f"CREATE INDEX {name} ON {table} USING RTREE({col})")
        except Exception:
            pass

    con.execute("DROP VIEW gem")

    # bfs → primary zone id map for transit re-tagging (stops carry `bfs`):
    # gemeinde level: identity; bezirk level: gemeinde bfs → parent bezirk id.
    zone_ids = {r[0] for r in con.execute(
        f"SELECT CAST(SPLIT_PART(polygon_id, ':', 2) AS INT) FROM hot_polygons "
        f"WHERE polygon_type = '{zone_type}'").fetchall()}
    if zone_type == "gemeinde":
        bfs_to_zone = {z: z for z in zone_ids}
    elif zone_type == "bezirk":
        rows = con.execute("""
            SELECT CAST(SPLIT_PART(g.polygon_id, ':', 2) AS INT),
                   CAST(SPLIT_PART(g.parent_id, ':', 2) AS INT)
            FROM hot_polygons g
            WHERE g.polygon_type = 'gemeinde' AND g.parent_id LIKE 'bezirk:%'
        """).fetchall()
        bfs_to_zone = {bfs: bz for bfs, bz in rows if bz in zone_ids}
    else:
        bfs_to_zone = None  # canton level: keep original stop canton_id
    return {"con": con, "bfs_to_zone": bfs_to_zone, "zone_ids": zone_ids}


# ─── merged network segments, one asset per primary zone ───────────────────
#
# The webmap serves `matsim/{zone}_merged_segments.geojson` out of a
# `merged_segments:{zone_id}` static asset, where zone_id is the dataset's
# *primary* zone (webmap-backend `main.py:_canton_id_from`). The Swiss-wide
# export writes those assets keyed by canton, so a re-zoned dataset can neither
# copy them (a gemeinde-zoned dataset is asked for `merged_segments:261`, not
# `:1`) nor cheaply slice them (each is one 30-50 MB JSON blob). They are
# rebuilt here from the already-re-zoned `network_links` table.
#
# This is the merge the webmap backend used to do per request when an asset was
# missing (`providers/network_geometry.py:_rebuild_from_network_links`), moved
# to build time: the ~11 s per canton is paid once here instead of on every cold
# zone click, and the shipped dataset is self-contained.

_COORD_DECIMALS = 6  # ~0.1 m — plenty for the map; keeps the payload small
_SEGMENT_CRS = "EPSG:2056"  # LV95, matching the study_area asset written above


def _round_coords(geom: dict) -> dict:
    """Round LineString/MultiLineString coordinates to _COORD_DECIMALS.

    Deterministic, so a link and its reversed-coordinate twin still round to
    identical values — the forward/reverse pairing below stays exact.
    """
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return geom
    if t == "LineString":
        geom["coordinates"] = [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in c]
    elif t == "MultiLineString":
        geom["coordinates"] = [
            [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in line] for line in c
        ]
    return geom


def _flat_coords(geom: dict):
    """Flatten a LineString/MultiLineString to a [[x, y], ...] list."""
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "LineString":
        return c
    if t == "MultiLineString":
        return [pt for line in c for pt in line]
    return None


def _arrow_for_coords(coords) -> str:
    """Direction glyph for one link — the Python twin of the frontend's
    ``arrowForCoords``. Westward (start lon > end lon) → ``←``, else ``→``;
    falls back to latitude for (near-)vertical links so a reversed pair still
    gets opposite glyphs."""
    if not coords or len(coords) < 2:
        return "→"
    s_lon, s_lat = coords[0][0], coords[0][1]
    e_lon, e_lat = coords[-1][0], coords[-1][1]
    if s_lon != e_lon:
        return "←" if s_lon > e_lon else "→"
    return "←" if s_lat > e_lat else "→"


def _geometry_key(coords) -> str:
    """Direction-independent geometry key: the smaller of the forward and
    reversed coordinate sequences, so a link and its reversed twin land in one
    bucket."""
    parts = [f"{x},{y}" for x, y in coords]
    fwd = ";".join(parts)
    rev = ";".join(reversed(parts))
    return fwd if fwd <= rev else rev


def _js_num(v) -> str:
    """Stringify a per-link scalar the way the frontend's pipe arrays expect
    (JSON number → JS ``toString``): integral floats lose the trailing ``.0``.
    ``None`` → empty string, which ``parsePipeList``/``pipeMinMax`` drop."""
    if v is None:
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


def _merge_rows(rows) -> dict | None:
    """Group directed links sharing a 2D geometry into one feature per visual
    segment, carrying the index-aligned ``per_id_*`` pipe arrays."""
    groups: "OrderedDict[str, dict]" = OrderedDict()
    singletons = []  # degenerate geometries that can't merge; kept as-is
    for link_id, modes, capacity, freespeed, length, permlanes, road_type, gj in rows:
        if not gj:
            continue
        geom = _round_coords(json.loads(gj))
        coords = _flat_coords(geom)
        rep = {
            "link_id": link_id, "modes": modes, "capacity": capacity,
            "freespeed": freespeed, "length": length, "permlanes": permlanes,
            "road_type": road_type,
        }
        if not coords or len(coords) < 2:
            singletons.append({"type": "Feature", "properties": rep, "geometry": geom})
            continue
        key = _geometry_key(coords)
        grp = groups.get(key)
        if grp is None:
            grp = {"geometry": geom, "rep": rep, "keys": [], "arrows": [],
                   "freespeeds": [], "capacities": [], "lengths": [], "permlanes": []}
            groups[key] = grp
        grp["keys"].append(str(link_id))
        grp["arrows"].append(_arrow_for_coords(coords))
        grp["freespeeds"].append(_js_num(freespeed))
        grp["capacities"].append(_js_num(capacity))
        grp["lengths"].append(_js_num(length))
        grp["permlanes"].append(_js_num(permlanes))

    # Merged segments first, so features[0] always carries per_id_keys — both
    # the webmap's fat-asset sniff and the frontend's "already merged?" guard
    # only inspect the first feature.
    features = [
        {
            "type": "Feature",
            "properties": {
                **grp["rep"],
                "per_id_keys": "|".join(grp["keys"]),
                "per_id_arrows": "|".join(grp["arrows"]),
                "per_id_freespeeds": "|".join(grp["freespeeds"]),
                "per_id_capacities": "|".join(grp["capacities"]),
                "per_id_lengths": "|".join(grp["lengths"]),
                "per_id_permlanes": "|".join(grp["permlanes"]),
            },
            "geometry": grp["geometry"],
        }
        for grp in groups.values()
    ]
    features.extend(singletons)
    if not features:
        return None
    return {"type": "FeatureCollection", "features": features}


def _build_merged_segments(con, progress=None) -> int:
    """Write one ``merged_segments:{zone_id}`` asset per primary zone.

    One query per zone rather than one for the whole area: the JSON object graph
    of a whole canton peaks around a gigabyte, whereas a single gemeinde is
    trivial, and the per-zone slices are exactly what gets served anyway. Runs
    off ``idx_network_links_zone``.

    Returns the number of assets written.
    """
    cat = con.execute("SELECT current_database()").fetchone()[0]
    cols = set(_cols_of(con, cat, "network_links"))
    if not {"link_id", "geom"} <= cols:
        return 0
    zcol = "zone_id" if "zone_id" in cols else "canton_id"
    if zcol not in cols:
        return 0

    def plain(name):
        return name if name in cols else "NULL"

    def finite(name, expr):
        # Some PT links carry freespeed = Infinity. json.dumps would emit the
        # literal `Infinity` token, which is invalid JSON and makes the
        # frontend's res.json() throw. Coerce non-finite values to NULL.
        return f"CASE WHEN isfinite({name}) THEN {expr} END" if name in cols else "NULL"

    select = f"""
        SELECT link_id,
               {plain('modes')} AS modes,
               {finite('capacity', 'ROUND(capacity, 1)')} AS capacity,
               -- m/s → km/h: the Network colour ramp and the attribute tables
               -- all label and expect km/h; network_links stores m/s.
               {finite('freespeed', 'ROUND(freespeed * 3.6, 2)')} AS freespeed,
               {finite('length', 'ROUND(length, 2)')} AS length,
               {finite('permlanes', 'permlanes')} AS permlanes,
               {plain('road_type')} AS road_type,
               ST_AsGeoJSON(
                   ST_Transform(geom, '{_SEGMENT_CRS}', 'EPSG:4326', always_xy := true)
               ) AS gj
        FROM network_links
        WHERE {zcol} = ?
    """

    zones = [r[0] for r in con.execute(
        f"SELECT DISTINCT {zcol} FROM network_links WHERE {zcol} IS NOT NULL ORDER BY 1"
    ).fetchall()]
    written = 0
    for i, zid in enumerate(zones):
        if progress and i % 25 == 0:
            progress(f"merged segments {i + 1}/{len(zones)}")
        fc = _merge_rows(con.execute(select, [zid]).fetchall())
        if fc is None:
            continue
        _insert_asset(con, f"merged_segments:{zid}", fc,
                      content_type="application/geo+json")
        written += 1
    return written


# ─── static assets (synthetic db) ──────────────────────────────────────────

def _insert_asset(con, key: str, obj, content_type: str = "application/json") -> None:
    payload = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    con.execute(
        "INSERT INTO static_assets (key, content_type, payload) VALUES (?, ?, ?)",
        [key, content_type, payload],
    )


def _load_src_asset(con, key: str):
    row = con.execute("SELECT payload FROM src.static_assets WHERE key = ?", [key]).fetchone()
    return json.loads(bytes(row[0])) if row and row[0] is not None else None


def _build_static_assets(info: dict, zone_type: str, name: str, zoom: float,
                         progress=None) -> None:
    con, bfs_to_zone, zone_ids = info["con"], info["bfs_to_zone"], info["zone_ids"]

    bbox, center = con.execute(f"""
        SELECT [MIN(x1), MIN(y1), MAX(x2), MAX(y2)],
               [(MIN(x1)+MAX(x2))/2, (MIN(y1)+MAX(y2))/2]
        FROM (SELECT ST_XMin(g) x1, ST_YMin(g) y1, ST_XMax(g) x2, ST_YMax(g) y2
              FROM (SELECT ST_Transform(polygon_geom, 'EPSG:2056', 'EPSG:4326',
                                         always_xy := true) AS g
                    FROM hot_polygons WHERE polygon_type = '{zone_type}'))
    """).fetchone()
    label = ZONE_TYPE_LABELS.get(zone_type, (zone_type.capitalize(), zone_type.capitalize() + "s"))
    _insert_asset(con, "study_area", {
        "schema_version": 3,
        "name": name,
        "crs": "EPSG:2056",
        "primary_zone_type": zone_type,
        "zone_types": [{"type": zone_type, "label": label[0], "label_plural": label[1]}],
        "bbox": [round(v, 5) for v in bbox],
        "center": [round(v, 5) for v in center],
        "zoom": zoom,
    })

    meta = _load_src_asset(con, "metadata")
    if meta is not None:
        _insert_asset(con, "metadata", meta)

    kept_line_ids: set = set()
    lines = _load_src_asset(con, "boarding_data_by_line")
    if lines is not None and bfs_to_zone is not None:
        out_lines = []
        for line in lines:
            stops = [dict(s, canton_id=bfs_to_zone[s["bfs"]])
                     for s in (line.get("stops") or []) if s.get("bfs") in bfs_to_zone]
            if not stops:
                continue
            nl = dict(line)
            nl["stops"] = stops
            nl["cantons"] = sorted({s["canton_id"] for s in stops})
            out_lines.append(nl)
            kept_line_ids.add(line.get("line_id"))
        _insert_asset(con, "boarding_data_by_line", out_lines)
    elif lines is not None:
        _insert_asset(con, "boarding_data_by_line", lines)
        kept_line_ids = {l.get("line_id") for l in lines}

    routes = _load_src_asset(con, "transit_routes")
    if routes is not None and kept_line_ids:
        feats = [f for f in routes.get("features", [])
                 if (f.get("properties") or {}).get("line_id") in kept_line_ids]
        _insert_asset(con, "transit_routes",
                      {"type": "FeatureCollection", "features": feats},
                      content_type="application/geo+json")

    sm = _load_src_asset(con, "stop_municipality")
    if sm is not None:
        lookup = bfs_to_zone if bfs_to_zone is not None else {}
        kept = {k: v for k, v in sm.items()
                if (v.get("bfs") in lookup) or bfs_to_zone is None}
        _insert_asset(con, "stop_municipality", kept)

    muni = _load_src_asset(con, "municipalities")
    if muni is not None:
        gem_bfs = zone_ids if zone_type == "gemeinde" else set(
            (bfs_to_zone or {}).keys())
        feats = [f for f in muni.get("features", [])
                 if not gem_bfs or (f.get("properties") or {}).get("bfs") in gem_bfs]
        _insert_asset(con, "municipalities",
                      {"type": "FeatureCollection", "features": feats},
                      content_type="application/geo+json")
    # stop_transfer_data_by_canton: canton-level aggregate — dropped on purpose.

    # Per-zone network geometry. The source assets are canton-keyed, so they are
    # rebuilt rather than copied; without this the webmap has no network for the
    # re-zoned area at all.
    cat = con.execute("SELECT current_database()").fetchone()[0]
    if _table_exists(con, cat, "network_links"):
        n = _build_merged_segments(con, progress)
        logger.info("rezone: wrote %d merged_segments assets", n)


# ─── job entry points ──────────────────────────────────────────────────────

def run_rezone(source_dir: str | Path, out_dir: str | Path, canton_id: int | None,
               zone_type: str, name: str, zoom: float | None = None) -> None:
    """Build the re-zoned dataset. Raises on failure; writes no job file."""
    source_dir, out_dir = Path(source_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if zoom is None:
        zoom = 9.5 if canton_id is not None else 7.5

    for category in ("synthetic", "microcensus"):
        src = source_dir / f"{category}.duckdb"
        if not src.exists():
            continue
        out = out_dir / f"{category}.duckdb"
        def progress(step, _c=category):
            _write_job(out_dir, state="running", step=f"{_c}: {step}")
        info = _build_source(src, out, canton_id, zone_type,
                             is_synthetic=(category == "synthetic"), progress=progress)
        try:
            if category == "synthetic":
                progress("static assets")
                _build_static_assets(info, zone_type, name, zoom, progress)
            info["con"].execute("DETACH src")
        finally:
            info["con"].close()


def backfill_merged_segments(dataset_dir: str | Path) -> int:
    """Add the ``merged_segments:{zone_id}`` assets to an already-built dataset.

    Datasets re-zoned before those assets were written have a full
    ``network_links`` table but no network geometry to serve from it. This
    rebuilds the assets in place — cheaper and safer than re-running the whole
    re-zone, and idempotent (existing merged_segments rows are replaced).
    """
    import duckdb

    db = Path(dataset_dir) / "synthetic.duckdb"
    if not db.exists():
        raise FileNotFoundError(f"{db} not present")
    con = duckdb.connect(str(db))
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute("DELETE FROM static_assets WHERE key LIKE 'merged_segments:%'")
        n = _build_merged_segments(con, progress=lambda s: logger.info("  %s", s))
        logger.info("backfill: wrote %d merged_segments assets to %s", n, db)
        return n
    finally:
        con.close()


def backfill_pt_link_volumes(dataset_dir: str | Path,
                             source_dir: str | Path) -> int:
    """Add the ``pt_link_volumes`` table to an already re-zoned dataset.

    Datasets re-zoned before this table was carried over have a complete
    ``network_links`` but no PT volumes, so the matsim bridge 404s
    ``volumes_by_link_line`` and the Transit Volumes module has no numbers.
    Needs the original Swiss-wide *source* dataset, since the volumes only
    exist there. Idempotent (drops any existing table first).

    ``webmap_backend`` must be stopped: DuckDB refuses a read-write open while
    it holds the read lock — same constraint as backfill_merged_segments.
    """
    import duckdb

    db = Path(dataset_dir) / "synthetic.duckdb"
    src = Path(source_dir) / "synthetic.duckdb"
    for p in (db, src):
        if not p.exists():
            raise FileNotFoundError(f"{p} not present")
    con = duckdb.connect(str(db))
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"ATTACH '{src}' AS src (READ_ONLY)")
        if not _table_exists(con, "src", "pt_link_volumes"):
            raise ValueError(f"{src} has no pt_link_volumes table to copy")
        con.execute("DROP TABLE IF EXISTS pt_link_volumes")
        _copy_pt_link_volumes(con)
        for name, spec in (("idx_ptlv_zone", "pt_link_volumes(zone_id)"),
                           ("idx_ptlv_link", "pt_link_volumes(link_id)")):
            try:
                con.execute(f"CREATE INDEX {name} ON {spec}")
            except Exception:
                pass
        n = _count(con, "pt_link_volumes")
        logger.info("backfill: wrote %d pt_link_volumes rows to %s", n, db)
        return n
    finally:
        con.close()


def run_rezone_job(source_dir, out_dir, canton_id, zone_type, name,
                   source_dataset_id=None) -> None:
    """Thread target: run the build and persist the outcome to .rezone.json."""
    _write_job(out_dir, state="running", step="starting",
               source_dataset_id=source_dataset_id, canton_id=canton_id,
               zone_type=zone_type, name=name,
               started_at=datetime.now(timezone.utc).isoformat())
    try:
        run_rezone(source_dir, out_dir, canton_id, zone_type, name)
        _write_job(out_dir, state="done", step="finished",
                   finished_at=datetime.now(timezone.utc).isoformat())
    except Exception as exc:
        logger.exception("rezone job failed")
        _write_job(out_dir, state="error", detail=f"{exc}",
                   trace=traceback.format_exc()[-2000:],
                   finished_at=datetime.now(timezone.utc).isoformat())


def start_rezone_thread(source_dir, out_dir, canton_id, zone_type, name,
                        source_dataset_id=None) -> None:
    _write_job(out_dir, state="running", step="queued",
               source_dataset_id=source_dataset_id, canton_id=canton_id,
               zone_type=zone_type, name=name)
    threading.Thread(
        target=run_rezone_job,
        args=(source_dir, out_dir, canton_id, zone_type, name, source_dataset_id),
        name=f"rezone-{source_dataset_id}",
        daemon=True,
    ).start()


# ─── dataset introspection for the admin UI dropdowns ─────────────────────

def study_area_options(source_dir: str | Path) -> dict:
    """Read the dataset's synthetic.duckdb and report what re-zoning is possible."""
    import duckdb

    db = Path(source_dir) / "synthetic.duckdb"
    if not db.exists():
        raise FileNotFoundError("synthetic.duckdb not present")
    con = duckdb.connect(str(db), read_only=True)
    try:
        types = [r[0] for r in con.execute(
            "SELECT DISTINCT polygon_type FROM hot_polygons").fetchall()]
        cantons = [
            {"id": int(str(pid).split(":", 1)[1]), "name": pname}
            for pid, pname in con.execute(
                "SELECT polygon_id, polygon_name FROM hot_polygons "
                "WHERE polygon_type = 'canton' ORDER BY polygon_name").fetchall()
        ]
        current = None
        try:
            row = con.execute(
                "SELECT payload FROM static_assets WHERE key = 'study_area'").fetchone()
            if row and row[0] is not None:
                sa = json.loads(bytes(row[0]))
                current = {"name": sa.get("name"),
                           "primary_zone_type": sa.get("primary_zone_type")}
        except Exception:
            pass
        return {
            "zone_types": [t for t in ("gemeinde", "bezirk") if t in types],
            "cantons": cantons,
            "current": current or {"name": "Switzerland", "primary_zone_type": "canton"},
        }
    finally:
        con.close()


# ─── CLI ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level="INFO", format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Re-zone a dataset to a smaller study area")
    ap.add_argument("--backfill-merged-segments", metavar="DATASET_DIR", default=None,
                    help="Only rebuild the merged_segments assets of an existing "
                         "dataset directory, in place; ignores the other options")
    ap.add_argument("--backfill-pt-link-volumes", metavar="DATASET_DIR", default=None,
                    help="Only rebuild the pt_link_volumes table of an existing "
                         "re-zoned dataset, in place; needs --source-dir (the "
                         "Swiss-wide dataset it was re-zoned from)")
    ap.add_argument("--source-dir")
    ap.add_argument("--out-dir")
    ap.add_argument("--canton-id", type=int, default=None,
                    help="Filter to this canton (omit to keep the whole area)")
    ap.add_argument("--zone-type", default="gemeinde", choices=["gemeinde", "bezirk"])
    ap.add_argument("--name", default=None)
    ap.add_argument("--zoom", type=float, default=None)
    args = ap.parse_args()
    if args.backfill_merged_segments:
        n = backfill_merged_segments(args.backfill_merged_segments)
        print(f"done: {n} merged_segments assets in {args.backfill_merged_segments}")
        raise SystemExit(0)
    if args.backfill_pt_link_volumes:
        if not args.source_dir:
            ap.error("--backfill-pt-link-volumes needs --source-dir")
        n = backfill_pt_link_volumes(args.backfill_pt_link_volumes, args.source_dir)
        print(f"done: {n} pt_link_volumes rows in {args.backfill_pt_link_volumes}")
        raise SystemExit(0)
    if not args.source_dir or not args.out_dir:
        ap.error("--source-dir and --out-dir are required")
    nm = args.name or (f"Canton {args.canton_id} ({args.zone_type})"
                       if args.canton_id else f"Study area ({args.zone_type})")
    run_rezone(args.source_dir, args.out_dir, args.canton_id, args.zone_type, nm, args.zoom)
    print("done:", args.out_dir)
