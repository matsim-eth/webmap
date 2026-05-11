# Webmap Build v1 — Issues found in first iteration

Briefing an den Server-Agent, der die eqasim-Stage `webmap_export` baut.
Backend-Migration ist durch und läuft, aber beim End-to-End-Testen sind
mehrere Lücken in den Build-Outputs aufgefallen, die du im nächsten Run
fixen musst.

**Schema-Version bleibt `v1`** — keine Schema-Änderung, nur Daten-Befüllung.

---

## Operative Eckpunkte

- **Sample-Datensatz für deinen Test-Run**: <!-- TODO: hier den Pfad oder
  Hinweis "kein kleinerer Sample verfügbar, bitte gegen den 4M-Households-
  Run testen" eintragen -->
- **Deadline**: <!-- TODO: Datum oder "asap" / "bis nächsten Sync" -->
- **Scope-Ausnahmen**: <!-- TODO: falls #3 (static_assets) NICHT in dieser
  Iteration drin sein soll, hier explizit machen. Sonst Punkt belassen. -->

Inspection-Befehl, mit dem ich die Lücken identifiziert habe:

```python
import duckdb
con = duckdb.connect("synthetic.duckdb", read_only=True)
con.execute("LOAD spatial;")
con.execute("DESCRIBE households").fetchall()
con.execute("SELECT COUNT(*) FROM households WHERE income_class IS NOT NULL").fetchone()
# ... etc.
```

---

# 1. `microcensus.duckdb` ist halb-fertig — komplett rebuilden ⚠️ KRITISCH

Die Datei ist nicht "kleine Lücken hier und da", sondern **strukturell
unfertig**: nur die Trip-Hälfte der Pipeline ist gelaufen, die Person-
und Demographic-Hälfte fehlt komplett. Konkret betroffen sind 6
zusammenhängende Probleme — bitte alle in einem Rutsch fixen, sonst
schiebt man das mehrere Iterationen hin und her.

## 1.1 Was im Microcensus-Build aktuell funktioniert (zur Orientierung)

Damit klar ist, was du **nicht** kaputtmachen sollst:

```
microcensus.persons              → 163,843 rows  ✅ (Demographics da)
microcensus.households           →  57,090 rows  ⚠️ (siehe 1.2)
microcensus.trips                → 170,141 rows  ✅
microcensus.trip_grid_origin_500m → 20,728 rows  ✅
microcensus.hot_polygon_trips    →   2,251 rows  ✅
microcensus.hot_polygons         →   2,322 rows  ✅
metadata.schema_version           → "v1"          ✅
```

Trip-Pipeline läuft also. Person/Activity/Demographic-Pipeline nicht.

## 1.2 microcensus.households — Attribute alle NULL

```
households.income_class  IS NOT NULL → 0 rows
households.n_cars_class  IS NOT NULL → 0 rows
households.n_bikes_class IS NOT NULL → 0 rows
households.ovgk          IS NOT NULL → 0 rows
```

Nur `household_id` befüllt. **Auch in synthetic.duckdb passiert das
gleiche** — siehe Punkt 2 unten, das ist also ein Cross-Source-Problem.

**Fix für microcensus**: Felder aus `microcensus/households.parquet`
bzw. `household_info.parquet` mappen:
- `income_class`
- `n_cars_class` (im Parquet wahrscheinlich `number_of_cars_class`)
- `n_bikes_class` (`number_of_bikes_class`)
- `ovgk`

## 1.3 microcensus.persons.canton_id — alle NULL

```
SELECT COUNT(*) FROM persons WHERE canton_id IS NOT NULL
→ 0  (von 163,843 Personen)
```

Spatial-Join gegen Canton-Boundaries wurde für microcensus **nicht
ausgeführt**, nur für synthetic. In synthetic funktioniert es
fehlerfrei — alle 88,013 Personen haben canton_id korrekt zugewiesen.

**Fix**: Den gleichen Spatial-Join, den du für synthetic.persons gegen
`swissBOUNDARIES3D_TLM_KANTONSGEBIET` machst, auch für microcensus.
Microcensus persons haben `home_x`, `home_y` (LV95) direkt im Parquet —
also kein Plans-XML-Parsing nötig wie bei synthetic, einfach direkt
joinen.

## 1.4 microcensus.persons.sex — falsches Encoding

Schema-Contract sagt `sex INTEGER` mit `0=male, 1=female`.

In synthetic korrekt:
```
sex 0: 43,605
sex 1: 44,408
```

In microcensus FALSCH:
```
sex 1:  81,029
sex 2:  82,779
sex -98:    35  (unbekannt)
```

Das ist die Microcensus-Source-Codierung (1=male, 2=female,
-98=unbekannt) ohne Normalisierung.

