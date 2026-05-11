# Webmap — Docker & Test Cheat Sheet

Alles ab hier mit `cwd = /Users/rares/PycharmProjects/webmap`.

---

## Docker Stack

| Aktion | Befehl |
|---|---|
| Stack hochfahren (dev) | `docker compose -f docker-compose.yml -f dev/all.yml up -d` |
| Stack runterfahren | `docker compose -f docker-compose.yml -f dev/all.yml down` |
| Status aller Services | `docker compose ps` |
| Backend neu starten (nach Code-Änderung greift Hot-Reload normalerweise; nur wenn der nicht zieht) | `docker compose restart webmap_backend` |
| Logs **live folgen** (Backend) | `docker compose logs -f webmap_backend` |
| Letzte 50 Zeilen | `docker compose logs --tail 50 webmap_backend` |
| Logs aller Services live | `docker compose logs -f` |
| Hard-Restart einzelner Service | `docker compose stop webmap_backend && docker compose up -d webmap_backend` |
| Image neu bauen + restart (z.B. nach `requirements.txt`-Änderung) | `docker compose -f docker-compose.yml -f dev/all.yml up -d --build webmap_backend` |
| In Container reinshellen | `docker compose exec webmap_backend bash` |
| Volle Bereinigung (auch DB-Volumes!) ⚠️ destruktiv | `docker compose down -v` |

**Welche Services laufen:**
```sh
docker compose ps
```
Erwartete Liste: `proxy` (oder `dev_proxy`), `webmap_backend`, `webmap_frontend`,
`dashboard_frontend`, `dataset_backend`, `authentification_backend`,
`authentification_frontend`, `auth_database`, `dataset_database`.

---

## Polygon-Viewer

```sh
# Einmalig: GeoJSON exportieren (oder neu wenn Dataset wechselt)
.venv-test/bin/python tools/polygon_viewer/export.py \
    data/dataset-storage/public/1/synthetic.duckdb \
    tools/polygon_viewer/data/

# Server starten
cd tools/polygon_viewer && python3 -m http.server 8765
# → http://localhost:8765/viewer.html
```

---

## Backend direkt testen (ohne Auth)

Ein Test-Venv liegt unter `webmap-backend/.venv-test/`. Die Provider-Klassen
lassen sich direkt aufrufen — ohne Docker, ohne Auth, ohne Frontend.

### One-Liner (in der Shell)

```sh
cd /Users/rares/PycharmProjects/webmap/webmap-backend && \
WEBMAP_ROOT=/Users/rares/PycharmProjects/webmap/data/dataset-storage/public/1 \
.venv-test/bin/python3 -c "
import providers as P, json
print(json.dumps(P.AgeProvider().deliver({'canton': 'Zurich'}), indent=2))
"
```

### Python-Snippets — copy/paste in eine Datei oder REPL

```python
import os, json, time
os.environ['WEBMAP_ROOT'] = '/Users/rares/PycharmProjects/webmap/data/dataset-storage/public/1'
import sys; sys.path.insert(0, '/Users/rares/PycharmProjects/webmap/webmap-backend')
import providers as P

# A) Hot-polygon: Kanton Zürich
P.AgeProvider().deliver({'canton': 'Zurich'})
P.ModeShareProvider().deliver({'polygon_id': 'canton:1'})

# B) Mehrere Kantone
P.AgeProvider().deliver({'polygon_id': 'canton:1,canton:2'})

# C) Bezirk / Gemeinde
P.AgeProvider().deliver({'polygon_id': 'gemeinde:261'})  # = Stadt Zürich

# D) Eigenes Polygon (WGS84)
my_polygon = {
    "type": "Polygon",
    "coordinates": [[[8.50, 47.36], [8.58, 47.36], [8.58, 47.42], [8.50, 47.42], [8.50, 47.36]]]
}
P.AgeProvider().deliver({'polygon': json.dumps(my_polygon)})

# E) Performance messen
t0 = time.time()
P.ModeShareProvider().deliver({'canton': 'Zurich'})
print(f"{(time.time()-t0)*1000:.0f}ms")

# F) Alle 28 Provider auf einmal smoke-testen
exec(open('/tmp/smoke_test.py').read())
```

### Smoke-Test-Skript

Liegt unter `/tmp/smoke_test.py`. Ruft jeden der 28 Provider mit leeren
Params auf, misst die Dauer, zeigt OK / ERROR / EMPTY.

```sh
cd webmap-backend && .venv-test/bin/python3 /tmp/smoke_test.py
```

