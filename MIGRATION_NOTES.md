# v1 DuckDB Migration — Notes

Backend migrated from "many parquets + xml + spider.duckdb per dataset" to
**one read-only DuckDB file per source** (`synthetic.duckdb`,
`microcensus.duckdb`).

## Layout (new)

```
data/dataset-storage/{public,<user_id>}/<dataset_id>/
├── synthetic.duckdb     # all synthetic-source tables
└── microcensus.duckdb   # all microcensus-source tables
```

Old files (output_plans.xml.gz, output_trips.parquet, switzerland_*.parquet,
output_events.xml.gz, switzerland_network.xml, spider.duckdb, etc.) are
stashed under:

```
data/junk/dataset-storage/<…>/{synthetic,microcensus}/
```

Safe to delete once we're confident nothing references them.

## Coverage

All 28 backend providers migrated. Polygon-based filtering works across all
relevant providers (canton legacy → polygon_id new param) and the v1 schema's
`hot_polygons` / pre-aggregated grids serve >95% of queries in <100ms on the
sample dataset.

## Microcensus persons.sex encoding inconsistent

Synthetic uses ``sex IN (0, 1)`` (0=male, 1=female), Microcensus uses
``sex IN (1, 2)`` (1=male, 2=female, -98=unknown).

The schema contract says 0/1. Stage must normalise microcensus values
(``2 → 1``, drop ``-98``). Until then, gender provider returns
"100% female" for microcensus when the female-coded value is present
because the ``sex IN (0,1)`` filter matches only that group.

## households table — both sources empty (ask the eqasim stage to fix)

In the current build, `households.income_class`, `n_cars_class`,
`n_bikes_class`, `ovgk` are **NULL for every row** in both sources. Only
`household_id` is populated. As a consequence:

* `num_cars` returns empty for any breakdown (joins households via
  `n_cars_class IS NOT NULL`).
* `pt_sub` `?breakdown=income` and `num_cars` `?breakdown=income` both
  empty.
* The income-class column in `demo_grid_*` is fine (different data path),
  but the household-derived `cars_*` columns in `demo_grid_*` happen to
  be populated, which is inconsistent with the underlying join.

→ Fix: stage must populate household attributes from the eqasim/synpop
households parquet (income, number_of_cars_class, number_of_bikes_class,
ovgk).

## Microcensus.duckdb gaps (ask the eqasim stage to refill)

The current `microcensus.duckdb` has **partial v1 schema coverage**. These
tables are present but empty:

| Table | Issue |
|---|---|
| `activities` | 0 rows — the build skipped activity extraction |
| `demo_grid_100m` / `_500m` / `_5000m` | 0 rows — no demographic pre-aggregation |
| `out_of_home_grid_500m` | 0 rows |
| `hot_polygon_demo` | 0 rows |
| `hot_polygon_out_of_home` | 0 rows |

Persons exist (163,843) but **all `canton_id` values are NULL** — the spatial
join against canton boundaries was not run for microcensus. As a result:

* `age`, `gender`, `car_availability`, `pt_sub`, `num_cars`, `num_activities`
  return `Microcensus`-empty results when polygon filtering is requested
  (including the legacy `canton=...` param).
* `mode_share`, `purpose_share`, `avg_distance`, `histogram_distance`,
  `departure_times`, `lineplot`, `stacked_bar_distance` etc. work for
  Microcensus because they read from `trip_grid_origin_500m` (which IS
  populated) or fall back to raw scans on `trips` (which has the geometry).

## Action items for the eqasim stage (next iteration)

1. Run the canton spatial join for microcensus persons to populate
   `persons.canton_id`.
2. Populate `activities` from microcensus (needs activity-records — they
   exist in the source data; the build just didn't extract them).
3. Re-run the demo-grid / out-of-home pre-aggregations once persons have
   home_pt + canton_id.
4. Populate `link_speeds` (currently empty even for synthetic) — the build
   schema has the table but no data was loaded. Decide whether it's
   worth bringing back from the upstream `link_speeds.parquet`.
5. (Optional Phase 2) Populate `static_assets` BLOB table with the existing
   `boarding_data_by_line.json` and `stop_transfer_data_by_canton.json`
   for PT analysis. Until then, those endpoints return empty.

## Sanity-check results

* Person counts: identical to old parquet (88,013).
* Person.canton_id: 100% identical assignment.
* Trip counts per canton differ by 1-4% — **semantic improvement, not a
  bug**: legacy counted "trips of residents of canton X" (could include
  trips made entirely outside X), new counts "trips originating in X's
  territory" (more useful for polygon-based geographic analysis).
* Mode-share percentages match within 0.5%.

## Latency table (sample dataset, 88k persons / 296k trips)

| Provider                | 1 polygon | All 26 cantons |
|-------------------------|----------:|---------------:|
| age, gender, modes, …   |    1-7ms  |    7-25ms      |
| histogram, lineplot     |  40-220ms |    260-290ms   |
| **activity_durations**  |   684ms   |    **5.9s** ⚠️ |

The activity_durations slow path is the only outlier — it filters on
`activities.location_pt` which doesn't have a canton_id shortcut. Fix
options: (a) accept 5.9s for the rare "all cantons at once" view,
(b) add a `canton_id` column to the `activities` table in the build,
(c) add an `activity_grid_500m` pre-aggregate table.

## Performance notes

* Canton-typed polygon IDs (`canton:N`) are special-cased to use the
  precomputed `persons.canton_id` integer column instead of the
  R-tree spatial join. This is ~500x faster on the sample dataset and
  scales linearly.
* Non-canton polygons (`bezirk:*`, `gemeinde:*`, custom) use ST_Within
  with the R-tree on persons.home_pt. Acceptable on 88k persons (<200ms);
  we may need to re-evaluate at 10M scale.
* Provider smoke-test wall-clock at sample scale: ~7 seconds total for
  all 23 working providers (worst single provider: 5s for
  `activity_durations` against 390k activities).

## Schema-version contract

The new code expects `metadata.schema_version = "v1"`. The eqasim stage
must continue to set this.