**Auswirkung**: `gender` Provider kombiniert beide Sources. Das
`WHERE sex IN (0, 1)`-Filter im Backend matched bei microcensus nur
sex=1, also 100% einer Kategorie statt 50/50.

**Fix**: in der Stage Microcensus-Sex normalisieren:

```python
# Normalize microcensus sex encoding to schema contract
sex_map = {1: 0, 2: 1}   # microcensus 1=male → 0; 2=female → 1
df["sex"] = df["sex"].map(sex_map)   # NULL für -98 (unknown)
```

Alle anderen sex-Codes (-98, NULL) → NULL setzen, NICHT auf 0/1 mappen.

## 1.5 microcensus.activities — leer

```
SELECT COUNT(*) FROM activities → 0
```

Activities-Extraktion wurde übersprungen. Microcensus-Source hat
Activities aber implizit über die trips: jeder Trip hat
`preceding_purpose` und `following_purpose`, daraus kann man die
Activity-Sequenz pro Person rekonstruieren.

**Fix-Vorschlag**: Pro Person:

1. Die Trips chronologisch sortieren (by `departure_time`)
2. Activity[0] = "home" (start before first trip), location =
   `persons.home_pt`
3. Für i>0: Activity[i] = `trip[i-1].following_purpose`, location =
   `trip[i-1].destination`
4. Letzte Activity nach dem letzten Trip
5. start_time/end_time aus den Trip-Zeiten ableiten:
   - `activity.start_time = preceding_trip.arrival_time`
   - `activity.end_time = following_trip.departure_time`

`microcensus/trips.parquet` hat `origin_x/y`, `destination_x/y`,
`purpose` und Zeiten — alle Daten sind da.

**Auswirkung wenn nicht gefixt**: `activity_durations`,
`frequent_sequences`, `out_of_home`, `num_activities` liefern für
Microcensus leer.

## 1.6 microcensus pre-aggregated Demo-Grids — alle leer

```
demo_grid_100m            → 0 rows
demo_grid_500m            → 0 rows
demo_grid_5000m           → 0 rows
out_of_home_grid_500m     → 0 rows
hot_polygon_demo          → 0 rows
hot_polygon_out_of_home   → 0 rows
```

Folgt direkt aus 1.3 (kein canton_id) und 1.5 (keine activities). Sobald
das gefixt ist, kannst du dieselbe Pre-Agg-Logik wie für synthetic
laufen lassen.

## 1.7 Erwarteter Endzustand microcensus.duckdb

Nach dem Fix sollten alle diese Counts > 0 sein:

```
households mit n_cars_class IS NOT NULL  > 0
persons mit canton_id IS NOT NULL        > 95% von ~163,843
persons.sex DISTINCT-Werte               ⊆ {0, 1}  (nichts anderes)
activities                               > 100,000 (~1 act/trip + home-acts)
demo_grid_100m, _500m, _5000m            > 0
out_of_home_grid_500m                    > 0
hot_polygon_demo                         > 0
hot_polygon_out_of_home                  > 0
metadata.activity_count                  > 0
```

---

# 2. `households`-Attribute auch in synthetic.duckdb leer ⚠️ kritisch

Gleiches Problem wie 1.2, aber **auch in synthetic**:

```
synthetic.households    : 4,082,061 Zeilen
households.income_class IS NOT NULL → 0 rows
households.n_cars_class IS NOT NULL → 0 rows
... (alle Attribute NULL)
```

**Auswirkung im Backend** (synthetic + microcensus gleichermaßen):

- `num_cars` Provider liefert leer (joins via `n_cars_class IS NOT NULL`)
- `pt_sub?breakdown=income` liefert leer
- `num_cars?breakdown=income` liefert leer

**Fix**: Stage muss aus dem Synpop-Households-Stage (synthetic) und aus
`microcensus/households.parquet` bzw. `household_info.parquet`
(microcensus) die Felder mappen:

- **synthetic**: `income`, `number_of_cars_class`,
  `number_of_bikes_class`, `ovgk` aus dem Synpop-Output
- **microcensus**: gleiche Felder aus dem Microcensus-Households-
  Parquet (siehe 1.2)

Der Build-Step war wohl da, hat aber nur die `household_id` geschrieben
ohne die Attribute zu joinen.

---

# 3. `static_assets` table — leer in beiden Sources (war geplant)

```
SELECT COUNT(*) FROM static_assets → 0
```

War im Briefing als optional/Phase-2 markiert. Wenn `json_preview_dir`
vom alten webmap-Postprocess existiert mit den static-PT-JSONs
(`boarding_data_by_line.json`, `stop_transfer_data_by_canton.json`),
dann diese als BLOB reinkopieren:

