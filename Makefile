# chatgpt-mcp — developer Makefile (internal)
# Public ops UX: gptmcp — run `gptmcp help` or `npx gptmcp help`

PROJECT_NAME ?= chatgpt-mcp
HANDOFF_DIR  ?= .
HANDOFF_ZIP  ?= $(abspath $(HANDOFF_DIR)/$(PROJECT_NAME)-handoff-$(shell date +%Y%m%d-%H%M%S).tar.zst)

NODE        ?= node
DIST        ?= dist/index.js
LOG_DIR     ?= logs
HTTP_PORT   ?= $(shell grep -E '^HANDOFF_HTTP_PORT=' .env 2>/dev/null | cut -d= -f2)
HTTP_PORT   ?= 8787
REMOTE_PORT ?= $(shell grep -E '^HANDOFF_REMOTE_MCP_PORT=' .env 2>/dev/null | cut -d= -f2)
REMOTE_PORT ?= 8790
BROKER_OPS_PORT ?= $(shell grep -E '^HANDOFF_BROKER_OPS_PORT=' .env 2>/dev/null | cut -d= -f2)
BROKER_OPS_PORT ?= 18788
HEALTH_URL  ?= http://127.0.0.1:$(HTTP_PORT)
GPTMCP      ?= npx gptmcp

HANDOFF_PATHS := \
	README.md \
	CONTRIBUTING.md \
	LICENSE \
	Makefile \
	package.json \
	package-lock.json \
	tsconfig.json \
	.gitignore \
	.env.example \
	AGENTS.md \
	CLAUDE.md \
	.github \
	config \
	src \
	docs \
	scripts \
	.cursor \
	.planning

.DEFAULT_GOAL := help

.PHONY: help install install-project build setup test verify \
	gptmcp start stop restart status logs doctor recover open \
	chrome chrome-if-needed up up-bg up-bg-legacy down wait-ready check \
	recover-clean recover-all clear-tasks clear-task \
	worker-bg remote-bg status-api-bg test-leases e2e-1 e2e-20 e2e-dual \
	create-worker rotate-worker dashboard dashboard-up handoff-zip

help: ## Developer targets (public UX: gptmcp)
	@echo "chatgpt-mcp — developer Makefile"
	@echo ""
	@echo "Public ops (preferred):"
	@echo "  gptmcp start | stop | restart | status | logs | doctor | recover | open"
	@echo "  gptmcp worker list | add | rotate …"
	@echo ""
	@echo "Onboarding:"
	@echo "  make install-project    # ./scripts/install.sh"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

install: ## npm install
	npm install

install-project: ## First-run glue (./scripts/install.sh)
	@chmod +x scripts/install.sh
	./scripts/install.sh $(ARGS)

build: ## Compile dist/ (+ gptmcp binary)
	npm run build

setup: ## ~/.chatgpt-mcp + print Cursor MCP JSON
	npm run setup

test: ## Unit tests
	npm run test:unit

verify: ## typecheck + unit + build
	npm run verify

gptmcp: build ## Run gptmcp (pass ARGS='status')
	$(GPTMCP) $(ARGS)

start: build ## [gptmcp] Start broker stack
	$(GPTMCP) start

stop: ## [gptmcp] Stop services
	$(GPTMCP) stop

restart: build ## [gptmcp] Restart broker stack
	$(GPTMCP) restart

status: ## [gptmcp] System health
	$(GPTMCP) status

logs: ## [gptmcp] Structured logs
	$(GPTMCP) logs $(ARGS)

doctor: build ## [gptmcp] Deep diagnostics
	$(GPTMCP) doctor $(ARGS)

recover: build ## [gptmcp] Repair queue/workers
	$(GPTMCP) recover $(ARGS)

open: ## [gptmcp] Open dashboard
	$(GPTMCP) open

chrome: ## Start dedicated CDP Chrome (idempotent)
	npm run chrome-cdp

chrome-if-needed: ## Start CDP Chrome only when :9222 is down (idempotent)
	@curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1 \
		&& echo "CDP already listening on :9222" \
		|| npm run chrome-cdp

up: build chrome-if-needed ## Foreground stack (legacy — prefer gptmcp start)
	npm run start

up-bg: dashboard-up ## Alias for A1-S broker stack