Ein Lauf dauert ~7s gegen das Sample-Dataset.

---

## Sanity-Checks gegen alte Daten

Die alten Parquets/XMLs liegen unter `data/junk/dataset-storage/public/1/`.
Vergleichs-Snippet (Personen-Counts, Canton-Mappings, Mode-Shares):

```sh
cd webmap-backend && .venv-test/bin/python3 << 'PY'
import duckdb
JUNK = "/Users/rares/PycharmProjects/webmap/data/junk/dataset-storage/public/1"
NEW  = "/Users/rares/PycharmProjects/webmap/data/dataset-storage/public/1"
old = duckdb.connect(":memory:")
new = duckdb.connect(f"{NEW}/synthetic.duckdb", read_only=True)
new.execute("LOAD spatial;")
print("Old persons:", old.execute(f"SELECT COUNT(*) FROM read_parquet('{JUNK}/synthetic/switzerland_persons.parquet')").fetchone()[0])
print("New persons:", new.execute("SELECT COUNT(*) FROM persons").fetchone()[0])
PY
```

---

## curl gegen die laufende API (mit Auth)

### Dev-Account

In `/Users/rares/PycharmProjects/webmap/.env`:
```
DEV_EMAIL=dev@local
DEV_PASSWORD=dev
DEV_MODE=1
```

Wird beim Start des Auth-Backends automatisch geseedet.

### Login + Cookie speichern

```sh
curl -s -X POST http://localhost/authentification/backend/login \
     -H "Content-Type: application/json" \
     -d '{"email":"dev@local","password":"dev"}' \
     -c /tmp/wm_cookies.txt > /dev/null
```

Token gilt 24h (`ACCESS_TOKEN_MINUTES=1440`).

### API-Request mit Cookie

```sh
curl -s "http://localhost/backend/data/1/age.json?canton=Zurich" \
     -b /tmp/wm_cookies.txt | jq .
```

Mit eigenem Polygon:

```sh
POLY='{"type":"Polygon","coordinates":[[[8.45,47.32],[8.65,47.32],[8.65,47.45],[8.45,47.45],[8.45,47.32]]]}'
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$POLY")
curl -s "http://localhost/backend/data/1/age.json?polygon=$ENC" \
     -b /tmp/wm_cookies.txt | jq .
```

### Bash-Aliases (optional, in `~/.zshrc`)

```sh
wm_login() {
  curl -s -X POST http://localhost/authentification/backend/login \
       -H "Content-Type: application/json" \
       -d '{"email":"dev@local","password":"dev"}' \
       -c /tmp/wm_cookies.txt > /dev/null
  echo "logged in (cookies → /tmp/wm_cookies.txt)"
}

wm() {
  curl -s "http://localhost/backend$1" -b /tmp/wm_cookies.txt | jq .
}
```

Dann:
```sh
wm_login
wm /data/1/age.json?canton=Zurich
wm /data/1/mode_share.json?polygon_id=gemeinde:261
```

---

## Häufige Fehler

| Symptom | Ursache | Fix |
|---|---|---|
| `Not authenticated` | Auth-Cookie fehlt im curl | Cookie aus Browser kopieren oder Python-Direct-Path nutzen (siehe oben) |
| `synthetic dataset not available` | DuckDB-File fehlt im Dataset-Ordner | `ls data/dataset-storage/public/1/` checken |
| Backend startet, antwortet aber 500 | Schema-Drift (DB hat alte Tabellen) | Frischen Build laden, `metadata.schema_version = "v1"` checken |
| `link_speeds table is empty` Warnung | v1-Schema hat das Feld leer gelassen | bekannt, siehe MIGRATION_NOTES.md |
| Microcensus-Demographics leer | Pipeline hat Microcensus-Demographics nicht gebaut | siehe MIGRATION_NOTES.md, Pipeline-Rerun nötig |

---

## Bekannte Latenz-Profile (Sample 88k persons)

| Provider | Single-Polygon | All 26 Cantons |
|---|---|---|
| age, gender, mode_share, … | 1-15ms | 7-150ms |
| histogram, lineplot, frequent_seq | 40-220ms | 200-300ms |
| activity_durations | 700ms | 5.9s |

---

## Schneller Smoke-Browser-Test

1. Backend läuft (`docker compose ps webmap_backend` zeigt `running`)
2. Browser → `http://localhost/` (oder dein lokaler Hostname)
3. Login → ein Dataset wählen → Map sollte laden
4. `docker compose logs -f webmap_backend` parallel laufen lassen → siehst die Requests live
