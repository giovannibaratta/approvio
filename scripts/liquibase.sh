#! /usr/bin/env bash

. "$(dirname "$0")/shared.sh"

# Control the verbosity of the output
# When set to 1, standard output of wrapped commands is suppressed
SILENT=0

LIQUIBASE_VERSION="4.31.1"

CONTAINER_ROOT="/liquibase/changelog"
DEV_LIQUIBASE_PROPERTIES="${CONTAINER_ROOT}/liquibase.docker.properties"
TEST_LIQUIBASE_PROPERTIES="${CONTAINER_ROOT}/integration-test.liquibase.docker.properties"

ARGS=()

for arg in "$@"; do
  if [ "$arg" == "--silent" ]; then
    SILENT=1
  else
    ARGS+=("$arg")
  fi
done

if [ ${#ARGS[@]} -eq 0 ]; then
    echo "No arguments provided for liquibase."
    exit 1
fi

function update() {
    local profile=$1
    local properties_file=""

    if [ "$profile" == "dev" ]; then
        properties_file="${DEV_LIQUIBASE_PROPERTIES}"
    elif [ "$profile" == "test" ]; then
        properties_file="${TEST_LIQUIBASE_PROPERTIES}"
    else
        echo "Invalid profile: $profile. Please use 'dev' or 'test'."
        exit 1
    fi

    run_cmd "Migrating DB with Liquibase ${profile} profile" docker run --network host --rm -v ./db-migrations:/liquibase/changelog liquibase/liquibase:${LIQUIBASE_VERSION} --defaultsFile="${properties_file}" update
}

ACTION=${ARGS[0]}

case $ACTION in
    update)
        update "${ARGS[1]}"
        ;;
    *)
        echo "Action $ACTION not supported by this wrapper yet."
        exit 1
        ;;
esac