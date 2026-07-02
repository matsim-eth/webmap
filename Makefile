# Webmap — common commands. `make help` lists everything.
# Dev stack = local builds + hot reload; prod stack = GHCR images + nginx.

COMPOSE      := docker compose -f docker-compose.yml
COMPOSE_DEV  := $(COMPOSE) -f dev/all.yml
BACKEND      := webmap_backend

.DEFAULT_GOAL := help

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Run ────────────────────────────────────────────────────────────
dev: ## Start the full dev stack (hot reload, vite proxy on :80)
	$(COMPOSE_DEV) up -d --build

prod: ## Start the prod stack (GHCR images, nginx proxy on :80)
	$(COMPOSE) pull && $(COMPOSE) up -d

down: ## Stop everything (dev and prod services)
	$(COMPOSE_DEV) down

restart: ## Restart the webmap backend (after a git pull in dev mode)
	$(COMPOSE_DEV) restart $(BACKEND)

restart-all: ## Restart backend + frontends + proxy (dev)
	$(COMPOSE_DEV) restart $(BACKEND) dashboard_frontend webmap_frontend dev_proxy

# ── Observe ────────────────────────────────────────────────────────
logs: ## Follow webmap backend logs
	$(COMPOSE_DEV) logs -f --no-color $(BACKEND)

logs-all: ## Follow logs of every service
	$(COMPOSE_DEV) logs -f --no-color

ps: ## Show service status
	$(COMPOSE_DEV) ps

# ── Poke around ────────────────────────────────────────────────────
shell: ## Shell inside the webmap backend container
	$(COMPOSE_DEV) exec $(BACKEND) bash

duckdb: ## Python REPL in the backend with duckdb ready (inspect datasets)
	$(COMPOSE_DEV) exec $(BACKEND) python3 -i -c "import duckdb; print('duckdb', duckdb.__version__, '— duckdb.connect(\"/data/datasets/public/1/synthetic.duckdb\", read_only=True)')"

psql-datasets: ## psql into the dataset registry database
	$(COMPOSE_DEV) exec dataset_database psql -U $${DATASET_DB_USER:-dataset_user} $${DATASET_DB_NAME:-datasetdb}

# ── Verify ─────────────────────────────────────────────────────────
check: ## Validate compose files (prod + dev)
	$(COMPOSE) config -q && $(COMPOSE_DEV) config -q && echo "compose OK"

build-frontends: ## Production-build both frontends locally (catches JS errors)
	cd webmap-frontend && npm ci && npx vite build
	cd dashboard-frontend && npm ci && npx vite build

.PHONY: help dev prod down restart restart-all logs logs-all ps shell duckdb psql-datasets check build-frontends