up-bg-legacy: build chrome-if-needed ## Legacy multi-process browser-worker
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(REMOTE_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "remote-mcp already on :$(REMOTE_PORT)"; \
	else \
		nohup $(NODE) $(DIST) remote-mcp >> $(LOG_DIR)/remote-mcp.log 2>&1 & \
		echo $$! > $(LOG_DIR)/remote-mcp.pid; \
		echo "remote-mcp → :$(REMOTE_PORT) (pid $$!)"; \
	fi
	@if [ -f $(LOG_DIR)/status-api-supervise.pid ] && kill -0 $$(cat $(LOG_DIR)/status-api-supervise.pid) 2>/dev/null; then \
		echo "status-api supervise already running"; \
	elif lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "status-api already on :$(HTTP_PORT)"; \
	else \
		chmod +x scripts/supervise-status-api.sh; \
		nohup bash scripts/supervise-status-api.sh >/dev/null 2>&1 & \
		echo $$! > $(LOG_DIR)/status-api-supervise.pid; \
	fi
	@if [ -f $(LOG_DIR)/browser-worker-supervise.pid ] && kill -0 $$(cat $(LOG_DIR)/browser-worker-supervise.pid) 2>/dev/null; then \
		echo "browser-worker supervise already running"; \
	else \
		chmod +x scripts/supervise-browser-worker.sh; \
		nohup bash scripts/supervise-browser-worker.sh >/dev/null 2>&1 & \
		echo $$! > $(LOG_DIR)/browser-worker-supervise.pid; \
	fi
	@echo "Run: gptmcp status"

down: stop ## Alias of gptmcp stop

dashboard: ## Print ops dashboard URL
	@echo "Open http://127.0.0.1:$(HTTP_PORT)/dashboard/"
	@echo "(start: gptmcp start)"

dashboard-up: build chrome-if-needed ## Start A1-S stack for dashboard (supervised status-api + remote-mcp + broker)
	@chmod +x scripts/start-broker-stack.sh
	HANDOFF_WORKERS_FILE=$${HANDOFF_WORKERS_FILE:-$${CHATGPT_MCP_HOME:-$$HOME/.chatgpt-mcp}/data/workers.json} \
		./scripts/start-broker-stack.sh
	@echo ""
	@echo "Open http://127.0.0.1:$(HTTP_PORT)/dashboard/"

test-leases: ## Lease/fencing unit tests
	npm run test:leases

e2e-dual: ## Live dual-worker canary
	HANDOFF_WORKERS_FILE=$${HANDOFF_WORKERS_FILE:-$(CURDIR)/data/workers.json} npm run e2e:dual

create-worker: ## [gptmcp worker add]
	$(GPTMCP) worker add $(ARGS)

rotate-worker: ## [gptmcp worker rotate]
	$(GPTMCP) worker rotate $(ARGS)

wait-ready: ## Internal readiness poll (gptmcp start waits automatically)
	@chmod +x scripts/wait-ready.sh
	@./scripts/wait-ready.sh 120

check: ## Legacy preflight (prefer gptmcp doctor)
	npm run check

recover-clean: build ## gptmcp recover --reset-queue --yes
	$(GPTMCP) recover --reset-queue --yes

recover-all: build ## gptmcp recover --all --yes
	$(GPTMCP) recover --all --yes

clear-tasks: build ## Destructive purge (advanced)
	npm run recover -- --purge $(if $(ID),--id $(ID))

clear-task: clear-tasks ## Alias

worker-bg: build ## Background worker (legacy single-worker)
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "worker/status-api already on :$(HTTP_PORT)"; \
	else \
		nohup $(NODE) $(DIST) worker >> $(LOG_DIR)/worker.log 2>&1 & \
		echo $$! > $(LOG_DIR)/worker.pid; \
	fi

status-api-bg: build ## Background status-api only
	@mkdir -p $(LOG_DIR)
	@if [ -f $(LOG_DIR)/status-api-supervise.pid ] && kill -0 $$(cat $(LOG_DIR)/status-api-supervise.pid) 2>/dev/null; then \
		echo "status-api supervise already running"; \
	elif lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "status-api already on :$(HTTP_PORT)"; \
	else \
		chmod +x scripts/supervise-status-api.sh; \
		nohup bash scripts/supervise-status-api.sh >/dev/null 2>&1 & \
		echo $$! > $(LOG_DIR)/status-api-supervise.pid; \
	fi

remote-bg: build ## Background remote-mcp only
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(REMOTE_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "remote-mcp already on :$(REMOTE_PORT)"; \
	else \
		nohup $(NODE) $(DIST) remote-mcp >> $(LOG_DIR)/remote-mcp.log 2>&1 & \
		echo $$! > $(LOG_DIR)/remote-mcp.pid; \
	fi

e2e-1: ## One live reliability canary
	npm run e2e:reliability -- --runs=1

e2e-20: ## 20 consecutive handoffs
	npm run e2e:reliability:20

handoff-zip: ## Pack source as .tar.zst for external review
	@command -v zstd >/dev/null || { echo "zstd required (e.g. brew install zstd)"; exit 1; }
	@rm -f "$(HANDOFF_ZIP)"
	@COPYFILE_DISABLE=1 tar -cf - \
		--exclude='.DS_Store' \
		$(HANDOFF_PATHS) \
		| zstd -T0 -o "$(HANDOFF_ZIP)"
	@echo ""
	@ls -lh "$(HANDOFF_ZIP)"
	@echo "Ready: $(HANDOFF_ZIP)"
