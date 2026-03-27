# ── Base: shared dependencies ──────────────────────────────────
FROM ghcr.io/jumpserver/python:3.12.4-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Dev: hot reload, source via bind mount ─────────────────────
FROM base AS dev
EXPOSE 5032
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5032", "--reload"]

# ── Prod: source baked in, multi-worker ────────────────────────
FROM base AS prod
COPY . .
ENV UVICORN_WORKERS=4
EXPOSE 5032
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 5032 --workers ${UVICORN_WORKERS} --proxy-headers --forwarded-allow-ips '*'"]
