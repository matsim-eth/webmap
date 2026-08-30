# build_transit_volumes

Adds PT passenger link volumes to an **existing** `synthetic.duckdb` — the
data behind the webmap's *Transit Volumes* module, which previously fell
back to the stale GitHub-CDN asset.

What it does:

1. SAX-streams `output_events.xml` (constant memory): tracks every transit
   vehicle (`TransitDriverStarts`), counts passengers on board
   (`PersonEnters/LeavesVehicle`, driver excluded) and accumulates
   occupancy per `(link, line, 15-min bin)` on every `entered link`.
2. Writes table `pt_link_volumes(link_id, line_id, time_bin, volume)` —
   raw sample counts; population scaling happens at serving time.
3. Backfills `network_links.canton_id` for `pt_*` links (spatial join
   against the canton polygons) so per-canton slicing works.

The backend then serves
`/backend/data/{id}/matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_<canton>.json`
from this table (`providers/transit_volumes.py`). Datasets without the
table keep 404ing → the frontend's CDN fallback still applies.

## Run (Euler)

It is a retrofit — run it once per dataset against the duckdb that was
built there (the events file is only needed at build time):

```bash
# webmap-backend/scripts/build_transit_volumes/
sbatch --time=4:00:00 --mem-per-cpu=16G --wrap \
  "python main.py \
     --events /path/to/run/output_events.xml.gz \
     --db     /path/to/synthetic.duckdb"
```

(`.xml` and `.xml.gz` both work. Needs `duckdb` in the environment;
runtime is dominated by streaming the events file once.)

Then copy the updated `synthetic.duckdb` to the server as usual — replacing
the file on disk invalidates all backend caches automatically (the cache
key contains the file's mtime/size signature).

## Verify

```sql
SELECT COUNT(*), COUNT(DISTINCT line_id) FROM pt_link_volumes;
SELECT COUNT(*) FROM network_links
WHERE link_id LIKE 'pt_%' AND canton_id IS NOT NULL;
```

and in the webmap: Transit Volumes module → the network request for
`pt_link_volumes_by_link_line_<canton>.json` should hit
`/backend/data/...` (200) instead of `matsim-eth.github.io`.
