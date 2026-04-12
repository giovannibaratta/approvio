#! /usr/bin/env bash

# This script manages the lifecycle of the dependencies for the project.

. "$(dirname "$0")/shared.sh"

readonly DOCKER_PROVIDER="docker"
readonly PODMAN_PROVIDER="podman"
readonly DEFAULT_PROVIDER="${DOCKER_PROVIDER}"
readonly EXTERNAL_DEPS_COMPOSE_FILE="dev-external-deps/docker-compose.yaml"

# Controls output verbosity. When set to 1, standard output of wrapped commands is suppressed.
SILENT=0

function detect_compose_provider() {
  # This function assume that podman-compose wrapper is installed.
  provider=$(docker compose version 2>&1 | \
              grep --only-matching --only-matching \
                   --extended-regexp 'Executing external compose provider "/[[:alnum:]_.-]+(/([[:alnum:]_.-]+))*"' | \
                   cut -d '"' -f 2)

  # If provider is not detected (we assume the wrapper is not in use)
  # and fallback to docker
  if [ -z "$provider" ]; then
    echo "${DEFAULT_PROVIDER}"
    return
  fi

  if [[ "$provider" == *"podman-compose"* ]]; then
    echo "podman"
  else
    echo "${DEFAULT_PROVIDER}"
  fi
}

function generate_provider_specific_flags_for_start() {
  local provider=$1
  local flags=""

  if [ "$provider" == "${DOCKER_PROVIDER}" ]; then
    flags="--wait"
  fi

  echo "$flags"
}

# Determines the profile to use. Defaults to 'dev'.
function profile(){
  local test_arg="$1"
  if [ "${test_arg}" == "test" ]; then
    echo "test"
  else
    echo "dev"
  fi
}

function start(){
  local test_arg="$1"
  local profile_to_start=$(profile "${test_arg}")

  provider=$(detect_compose_provider)
  flags=$(generate_provider_specific_flags_for_start "$provider")

  # If starting the 'test' profile, bring it down first for a clean slate.
  if [ "$profile_to_start" == "test" ]; then
    echo "Bringing down 'test' profile before starting..."
    down "test"
  fi

  run_cmd "Starting services with profile: '${profile_to_start}'" docker compose -f "${EXTERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_start}" up -d ${flags}
}

function stop(){
  local test_arg="$1"
  local profile_to_stop=$(profile "${test_arg}")

  run_cmd "Stopping services with profile: '${profile_to_stop}'" docker compose -f "${EXTERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_stop}" stop
}

function down(){
  local test_arg="$1"
  local profile_to_down=$(profile "${test_arg}")

  run_cmd "Bringing down services and volumes with profile: '${profile_to_down}'" docker compose -f "${EXTERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_down}" down --volumes
}

function rebuild(){
  provider=$(detect_compose_provider)

  if [ ${provider} == ${PODMAN_PROVIDER} ]; then
    stop
  fi

  run_cmd "Rebuilding services" docker ${pre_flags} compose -f "${EXTERNAL_DEPS_COMPOSE_FILE}" --profile dev up -d --build ${flags}
}

function main(){
  local args=()
  for arg in "$@"; do
    if [ "$arg" == "--silent" ]; then
      SILENT=1
    else
      args+=("$arg")
    fi
  done

  if [ ${#args[@]} -eq 0 ]; then
      echo "No arguments provided. Please provide an action (start, stop, down, rebuild)."
      exit 1
  fi

  ACTION=${args[0]}

  # Shift the first element (action) and keep the rest
  local action_args=("${args[@]:1}")

  case $ACTION in
      start)
          start "${action_args[@]}"
          ;;
      stop)
          stop "${action_args[@]}"
          ;;
      down)
          down "${action_args[@]}"
          ;;
      rebuild)
          rebuild "${action_args[@]}"
          ;;
      *)
          echo "Invalid action: $ACTION. Please use start, stop, down, or rebuild."
          exit 1
          ;;
  esac
}

main "$@"