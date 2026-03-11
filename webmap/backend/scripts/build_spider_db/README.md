# build_spider_db

Builds `spider.duckdb` from raw MATSim source files. This is the **only** preprocessing step needed for spider analysis.

## Input

| File | Description |
|---|---|
| `output_events.xml` | MATSim simulation events (~7 GB) |
| `switzerland_persons.parquet` | Person attributes (age, sex, canton, …) |
| `households.parquet` | Household attributes (income) |

## Output

| File | Description |
|---|---|
| `spider.duckdb` | Self-contained DB for spider analysis |

## Usage

```bash
# Default paths (dummy_data/webmap_data/synthetic/)
python main.py

# Custom paths
python main.py /path/to/events.xml /path/to/persons.parquet /path/to/households.parquet /path/to/spider.duckdb
```

## What it does

1. SAX-streams `output_events.xml` → extracts car trip routes into table `spider_routes`
2. Builds inverted index `spider_link_index` (for fast link lookup)
3. Imports `persons` and `households` tables
4. Creates DB indexes
