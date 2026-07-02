# ── Base: shared dependencies ──────────────────────────────────
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Dev: hot reload, source via bind mount ─────────────────────
FROM base AS dev
EXPOSE 5034
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5034", "--reload"]

# ── Prod: source baked in (single worker is plenty) ────────────
FROM base AS prod
COPY . .
EXPOSE 5034
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5034", "--proxy-headers", "--forwarded-allow-ips", "*"]
