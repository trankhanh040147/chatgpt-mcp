# Cursor ↔ ChatGPT Handoff
PROJECT_NAME ?= chatgpt-mcp
HANDOFF_DIR  ?= .
HANDOFF_ZIP  ?= $(abspath $(HANDOFF_DIR)/$(PROJECT_NAME)-handoff-$(shell date +%Y%m%d-%H%M%S).zip)

# Source + docs only — skips node_modules, dist, data, logs, .git, secrets
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

.PHONY: help handoff-zip e2e-1 e2e-20 setup check

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup: ## Create ~/.chatgpt-mcp and print Cursor MCP JSON
	npm run setup

check: ## Preflight Node/build/CDP/worker/remote-mcp
	npm run check

e2e-1: ## One live reliability canary (needs worker + CDP + remote MCP)
	npm run e2e:reliability -- --runs=1

e2e-20: ## Spec §37 gate: 20 consecutive handoffs (≥18 pass)
	npm run e2e:reliability:20

handoff-zip: ## Zip source for ChatGPT review (excludes heavy/secret files)
	@rm -f "$(HANDOFF_ZIP)"
	@zip -rq "$(HANDOFF_ZIP)" $(HANDOFF_PATHS) \
		-x '*.DS_Store' \
		-x '*/.DS_Store'
	@echo ""
	@ls -lh "$(HANDOFF_ZIP)"
	@echo "Ready to upload to ChatGPT: $(HANDOFF_ZIP)"