```python
for fname in [
    "boarding_data_by_line.json",
    "stop_transfer_data_by_canton.json",
    # ggf. weitere
]:
    fpath = json_preview_dir / fname
    if fpath.exists():
        key = fname.replace(".json", "")
        with open(fpath, "rb") as f:
            payload = f.read()
        con.execute(
            "INSERT INTO static_assets VALUES (?, ?, ?)",
            [key, "application/json", payload],
        )
```

Optional, aber Backend-Provider `boarding_data` und `stop_transfer_data`
liefern sonst leer.

---

# 4. `link_speeds` table — leer in beiden Sources ⚠️ wichtig

```
synthetic.link_speeds    → 0 rows
microcensus.link_speeds  → 0 rows  (war OK so, microcensus hat kein Network)
```

Im ursprünglichen Briefing als "optional" markiert — wenn
`link_speeds.parquet` aus der upstream-Stage existiert, sollte es
geladen werden. Hat es offenbar nicht.

**Auswirkung**: `link_speeds.json` und `speed_dashboard.json` Provider
liefern leer (mit Warning).

**Frage an dich**: gibt's einen `link_speeds.parquet` upstream? Falls
ja, in den Build mit aufnehmen. Schema:

```
link_id      VARCHAR
time_bucket  INTEGER  -- z.B. 0..23 hourly oder 0..95 für 15min
speed        DOUBLE   -- m/s
```

Das alte `webmap-backend/scripts/build_link_speeds/` produzierte ein
Format mit mehr Spalten (avg_speed, freespeed, congestion_index, volume,
road_type, canton_id) — die brauchen wir nicht zwingend, das v1-Schema
ist absichtlich minimalistisch und Backend rechnet `congestion_index`
aus `speed/freespeed` selbst. **Aber** wenn diese Spalten leicht zu
liefern sind, gerne mit reinpacken — Backend kann sie dann benutzen
statt rechnen.

---

# 5. Was im synthetic.duckdb funktioniert hat (bitte nicht regressieren)

| Tabelle / Feature | Status |
|---|---|
| synthetic.persons (88,013, alle canton_id, home_pt, n_activities) | ✅ |
| synthetic.activities (371,715, alle mit location_pt, purpose) | ✅ |
| synthetic.trips (296,582, mit origin_pt, dest_pt, mode, purposes) | ✅ |
| synthetic.demo_grid_{100,500,5000}m | ✅ befüllt, 9 age buckets, alle Demographics |
| synthetic.trip_grid_origin_500m | ✅ |
| synthetic.flow_grid_500m (208,394 pairs) | ✅ |
| synthetic.out_of_home_grid_500m | ✅ |
| synthetic.spider_routes / spider_link_index (17M index rows) | ✅ |
| synthetic.network_links / network_nodes (1.7M / 842k) | ✅ |
| hot_polygons (26 cantons + 134 bezirke + 2,162 gemeinden) | ✅ in beiden Sources |
| hot_polygon_trips (für synthetic + microcensus) | ✅ |
| hot_polygon_flows (synthetic) | ✅ |
| Schema-Version `"v1"` in metadata | ✅ |
| BIGINT für alle person_id/trip_index Konsistenz | ✅ |
| EPSG:2056 LV95 Geometrien | ✅ |

→ Bottom line: synthetic.duckdb ist nahezu fertig, nur Punkt 2
(households-Attribute) und Punkt 4 (link_speeds) fehlen. Microcensus
ist zur Hälfte fertig (siehe Sektion 1).

---

# 6. Validation-Checks die du **VOR** dem Liefern laufen lassen solltest

Bitte erweitere dein `validate.py` um diese Checks. Das hätte alle
obigen Issues gefangen. **Wichtig: pro DuckDB-Datei aufrufen**, also
einmal für synthetic, einmal für microcensus.

