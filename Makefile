# PGlite durability lab: local, Docker, and Databricks App workflows.

PROFILE        ?= ps
TARGET         ?= dev
APP            ?= pglite_app
APP_NAME       ?= pglite-durability-lab-dev
PORT           ?= 8000
UC_CATALOG     ?= pglite_app_dev
UC_SCHEMA      ?= app
UC_VOLUME      ?= snapshots
DATA_DIR       ?= .data/pglite
SNAPSHOT_DIR   ?= .data/snapshots
DOCKER_IMAGE   ?= pglite-databricks-app:local

CONFIRM_VALUE := $(CONFIRM)
ifneq ($(filter destroy,$(MAKECMDGOALS)),)
ifneq ($(CONFIRM_VALUE),)
ifneq ($(CONFIRM_VALUE),1)
$(error CONFIRM must be empty or exactly 1)
endif
endif
endif

.PHONY: help install local local-volume build test typecheck docker-build docker-run validate deploy run deploy-run app-url lock-public lock-restore destroy

help:
	@echo "Targets:"
	@echo "  make install       — install locked Node dependencies"
	@echo "  make local         — local PGlite + filesystem snapshots on :$(PORT)"
	@echo "  make local-volume  — local app using the $(PROFILE) profile and UC Volume"
	@echo "  make build         — build server and React client"
	@echo "  make test          — run tests, typecheck, and production build"
	@echo "  make docker-build  — build $(DOCKER_IMAGE)"
	@echo "  make docker-run    — run the image with a bind-mounted snapshot directory"
	@echo "  make validate      — read-only DAB validation (-t $(TARGET) -p $(PROFILE))"
	@echo "  make deploy        — build and deploy the bundle"
	@echo "  make run           — start/restart the deployed app resource"
	@echo "  make deploy-run    — deploy, then start/restart"
	@echo "  make app-url       — print the deployed Databricks App URL"
	@echo "  make destroy       — dry-run; use CONFIRM=1 to destroy bundle resources"

install:
	npm ci --legacy-peer-deps --no-audit --no-fund

local:
	NODE_ENV=development \
	DATABRICKS_APP_PORT=$(PORT) \
	PGLITE_DATA_DIR=$(DATA_DIR) \
	SNAPSHOT_MODE=filesystem \
	SNAPSHOT_DIRECTORY=$(SNAPSHOT_DIR) \
	npm run dev

local-volume:
	DATABRICKS_CONFIG_PROFILE=$(PROFILE) \
	NODE_ENV=development \
	DATABRICKS_APP_PORT=$(PORT) \
	PGLITE_DATA_DIR=.data/pglite-volume \
	SNAPSHOT_MODE=appkit \
	DATABRICKS_VOLUME_FILES=/Volumes/$(UC_CATALOG)/$(UC_SCHEMA)/$(UC_VOLUME) \
	npm run dev

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test
	npm run typecheck
	npm run build

docker-build:
	docker build -t $(DOCKER_IMAGE) .

docker-run:
	mkdir -p .data/docker-snapshots
	docker run --rm \
	  -p $(PORT):8000 \
	  -v "$(CURDIR)/.data/docker-snapshots:/snapshots" \
	  -e ALLOW_LOCAL_IDENTITY=true \
	  $(DOCKER_IMAGE)

validate:
	databricks bundle validate -t $(TARGET) -p $(PROFILE)

# The local npm proxy is unreachable from Databricks Apps. Ship a temporary
# public-registry lockfile, then restore the developer lock after deployment.
lock-public:
	@test ! -f package-lock.dev-bak || (echo "package-lock.dev-bak already exists"; exit 1)
	cp package-lock.json package-lock.dev-bak
	sed 's#https://npm-proxy.cloud.databricks.com/#https://registry.npmjs.org/#g' package-lock.dev-bak > package-lock.json

lock-restore:
	@if [ -f package-lock.dev-bak ]; then \
	  mv package-lock.dev-bak package-lock.json; \
	  echo "developer package-lock.json restored"; \
	fi

deploy: test validate
	@set -eu; \
	  test ! -f package-lock.dev-bak || { echo "package-lock.dev-bak already exists"; exit 1; }; \
	  cp package-lock.json package-lock.dev-bak; \
	  restore_lock() { \
	    status=$$?; \
	    trap - EXIT HUP INT TERM; \
	    if [ -f package-lock.dev-bak ]; then \
	      mv package-lock.dev-bak package-lock.json; \
	      echo "developer package-lock.json restored"; \
	    fi; \
	    exit $$status; \
	  }; \
	  trap restore_lock EXIT HUP INT TERM; \
	  sed 's#https://npm-proxy.cloud.databricks.com/#https://registry.npmjs.org/#g' package-lock.dev-bak > package-lock.json; \
	  databricks bundle deploy -t $(TARGET) -p $(PROFILE)

run:
	databricks bundle run $(APP) -t $(TARGET) -p $(PROFILE)

deploy-run: deploy
	databricks bundle run $(APP) -t $(TARGET) -p $(PROFILE)

app-url:
	databricks apps get $(APP_NAME) -p $(PROFILE) --output json | jq -r .url

destroy:
ifeq ($(CONFIRM_VALUE),1)
	databricks bundle destroy -t $(TARGET) -p $(PROFILE)
else
	@echo "Dry-run only; no resources were changed."
	@echo "Would run: databricks bundle destroy -t $(TARGET) -p $(PROFILE)"
	@echo "Re-run with CONFIRM=1 to execute."
endif
