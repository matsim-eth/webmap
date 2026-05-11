# Polygon Viewer

Standalone Leaflet-Map zum Anschauen aller Hot-Polygone (Kantone, Bezirke,
Gemeinden) und zum Zeichnen eigener Polygone, die du danach an die
webmap-API schicken kannst.

## Schnellstart

```sh
# 1. GeoJSON-Files exportieren (einmal pro Dataset)
.venv-test/bin/python tools/polygon_viewer/export.py \
    data/dataset-storage/public/1/synthetic.duckdb \
    tools/polygon_viewer/data/

# 2. Lokal serven (file:// geht meistens auch, aber http ist sicherer wegen CORS)
cd tools/polygon_viewer && python3 -m http.server 8765
# dann im Browser: http://localhost:8765/viewer.html
```

## Was du machen kannst

* Layer ein-/ausblenden: Kantone (rot), Bezirke (blau), Gemeinden (grün)
* Klick auf eine Fläche → zeigt `polygon_id`, `polygon_name`, Beispiel-API-URLs
* Lookup-Feld: Polygon-ID eingeben → zoomt direkt drauf
* **Polygon-Tool oben rechts**: zeichne ein eigenes Polygon. Beim Beenden
  bekommst du die GeoJSON-Repräsentation und URL-encoded Form für den
  `polygon=...` API-Param.

## API-Verwendung

### Hot-Polygon (vordefiniert)

```
GET /data/{dataset_id}/age.json?polygon_id=canton:1
GET /data/{dataset_id}/mode_share.json?polygon_id=gemeinde:261
GET /data/{dataset_id}/zone_flows.json?origin_polygon_id=canton:1&destination_polygon_id=canton:2
```

Mehrere kombinieren:

```
GET /data/{dataset_id}/age.json?polygon_id=canton:1,canton:2,bezirk:101
```

### Eigenes Polygon (beliebige GeoJSON-Geometrie in WGS84)

```
GET /data/{dataset_id}/age.json?polygon=<URL-encoded-GeoJSON>
```

Beispiel mit einem Bbox-Polygon um Zürich:

```
?polygon=%7B%22type%22%3A%22Polygon%22%2C%22coordinates%22%3A%5B%5B%5B8.45%2C47.32%5D%2C%5B8.65%2C47.32%5D%2C%5B8.65%2C47.45%5D%2C%5B8.45%2C47.45%5D%2C%5B8.45%2C47.32%5D%5D%5D%7D
```

Backend reprojiziert WGS84 → LV95 und macht ST_Within-Filtering. Resultate
werden unter dem Label `"Custom"` zurückgegeben.

## Limitierungen

* GET-URL-Längenlimit (~8 KB in den meisten Browsern). Für sehr komplexe
  Polygone mit 1000+ Vertices wäre eine POST-Variante besser — kann ich
  bei Bedarf nachziehen.
* Custom-Polygone gehen NICHT durch die `hot_polygon_*` Pre-Aggregate;
  stattdessen werden die `*_grid_500m` Tabellen mit `ST_Intersects` gegen
  das Polygon gefiltert + summiert. Das ist immer noch fast (~10-150ms) aber
  nicht ganz so instant wie ein Hot-Polygon-Lookup.
* Polygon muss in WGS84 (EPSG:4326) sein. Server reprojiziert intern zu
  LV95.

## Re-Generieren bei neuem Dataset

```sh
.venv-test/bin/python tools/polygon_viewer/export.py \
    <pfad-zu-synthetic.duckdb> \
    tools/polygon_viewer/data/
```

Die GeoJSON-Files werden überschrieben. Die `data/`-Files committen wir
NICHT (sie können aus der DuckDB regeneriert werden).
