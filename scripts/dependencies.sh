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

function profile(){
  local test="$1"
  if [ "${test}" == "test" ]; then
    echo "test"
  else
    echo "dev"
  fi
}

function start(){
  test="$1"
  profile=$(profile ${test})

  provider=$(detect_compose_provider)
  flags=$(generate_provider_specific_flags_for_start "$provider")

  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile "${profile}" up -d ${flags}
}

function stop(){
  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile dev --profile test stop
}
function down(){
  docker compose -f "${EXTRERNAL_DEPS_COMPOSE_FILE}" --profile dev --profile test down
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