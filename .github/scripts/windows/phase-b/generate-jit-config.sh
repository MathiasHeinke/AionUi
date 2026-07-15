#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: generate-jit-config.sh \
  --repository OWNER/PRIVATE_REPO \
  --source-commit 40_HEX_SHA \
  --memory-class lowmem-8gb|normal-16gb \
  --jit-config-out /secure/path/jit-config.txt \
  --issuance-out /path/jit-issuance.json
EOF
  exit 2
}

repository=''
source_commit=''
memory_class=''
jit_config_out=''
issuance_out=''
expected_repository='MathiasHeinke/command-eve-windows-lab'

while (($# > 0)); do
  case "$1" in
    --repository) repository="${2:-}"; shift 2 ;;
    --source-commit) source_commit="${2:-}"; shift 2 ;;
    --memory-class) memory_class="${2:-}"; shift 2 ;;
    --jit-config-out) jit_config_out="${2:-}"; shift 2 ;;
    --issuance-out) issuance_out="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$repository" == "$expected_repository" ]] || {
  printf 'Refusing JIT registration outside the exact private lab mirror: %s\n' "$repository" >&2
  exit 1
}
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$memory_class" == 'lowmem-8gb' || "$memory_class" == 'normal-16gb' ]] || usage
[[ -n "$jit_config_out" && -n "$issuance_out" ]] || usage

visibility="$(gh api "repos/$repository" --jq '.visibility')"
if [[ "$visibility" != 'private' ]]; then
  printf 'Refusing JIT registration for non-private repository: %s\n' "$repository" >&2
  exit 1
fi
gh api "repos/$repository/commits/$source_commit" --silent >/dev/null

memory_label='phase-b-lowmem'
if [[ "$memory_class" == 'normal-16gb' ]]; then memory_label='phase-b-normal'; fi
runner_name="command-eve-${memory_label}-$(date -u +%Y%m%dT%H%M%SZ)-${source_commit:0:8}"

payload="$(jq -cn \
  --arg name "$runner_name" \
  --arg memory_label "$memory_label" \
  '{
    name: $name,
    runner_group_id: 1,
    labels: ["self-hosted", "Windows", "X64", "command-eve-phase-b", $memory_label],
    work_folder: "_work"
  }')"

response="$(gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$repository/actions/runners/generate-jitconfig" \
  --input - <<<"$payload")"
encoded_jit_config="$(jq -er '.encoded_jit_config | select(length >= 80)' <<<"$response")"

umask 077
mkdir -p "$(dirname "$jit_config_out")" "$(dirname "$issuance_out")"
jit_temp="${jit_config_out}.$$"
issuance_temp="${issuance_out}.$$"
trap 'rm -f "$jit_temp" "$issuance_temp"' EXIT
printf '%s' "$encoded_jit_config" >"$jit_temp"
chmod 600 "$jit_temp"
mv -f "$jit_temp" "$jit_config_out"

jq -n \
  --arg repository "$repository" \
  --arg source_commit "$source_commit" \
  --arg memory_class "$memory_class" \
  --arg memory_label "$memory_label" \
  --arg runner_name "$runner_name" \
  --arg issued_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    schema_version: "command-eve-windows-phase-b-jit-issuance/v1",
    repository: {
      full_name: $repository,
      visibility: "private"
    },
    source_commit: $source_commit,
    memory_class: $memory_class,
    memory_label: $memory_label,
    runner_name: $runner_name,
    credential_delivery: "encoded_jit_config_once",
    issued_at: $issued_at,
    status: "PASS",
    completion_sentinel: "WIN_PHASE_B_JIT_ISSUANCE_COMPLETE"
  }' >"$issuance_temp"
chmod 600 "$issuance_temp"
mv -f "$issuance_temp" "$issuance_out"

printf 'WIN_PHASE_B_JIT_CONFIG_READY runner=%s issuance=%s\n' "$runner_name" "$issuance_out"
