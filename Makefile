# chatgpt-mcp — common ops
# Run `make` or `make help` for targets.

PROJECT_NAME ?= chatgpt-mcp
HANDOFF_DIR  ?= .
HANDOFF_ZIP  ?= $(abspath $(HANDOFF_DIR)/$(PROJECT_NAME)-handoff-$(shell date +%Y%m%d-%H%M%S).zip)

NODE        ?= node
DIST        ?= dist/index.js
LOG_DIR     ?= logs
HTTP_PORT   ?= $(shell grep -E '^HANDOFF_HTTP_PORT=' .env 2>/dev/null | cut -d= -f2)
HTTP_PORT   ?= 8787
REMOTE_PORT ?= $(shell grep -E '^HANDOFF_REMOTE_MCP_PORT=' .env 2>/dev/null | cut -d= -f2)
REMOTE_PORT ?= 8790
HEALTH_URL  ?= http://127.0.0.1:$(HTTP_PORT)

HANDOFF_PATHS := \
	README.md \
	Makefile \
	package.json \
	tsconfig.json \
	.gitignore \
	.env.example \
	AGENTS.md \
	CLAUDE.md \
	src \
	docs \
	cursor \
	scripts \
	.cursor \
	.planning

.DEFAULT_GOAL := help

.PHONY: help install build setup chrome up up-bg down restart status wait-ready \
	check doctor recover recover-clean recover-all clear-tasks clear-task \
	logs worker-bg remote-bg status-api-bg test-leases e2e-1 e2e-20 e2e-dual handoff-zip

help: ## Show targets
	@echo "chatgpt-mcp — quick ops"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
	@echo ""
	@echo "Typical session:"
	@echo "  make install build setup    # once"
	@echo "  make up                     # foreground: CDP + remote-mcp + worker"
	@echo "  make check                  # expect worker READY"
	@echo ""
	@echo "Background:"
	@echo "  make up-bg && make wait-ready && make check"
	@echo "  make clear-tasks            # wipe SQLite queue (ID=ho_… for one)"

install: ## npm install
	npm install

build: ## Compile dist/
	npm run build

setup: ## ~/.chatgpt-mcp + print Cursor MCP JSON
	npm run setup

chrome: ## Start dedicated CDP Chrome (idempotent)
	npm run chrome-cdp

up: build ## Foreground stack: CDP + remote-mcp + worker (Ctrl+C stops services)
	npm run start

