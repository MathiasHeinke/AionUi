#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: publish-private-workflow.sh --repository OWNER/REPO --branch BRANCH\n' >&2
  exit 2
}

repository=''
branch=''
expected_repository='MathiasHeinke/command-eve-windows-lab'
while (($# > 0)); do
  case "$1" in
    --repository) repository="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$repository" == "$expected_repository" ]] || {
  printf 'Refusing workflow publication outside the exact private lab mirror: %s\n' "$repository" >&2
  exit 1
}
[[ "$branch" =~ ^[A-Za-z0-9._/-]+$ && "$branch" != -* && "$branch" != *..* ]] || usage

visibility="$(gh api "repos/$repository" --jq '.visibility')"
if [[ "$visibility" != 'private' ]]; then
  printf 'Refusing to publish a self-hosted-runner workflow to non-private repository: %s\n' "$repository" >&2
  exit 1
fi
gh api "repos/$repository/branches/$branch" --silent >/dev/null

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$script_directory/windows-phase-b-lab.workflow.yml"
target='.github/workflows/windows-phase-b-lab.yml'
content="$(base64 <"$template" | tr -d '\n')"
existing_sha="$(gh api "repos/$repository/contents/$target?ref=$branch" --jq '.sha' 2>/dev/null || true)"

arguments=(
  --method PUT
  -H 'Accept: application/vnd.github+json'
  -H 'X-GitHub-Api-Version: 2026-03-10'
  "repos/$repository/contents/$target"
  -f 'message=ci: install private Windows Phase B lab workflow'
  -f "content=$content"
  -f "branch=$branch"
)
if [[ -n "$existing_sha" ]]; then arguments+=( -f "sha=$existing_sha" ); fi

commit_sha="$(gh api "${arguments[@]}" --jq '.commit.sha')"
printf 'WIN_PHASE_B_PRIVATE_WORKFLOW_PUBLISHED repository=%s branch=%s commit=%s\n' \
  "$repository" "$branch" "$commit_sha"
