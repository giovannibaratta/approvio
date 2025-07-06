#! /usr/bin/env bash

# This script manages the lifecycle of the dependencies for the project.

readonly DOCKER_PROVIDER="docker"
readonly PODMAN_PROVIDER="podman"
readonly DEFAULT_PROVIDER="${DOCKER_PROVIDER}"
readonly EXTRERNAL_DEPS_COMPOSE_FILE="dev-external-deps/docker-compose.yaml"

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

  echo "Starting services with profile: '${profile_to_start}'..."
  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_start}" up -d ${flags}
}

function stop(){
  local test_arg="$1"
  local profile_to_stop=$(profile "${test_arg}")

  echo "Stopping services with profile: '${profile_to_stop}'..."
  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_stop}" stop
}

function down(){
  local test_arg="$1"
  local profile_to_down=$(profile "${test_arg}")

  echo "Bringing down services and volumes with profile: '${profile_to_down}'..."
  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile "${profile_to_down}" down --volumes
}

function rebuild(){
  provider=$(detect_compose_provider)

  if [ ${provider} == ${PODMAN_PROVIDER} ]; then
    stop
  fi

  docker ${pre_flags} compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile dev up -d --build ${flags}
}

function main(){
  if [ $# -eq 0 ]; then
      echo "No arguments provided. Please provide an action (start, stop, down, rebuild)."
      exit 1
  fi

  ACTION=$1

  shift # Remove the first argument (action) from the list of arguments

  case $ACTION in
      start)
          start "$@"
          ;;
      stop)
          stop "$@"
          ;;
      down)
          down "$@"
          ;;
      rebuild)
          rebuild "$@"
          ;;
      *)
          echo "Invalid action: $ACTION. Please use start, stop, down, or rebuild."
          exit 1
          ;;
  esac
}

main "$@"