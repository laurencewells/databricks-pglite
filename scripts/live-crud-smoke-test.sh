#!/usr/bin/env bash

set -euo pipefail

profile="${PROFILE:-ps}"
app_name="${APP_NAME:-pglite-durability-lab-dev}"

for command_name in databricks curl jq; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 1
  fi
done

app_url=$(databricks apps get "${app_name}" -p "${profile}" --output json | jq -er '.url')
access_token=$(databricks auth token -p "${profile}" --output json | jq -er '.access_token')

query() {
  local sql="$1"
  local payload

  payload=$(jq -nc --arg text "${sql}" '{text: $text, values: []}')
  curl \
    --silent \
    --show-error \
    --fail-with-body \
    --max-time 30 \
    --request POST \
    --header "Authorization: Bearer ${access_token}" \
    --header "Content-Type: application/json" \
    --data "${payload}" \
    "${app_url}/api/v1/sql/query"
}

echo "Testing ${app_name} through Databricks profile ${profile}"

query '
  CREATE TABLE IF NOT EXISTS demo_customer (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('"'"'active'"'"', '"'"'pending'"'"')),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
' >/dev/null
echo "CREATE TABLE passed"

insert_result=$(query '
  INSERT INTO demo_customer (id, name, email, status)
  VALUES
    ('"'"'demo-alice'"'"', '"'"'Alice Example'"'"', '"'"'alice@example.test'"'"', '"'"'active'"'"'),
    ('"'"'demo-bob'"'"', '"'"'Bob Example'"'"', '"'"'bob@example.test'"'"', '"'"'pending'"'"'),
    ('"'"'demo-delete'"'"', '"'"'Disposable Customer'"'"', '"'"'delete@example.test'"'"', '"'"'active'"'"')
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    email = EXCLUDED.email,
    status = EXCLUDED.status,
    updated_at = now()
  RETURNING id
')
jq -e '.rowCount == 3 and ([.rows[].id] | sort) == ["demo-alice", "demo-bob", "demo-delete"]' \
  <<<"${insert_result}" >/dev/null
echo "INSERT passed (3 rows)"

select_result=$(query '
  SELECT id, name, email, status
  FROM demo_customer
  WHERE id LIKE '"'"'demo-%'"'"'
  ORDER BY id
')
jq -e '.rowCount == 3 and .rows[0].id == "demo-alice" and .rows[1].id == "demo-bob" and .rows[2].id == "demo-delete"' \
  <<<"${select_result}" >/dev/null
echo "SELECT passed (3 seeded rows found)"

update_result=$(query '
  UPDATE demo_customer
  SET status = '"'"'active'"'"', updated_at = now()
  WHERE id = '"'"'demo-bob'"'"'
  RETURNING id, status
')
jq -e '.rowCount == 1 and .rows == [{"id":"demo-bob","status":"active"}]' \
  <<<"${update_result}" >/dev/null
echo "UPDATE passed (demo-bob is active)"

delete_result=$(query '
  DELETE FROM demo_customer
  WHERE id = '"'"'demo-delete'"'"'
  RETURNING id
')
jq -e '.rowCount == 1 and .rows == [{"id":"demo-delete"}]' \
  <<<"${delete_result}" >/dev/null
echo "DELETE passed (disposable row removed)"

final_result=$(query '
  SELECT id, name, email, status
  FROM demo_customer
  WHERE id LIKE '"'"'demo-%'"'"'
  ORDER BY id
')
jq -e '.rowCount == 2 and .rows[0].id == "demo-alice" and .rows[1].id == "demo-bob" and all(.rows[]; .status == "active")' \
  <<<"${final_result}" >/dev/null
echo "Final SELECT passed (2 persistent active rows)"

checkpoint_result=$(curl \
  --silent \
  --show-error \
  --fail-with-body \
  --max-time 60 \
  --request POST \
  --header "Authorization: Bearer ${access_token}" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "${app_url}/api/checkpoints")
jq -e '.durability.pendingWrites == 0 and .durability.checkpointing == false' \
  <<<"${checkpoint_result}" >/dev/null
echo "CHECKPOINT passed (0 pending writes)"

jq '{rows, rowCount}' <<<"${final_result}"
