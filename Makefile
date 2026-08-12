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

.PHONY: help handoff-zip

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

handoff-zip: ## Zip source for ChatGPT review (excludes heavy/secret files)
	@rm -f "$(HANDOFF_ZIP)"
	@zip -rq "$(HANDOFF_ZIP)" $(HANDOFF_PATHS) \
		-x '*.DS_Store' \
		-x '*/.DS_Store'
	@echo ""
	@ls -lh "$(HANDOFF_ZIP)"
	@echo "Ready to upload to ChatGPT: $(HANDOFF_ZIP)"