```python
def validate_v1_data_completeness(db_path, source_type):
    """Run after every build. Asserts on incomplete data so you don't
    ship a half-empty DuckDB."""
    con = duckdb.connect(db_path, read_only=True)
    con.execute("LOAD spatial;")

    # ── universal checks (apply to both sources) ───────────────────

    # 1. Households-Attribute befüllt
    for col in ("income_class", "n_cars_class", "n_bikes_class", "ovgk"):
        n = con.execute(
            f"SELECT COUNT(*) FROM households WHERE {col} IS NOT NULL"
        ).fetchone()[0]
        assert n > 0, f"households.{col} ist überall NULL — Build-Bug"

    # 2. Persons.canton_id befüllt
    n_null = con.execute(
        "SELECT COUNT(*) FROM persons WHERE canton_id IS NULL"
    ).fetchone()[0]
    n_total = con.execute("SELECT COUNT(*) FROM persons").fetchone()[0]
    assert n_null / n_total < 0.05, (
        f"{n_null}/{n_total} persons haben kein canton_id"
    )

    # 3. Sex-Werte normalisiert auf 0/1
    sexes = {
        r[0] for r in con.execute(
            "SELECT DISTINCT sex FROM persons WHERE sex IS NOT NULL"
        ).fetchall()
    }
    assert sexes <= {0, 1}, (
        f"persons.sex enthält Werte außerhalb 0/1: {sexes}"
    )

    # 4. Aktivitäten existieren
    n_act = con.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
    assert n_act > 0, "activities table ist leer"
    n_with_loc = con.execute(
        "SELECT COUNT(*) FROM activities WHERE location_pt IS NOT NULL"
    ).fetchone()[0]
    assert n_with_loc / n_act > 0.95, (
        f"{n_act - n_with_loc} activities ohne location_pt"
    )

    # 5. Demo-Grids gefüllt
    for grid in (
        "demo_grid_100m", "demo_grid_500m", "demo_grid_5000m",
        "trip_grid_origin_500m", "out_of_home_grid_500m",
    ):
        n = con.execute(f"SELECT COUNT(*) FROM {grid}").fetchone()[0]
        assert n > 0, f"{grid} ist leer"

    # 6. Hot-polygon-Aggregate konsistent mit underlying grids
    grid_total = con.execute(
        "SELECT SUM(n_persons) FROM demo_grid_5000m"
    ).fetchone()[0]
    hp_total = con.execute(
        "SELECT SUM(n_persons) FROM hot_polygon_demo"
    ).fetchone()[0]
    assert grid_total > 0 and hp_total > 0
    assert abs(hp_total - grid_total) / grid_total < 0.02, (
        f"hot_polygon_demo SUM ({hp_total}) inconsistent with "
        f"demo_grid_5000m SUM ({grid_total})"
    )

    # 7. Cross-source consistency
    n_persons_meta = con.execute(
        "SELECT person_count FROM metadata"
    ).fetchone()[0]
    n_persons_actual = con.execute(
        "SELECT COUNT(*) FROM persons"
    ).fetchone()[0]
    assert n_persons_meta == n_persons_actual, (
        f"metadata.person_count ({n_persons_meta}) ≠ "
        f"COUNT(persons) ({n_persons_actual})"
    )

    # ── synthetic-only checks ──────────────────────────────────────

    if source_type == "synthetic":
        for grid in ("flow_grid_500m",):
            n = con.execute(f"SELECT COUNT(*) FROM {grid}").fetchone()[0]
            assert n > 0, f"{grid} ist leer"
        for table in ("spider_routes", "spider_link_index",
                      "network_links", "network_nodes"):
            n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            assert n > 0, f"{table} ist leer (synthetic only)"
```

Lass das nach jedem Build über `synthetic.duckdb` UND
`microcensus.duckdb` laufen. Wenn ein Check fehlschlägt → Build ist
invalid, nicht ausliefern.

Zusätzlich: ein **End-to-End-Smoke-Test** mit einem laufenden
webmap-backend (entweder lokal oder im Container) wäre Gold wert. Dafür
gibt's bereits ein Skript unter `webmap-backend/.venv-test/` mit einer
Reihe von Provider-Calls — kann ich dir liefern wenn du's brauchst.

---

# 7. Priorisierung

Falls du nicht alles auf einmal fixen kannst, hier die Reihenfolge nach
User-visibler Auswirkung:

1. **Sektion 1** Microcensus komplett auffüllen (sonst zeigt Backend für
   alle Demographic-Provider keine Microcensus-Spalte mehr)
2. **Sektion 2** households-Attribute (`num_cars` / income-Provider sind
   aktuell komplett unbenutzbar in beiden Sources)
3. **Sektion 4** link_speeds (Link-Speed-Visualisierung im Frontend ist
   unbenutzbar)
4. **Sektion 3** static_assets (PT-Provider liefern leer — kann auch
   Phase 3 sein)

---

# 8. Schema-Vertrag bestätigen

Nochmal zur Sicherheit: schreib in `metadata.schema_version` weiterhin
`"v1"`. Wenn du Felder nachziehst (households, microcensus.canton_id,
etc.), ist das **KEINE** Schema-Änderung — Schema = die DDL aus dem
Original-Briefing, du füllst nur Daten nach.

Falls du wirklich neue Tabellen oder Spalten ergänzen willst (z.B. den
`activity_grid_500m` Pre-Aggregate für `activity_durations`-Performance,
oder zusätzliche Spalten in `link_speeds`), dann:

1. Mit dem User abstimmen
2. `schema_version` auf `"v2"` bumpen
3. Backend muss dann gleichzeitig migriert werden

Für jetzt: **pure Daten-Backfill in v1**.
