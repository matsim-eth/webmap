import os
import csv
import pandas as pd

here = os.path.dirname(os.path.abspath(__file__))


def sniff_delimiter(path, sample_bytes=65536):
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        sample = f.read(sample_bytes)
    try:
        return csv.Sniffer().sniff(sample).delimiter
    except Exception:
        return None


def read_csv_robust(path):
    delim = sniff_delimiter(path)
    tried = []

    def _try(sep):
        tried.append(sep)
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
            return pd.read_csv(f, sep=sep, engine="python")

    if delim:
        df = _try(delim)
        if df.shape[1] > 1:
            return df

    for sep in [",", ";", "\t", "|"]:
        if sep in tried:
            continue
        df = _try(sep)
        if df.shape[1] > 1:
            return df

    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        df = pd.read_csv(f, sep=None, engine="python")
    return df


for name in os.listdir(here):
    if not name.lower().endswith(".csv"):
        continue
    csv_path = os.path.join(here, name)
    parquet_path = os.path.join(here, name[:-4] + ".parquet")
    df = read_csv_robust(csv_path)
    df.to_parquet(parquet_path, engine="fastparquet", index=False)
    print(name, "->", os.path.basename(parquet_path), "rows=", len(df), "cols=", df.shape[1])
    print("columns:", list(df.columns))