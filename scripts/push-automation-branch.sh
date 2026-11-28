#!/usr/bin/env bash
set -euo pipefail

# Guided publishing path only. This script is not a security safeguard on its own.
# Anyone who can use the credential directly can bypass the wrapper. Enforce
# branch permissions with GitHub rulesets and keep the credential in the publisher.
readonly remote_url=https://github.com/giovannibaratta/approvio.git

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'Usage: %s automation/<branch> [expected-remote-sha]\n' "${0##*/}" >&2
  exit 2
fi

branch=$1
if [[ ! $branch =~ ^automation/([a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*$ ]] ||
   ! git check-ref-format "refs/heads/$branch"; then
  printf 'Destination must be a valid automation/* branch.\n' >&2
  exit 2
fi

ref="refs/heads/$branch"
opts=(--no-follow-tags --recurse-submodules=no)
if [[ $# -eq 2 ]]; then
  expected=$2
  if [[ ! $expected =~ ^[0-9a-f]{40}$ || $expected == 0000000000000000000000000000000000000000 ]]; then
    printf 'A rewrite requires the full current remote commit SHA.\n' >&2
    exit 2
  fi
  opts+=("--force-with-lease=$ref:$expected")
fi

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Resolve the local branch once so the push uses that exact commit and signature.
commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
exec git -C "$repo" push "${opts[@]}" -- "$remote_url" "$commit:$ref"
