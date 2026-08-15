# PGlite durability lab: Windows-friendly task runner mirroring the Makefile.
#
# Requires `just` (https://just.systems) and a POSIX `sh` on PATH — Git for
# Windows (https://git-scm.com/downloads/win) already provides one, so no
# extra install is needed on a normal Windows dev box with Git installed.
#
# `npm run dev` / `npm start` don't work from a native Windows shell: those
# package.json scripts set env vars with `VAR=val cmd`, which only cmd.exe's
# lack of support breaks — npm always launches scripts through cmd.exe on
# Windows regardless of the calling shell. The `local`/`local-volume` recipes
# below sidestep that by invoking `tsx` directly instead of going through
# `npm run dev`.
#
# Usage: just <recipe>, e.g. `just install`, then `just local`.
# Override defaults with environment variables, e.g. `PROFILE=other just validate`.

profile         := env_var_or_default("PROFILE", "ps")
target          := env_var_or_default("TARGET", "dev")
app             := env_var_or_default("APP", "pglite_app")
app_name        := env_var_or_default("APP_NAME", "pglite-durability-lab-dev")
port            := env_var_or_default("PORT", "8000")
uc_catalog      := env_var_or_default("UC_CATALOG", "pglite_app_dev")
uc_schema       := env_var_or_default("UC_SCHEMA", "app")
uc_volume       := env_var_or_default("UC_VOLUME", "snapshots")
data_dir        := env_var_or_default("DATA_DIR", ".data/pglite")
snapshot_dir    := env_var_or_default("SNAPSHOT_DIR", ".data/snapshots")
docker_image    := env_var_or_default("DOCKER_IMAGE", "pglite-databricks-app:local")
container_engine := env_var_or_default("CONTAINER_ENGINE", "podman")

# List available recipes.
default:
    @just --list

# Install locked Node dependencies.
install:
    npm ci --legacy-peer-deps --no-audit --no-fund

# Local PGlite + filesystem snapshots on :{{port}}.
local:
    NODE_ENV=development \
    DATABRICKS_APP_PORT={{port}} \
    PGLITE_DATA_DIR={{data_dir}} \
    SNAPSHOT_MODE=filesystem \
    SNAPSHOT_DIRECTORY={{snapshot_dir}} \
    node_modules/.bin/tsx watch server/server.ts

# Local app using the {{profile}} profile and a UC Volume.
local-volume:
    DATABRICKS_CONFIG_PROFILE={{profile}} \
    NODE_ENV=development \
    DATABRICKS_APP_PORT={{port}} \
    PGLITE_DATA_DIR=.data/pglite-volume \
    SNAPSHOT_MODE=appkit \
    DATABRICKS_VOLUME_FILES=/Volumes/{{uc_catalog}}/{{uc_schema}}/{{uc_volume}} \
    node_modules/.bin/tsx watch server/server.ts

# Build server and React client.
build:
    npm run build

typecheck:
    npm run typecheck

# Run tests, typecheck, and production build.
test:
    npm test
    npm run typecheck
    npm run build

docker-build:
    {{container_engine}} build -t {{docker_image}} .

docker-run:
    mkdir -p .data/docker-snapshots
    {{container_engine}} run --rm \
      -p {{port}}:8000 \
      -v "{{justfile_directory()}}/.data/docker-snapshots:/snapshots" \
      -e ALLOW_LOCAL_IDENTITY=true \
      {{docker_image}}

# Read-only DAB validation (-t {{target}} -p {{profile}}).
validate:
    databricks bundle validate -t {{target}} -p {{profile}}

# The local npm proxy is unreachable from Databricks Apps. Ship a temporary
# public-registry lockfile, then restore the developer lock after deployment.
lock-public:
    test ! -f package-lock.dev-bak || (echo "package-lock.dev-bak already exists"; exit 1)
    cp package-lock.json package-lock.dev-bak
    sed 's#https://npm-proxy.cloud.databricks.com/#https://registry.npmjs.org/#g' package-lock.dev-bak > package-lock.json

lock-restore:
    if [ -f package-lock.dev-bak ]; then \
      mv package-lock.dev-bak package-lock.json; \
      echo "developer package-lock.json restored"; \
    fi

# Build and deploy the bundle.
deploy: test validate
    #!/usr/bin/env sh
    set -eu
    test ! -f package-lock.dev-bak || { echo "package-lock.dev-bak already exists"; exit 1; }
    cp package-lock.json package-lock.dev-bak
    restore_lock() {
      status=$?
      trap - EXIT HUP INT TERM
      if [ -f package-lock.dev-bak ]; then
        mv package-lock.dev-bak package-lock.json
        echo "developer package-lock.json restored"
      fi
      exit $status
    }
    trap restore_lock EXIT HUP INT TERM
    sed 's#https://npm-proxy.cloud.databricks.com/#https://registry.npmjs.org/#g' package-lock.dev-bak > package-lock.json
    databricks bundle deploy -t {{target}} -p {{profile}}

# Start/restart the deployed app resource.
run:
    databricks bundle run {{app}} -t {{target}} -p {{profile}}

deploy-run: deploy
    databricks bundle run {{app}} -t {{target}} -p {{profile}}

# Print the deployed Databricks App URL.
app-url:
    databricks apps get {{app_name}} -p {{profile}} --output json | jq -r .url

# Dry-run; pass confirm=1 to destroy bundle resources, e.g. `just destroy confirm=1`.
destroy confirm="":
    #!/usr/bin/env sh
    set -eu
    if [ -n "{{confirm}}" ] && [ "{{confirm}}" != "1" ]; then
      echo "confirm must be empty or exactly 1" >&2
      exit 1
    fi
    if [ "{{confirm}}" = "1" ]; then
      databricks bundle destroy -t {{target}} -p {{profile}}
    else
      echo "Dry-run only; no resources were changed."
      echo "Would run: databricks bundle destroy -t {{target}} -p {{profile}}"
      echo "Re-run with confirm=1 to execute."
    fi
