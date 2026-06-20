#!/usr/bin/env bash
# Generic load test runner using k6 in a Docker container.
#
# Usage:
#   ./scripts/load-test.sh <config_name_or_path> <scenario_name_or_path>
#
# Examples:
#   ./scripts/load-test.sh smoke workflow-crud
#   ./scripts/load-test.sh load-tests/config/baseline.json load-tests/scripts/scenarios/workflow-crud.ts
#
# Features:
#   - Automatic path resolution (prepends directories and appends extensions if missing)
#   - Alphanumeric, dash, underscore, and slash input validation to prevent command injection/path traversal

SILENT=0
. "$(dirname "$0")/shared.sh"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <config_name> <scenario_name>"
  exit 1
fi

CONFIG=$1
SCENARIO=$2

CLEAN_CONFIG="${CONFIG#load-tests/config/}"
CLEAN_CONFIG="${CLEAN_CONFIG%.json}"
if [[ ! "$CLEAN_CONFIG" =~ ^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$ ]]; then
  echo "Error: Invalid config name. Only alphanumeric, dashes, underscores, and forward slashes allowed."
  exit 1
fi

CLEAN_SCENARIO="${SCENARIO#load-tests/scripts/scenarios/}"
CLEAN_SCENARIO="${CLEAN_SCENARIO%.ts}"
if [[ ! "$CLEAN_SCENARIO" =~ ^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$ ]]; then
  echo "Error: Invalid scenario name. Only alphanumeric, dashes, underscores, and forward slashes allowed."
  exit 1
fi

CONFIG_PATH="load-tests/config/${CLEAN_CONFIG}.json"
SCENARIO_PATH="load-tests/scripts/scenarios/${CLEAN_SCENARIO}.ts"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Error: Config file not found at $CONFIG_PATH"
  exit 1
fi

if [ ! -f "$SCENARIO_PATH" ]; then
  echo "Error: Scenario file not found at $SCENARIO_PATH"
  exit 1
fi

run_cmd "Running load test: $CONFIG_PATH $SCENARIO_PATH" \
  docker run --rm -i --user root --network host -v .:/workspace -w /workspace \
    -e API_URL \
    -e THINK_TIME \
    grafana/k6 run \
    --log-format json \
    --summary-export load-tests/summary.json \
    --config "$CONFIG_PATH" \
    "$SCENARIO_PATH"