up-bg: build ## Background: status-api + browser-worker + remote-mcp
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(REMOTE_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "remote-mcp already on :$(REMOTE_PORT)"; \
	else \
		nohup $(NODE) $(DIST) remote-mcp >> $(LOG_DIR)/remote-mcp.log 2>&1 & \
		echo $$! > $(LOG_DIR)/remote-mcp.pid; \
		echo "remote-mcp → :$(REMOTE_PORT) (pid $$!)"; \
	fi
	@if lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "status-api already on :$(HTTP_PORT)"; \
	else \
		nohup $(NODE) $(DIST) status-api >> $(LOG_DIR)/status-api.log 2>&1 & \
		echo $$! > $(LOG_DIR)/status-api.pid; \
		echo "status-api → :$(HTTP_PORT) (pid $$!)"; \
	fi
	@if [ -f $(LOG_DIR)/browser-worker-supervise.pid ] && kill -0 $$(cat $(LOG_DIR)/browser-worker-supervise.pid) 2>/dev/null; then \
		echo "browser-worker supervise already running (pid $$(cat $(LOG_DIR)/browser-worker-supervise.pid))"; \
	elif [ -f $(LOG_DIR)/browser-worker.pid ] && kill -0 $$(cat $(LOG_DIR)/browser-worker.pid) 2>/dev/null; then \
		echo "browser-worker already running (pid $$(cat $(LOG_DIR)/browser-worker.pid))"; \
	else \
		chmod +x scripts/supervise-browser-worker.sh; \
		nohup bash scripts/supervise-browser-worker.sh >/dev/null 2>&1 & \
		echo $$! > $(LOG_DIR)/browser-worker-supervise.pid; \
		echo "browser-worker supervise → pid $$!"; \
	fi
	@echo "Run: make status && make wait-ready && make check"

down: ## Stop status-api + browser-worker + remote-mcp (Chrome CDP stays up)
	-pkill -f 'supervise-browser-worker.sh' 2>/dev/null || true
	-pkill -f 'node dist/index.js worker' 2>/dev/null || true
	-pkill -f 'node dist/index.js browser-worker' 2>/dev/null || true
	-pkill -f 'node dist/index.js status-api' 2>/dev/null || true
	-pkill -f 'node dist/index.js remote-mcp' 2>/dev/null || true
	-rm -f $(LOG_DIR)/worker.pid $(LOG_DIR)/remote-mcp.pid $(LOG_DIR)/status-api.pid $(LOG_DIR)/browser-worker.pid $(LOG_DIR)/browser-worker-supervise.pid
	@echo "Stopped status-api (:$(HTTP_PORT)), browser-worker, remote-mcp (:$(REMOTE_PORT))."

restart: down up-bg ## Restart background stack (split status-api + browser-worker)

status: ## Health + /workers + listening ports
	@curl -sf $(HEALTH_URL)/health 2>/dev/null && echo "  ← /health" || echo "status-api: DOWN (:$(HTTP_PORT))"
	@curl -sf $(HEALTH_URL)/worker 2>/dev/null || echo "GET /worker failed"
	@curl -sf $(HEALTH_URL)/workers 2>/dev/null || echo "GET /workers failed"
	@echo ""
	@lsof -nP -iTCP:$(HTTP_PORT),$(REMOTE_PORT),9222 -sTCP:LISTEN 2>/dev/null || echo "(no listeners on :$(HTTP_PORT) :$(REMOTE_PORT) :9222)"

doctor: build ## Topology + schema + status-api health
	npm run doctor

test-leases: ## Lease/fencing unit tests (no browser)
	npm run test:leases

e2e-dual: ## Live dual-worker canary (needs 2 CDP + start-dual-stack.sh)
	HANDOFF_WORKERS_FILE=$${HANDOFF_WORKERS_FILE:-$(CURDIR)/data/workers.json} npm run e2e:dual

wait-ready: ## Wait until GET /worker reports READY (120s default)
	@chmod +x scripts/wait-ready.sh
	@./scripts/wait-ready.sh 120

check: ## Preflight Node/build/CDP/worker/remote-mcp
	npm run check

recover: build ## Reset worker_state READY + fail stuck DISPATCHING
	npm run recover

recover-clean: build ## recover + fail all QUEUED (use before a fresh smoke test)
	npm run recover -- --fail-queued

recover-all: build ## Fail all open tasks + reset worker (clean slate before e2e)
	npm run recover -- --fail-queued --fail-open

clear-tasks: ## Delete all SQLite tasks + reset worker READY (ID=ho_… for one)
	npm run recover -- --purge $(if $(ID),--id $(ID))

clear-task: clear-tasks ## Alias of clear-tasks

logs: ## Tail handoff.log
	@tail -f $(LOG_DIR)/handoff.log

worker-bg: build ## Background worker (status-api + one browser; single-worker default)
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "worker/status-api already on :$(HTTP_PORT)"; \
	else \
		nohup $(NODE) $(DIST) worker >> $(LOG_DIR)/worker.log 2>&1 & \
		echo $$! > $(LOG_DIR)/worker.pid; \
		echo "worker pid $$!"; \
	fi

status-api-bg: build ## Background status-api only (HTTP + lease reaper)
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(HTTP_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "status-api already on :$(HTTP_PORT)"; \
	else \
		nohup $(NODE) $(DIST) status-api >> $(LOG_DIR)/status-api.log 2>&1 & \
		echo $$! > $(LOG_DIR)/status-api.pid; \
		echo "status-api pid $$!"; \
	fi

remote-bg: build ## Background remote-mcp only
	@mkdir -p $(LOG_DIR)
	@if lsof -nP -iTCP:$(REMOTE_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "remote-mcp already on :$(REMOTE_PORT)"; \
	else \
		nohup $(NODE) $(DIST) remote-mcp >> $(LOG_DIR)/remote-mcp.log 2>&1 & \
		echo $$! > $(LOG_DIR)/remote-mcp.pid; \
		echo "remote-mcp pid $$!"; \
	fi

e2e-1: ## One live reliability canary
	npm run e2e:reliability -- --runs=1

e2e-20: ## 20 consecutive handoffs (≥18 pass)
	npm run e2e:reliability:20

handoff-zip: ## Zip source for external review (no secrets/node_modules)
	@rm -f "$(HANDOFF_ZIP)"
	@zip -rq "$(HANDOFF_ZIP)" $(HANDOFF_PATHS) \
		-x '*.DS_Store' \
		-x '*/.DS_Store'
	@echo ""
	@ls -lh "$(HANDOFF_ZIP)"
	@echo "Ready: $(HANDOFF_ZIP)"
