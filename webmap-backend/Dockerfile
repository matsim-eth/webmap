# ── Base: shared dependencies ──────────────────────────────────
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && python -c "import duckdb; duckdb.connect().execute('INSTALL spatial')"

# ── Dev: hot reload, source via bind mount ─────────────────────
FROM base AS dev
EXPOSE 5031
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5031", "--reload"]

# ── Prod: source baked in, multi-worker ────────────────────────
FROM base AS prod
COPY . .
ENV UVICORN_WORKERS=4
EXPOSE 5031
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 5031 --workers ${UVICORN_WORKERS} --proxy-headers --forwarded-allow-ips '*'"]
