#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: generate-jit-config.sh \
  --repository OWNER/PRIVATE_REPO \
  --workflow-commit PRIVATE_WORKFLOW_40_HEX_SHA \
  --source-repository OWNER/PUBLIC_SOURCE_REPO \
  --source-ref PUBLIC_SOURCE_BRANCH \
  --source-commit 40_HEX_SHA \
  --memory-class lowmem-8gb|normal-16gb \
  --jit-config-out /secure/path/jit-config.txt \
  --issuance-out /path/jit-issuance.json
EOF
  exit 2
}

repository=''
workflow_commit=''
source_repository=''
source_ref=''
source_commit=''
memory_class=''
jit_config_out=''
issuance_out=''
expected_repository='MathiasHeinke/command-eve-windows-lab'
expected_source_repository='MathiasHeinke/AionUi'

while (($# > 0)); do
  case "$1" in
    --repository) repository="${2:-}"; shift 2 ;;
    --workflow-commit) workflow_commit="${2:-}"; shift 2 ;;
    --source-repository) source_repository="${2:-}"; shift 2 ;;
    --source-ref) source_ref="${2:-}"; shift 2 ;;
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
[[ "$source_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$source_repository" == "$expected_source_repository" ]] || {
  printf 'Refusing source checkout outside the exact public source repository: %s\n' "$source_repository" >&2
  exit 1
}
[[ "$workflow_commit" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$source_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || usage
[[ "$source_ref" != -* && "$source_ref" != /* && "$source_ref" != */ ]] || usage
[[ "$source_ref" != *..* && "$source_ref" != *//* ]] || usage
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$memory_class" == 'lowmem-8gb' || "$memory_class" == 'normal-16gb' ]] || usage
[[ -n "$jit_config_out" && -n "$issuance_out" ]] || usage
[[ ! -e "$jit_config_out" && ! -e "$issuance_out" ]] || {
  printf 'Refusing to overwrite an existing JIT config or issuance receipt.\n' >&2
  exit 1
}

visibility="$(gh api "repos/$repository" --jq '.visibility')"
if [[ "$visibility" != 'private' ]]; then
  printf 'Refusing JIT registration for non-private repository: %s\n' "$repository" >&2
  exit 1
fi
source_visibility="$(gh api "repos/$source_repository" --jq '.visibility')"
if [[ "$source_visibility" != 'public' ]]; then
  printf 'Refusing source checkout from non-public repository: %s\n' "$source_repository" >&2
  exit 1
fi
gh api "repos/$repository/commits/$workflow_commit" --silent >/dev/null
gh api "repos/$source_repository/commits/$source_commit" --silent >/dev/null
source_ref_head="$(gh api "repos/$source_repository/git/ref/heads/$source_ref" --jq '.object.sha')"
if [[ "$source_ref_head" != "$source_commit" ]]; then
  printf 'Refusing JIT registration because source commit is not the exact branch head: %s@%s\n' \
    "$source_repository" "$source_ref" >&2
  exit 1
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_directory" rev-parse --show-toplevel)"
local_head="$(git -C "$repo_root" rev-parse HEAD)"
if [[ "$local_head" != "$source_commit" ]]; then
  printf 'Refusing JIT registration from a local checkout at a different commit: %s\n' "$local_head" >&2
  exit 1
fi
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  printf 'Refusing JIT registration from a dirty local source checkout.\n' >&2
  exit 1
fi

workflow_template="$script_directory/windows-phase-b-lab.workflow.yml"
local_workflow_blob="$(git hash-object "$workflow_template")"
source_workflow_blob="$(gh api \
  "repos/$source_repository/contents/.github/scripts/windows/phase-b/windows-phase-b-lab.workflow.yml?ref=$source_commit" \
  --jq '.sha')"
control_workflow_blob="$(gh api \
  "repos/$repository/contents/.github/workflows/windows-phase-b-lab.yml?ref=$workflow_commit" \
  --jq '.sha')"
if [[ "$source_workflow_blob" != "$local_workflow_blob" || "$control_workflow_blob" != "$local_workflow_blob" ]]; then
  printf 'Refusing JIT registration for public-source/private-control workflow mismatch.\n' >&2
  exit 1
fi

memory_label='phase-b-lowmem'
memory_name='lowmem'
if [[ "$memory_class" == 'normal-16gb' ]]; then
  memory_label='phase-b-normal'
  memory_name='normal'
fi
runner_binding="$(openssl rand -hex 16)"
[[ "$runner_binding" =~ ^[0-9a-f]{32}$ ]] || {
  printf 'Failed to generate the one-run JIT binding.\n' >&2
  exit 1
}
binding_label="ceve-bind-$runner_binding"
runner_name="command-eve-phase-b-${memory_name}-${runner_binding:0:12}"
runner_id=''
issuance_complete=0
jit_temp=''
issuance_temp=''
cleanup() {
  local status=$?
  local revoke_runner_id="$runner_id"
  trap - EXIT
  rm -f "$jit_temp" "$issuance_temp"
  if ((status != 0 && issuance_complete == 0)) && [[ ! "$revoke_runner_id" =~ ^[1-9][0-9]*$ ]]; then
    revoke_runner_id="$(gh api "repos/$repository/actions/runners?per_page=100" 2>/dev/null | \
      jq -r --arg runner_name "$runner_name" '[.runners[] | select(.name == $runner_name) | .id] | first // empty' || true)"
  fi
  if ((status != 0 && issuance_complete == 0)) && [[ "$revoke_runner_id" =~ ^[1-9][0-9]*$ ]]; then
    gh api --method DELETE "repos/$repository/actions/runners/$revoke_runner_id" --silent >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

payload="$(jq -cn \
  --arg name "$runner_name" \
  --arg memory_label "$memory_label" \
  --arg binding_label "$binding_label" \
  '{
    name: $name,
    runner_group_id: 1,
    labels: ["self-hosted", "Windows", "X64", "command-eve-phase-b", $memory_label, $binding_label],
    work_folder: "_work"
  }')"

response="$(gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$repository/actions/runners/generate-jitconfig" \
  --input - <<<"$payload")"
encoded_jit_config="$(jq -er '.encoded_jit_config | select(length >= 80)' <<<"$response")"
runner_id="$(jq -er '.runner.id | select(type == "number" and . > 0)' <<<"$response")"
response_runner_name="$(jq -er '.runner.name' <<<"$response")"
[[ "$response_runner_name" == "$runner_name" ]] || {
  printf 'GitHub returned a JIT runner with an unexpected name.\n' >&2
  exit 1
}
jit_config_sha256="$(printf '%s' "$encoded_jit_config" | shasum -a 256 | awk '{print $1}')"
jit_config_bytes="${#encoded_jit_config}"

umask 077
mkdir -p "$(dirname "$jit_config_out")" "$(dirname "$issuance_out")"
jit_temp="${jit_config_out}.$$"
issuance_temp="${issuance_out}.$$"
printf '%s' "$encoded_jit_config" >"$jit_temp"
chmod 600 "$jit_temp"

jq -n \
  --arg repository "$repository" \
  --arg workflow_commit "$workflow_commit" \
  --arg workflow_template_blob "$local_workflow_blob" \
  --arg source_repository "$source_repository" \
  --arg source_ref "$source_ref" \
  --arg source_commit "$source_commit" \
  --arg memory_class "$memory_class" \
  --arg memory_label "$memory_label" \
  --arg runner_binding "$runner_binding" \
  --arg runner_name "$runner_name" \
  --argjson runner_id "$runner_id" \
  --arg jit_config_sha256 "$jit_config_sha256" \
  --argjson jit_config_bytes "$jit_config_bytes" \
  --arg issued_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    schema_version: "command-eve-windows-phase-b-jit-issuance/v2",
    control_repository: {
      full_name: $repository,
      visibility: "private"
    },
    workflow_commit: $workflow_commit,
    workflow_template_blob: $workflow_template_blob,
    source_repository: {
      full_name: $source_repository,
      visibility: "public"
    },
    source_ref: $source_ref,
    source_commit: $source_commit,
    memory_class: $memory_class,
    memory_label: $memory_label,
    runner_binding: $runner_binding,
    runner_name: $runner_name,
    runner_id: $runner_id,
    jit_config_sha256: $jit_config_sha256,
    jit_config_bytes: $jit_config_bytes,
    credential_delivery: "encoded_jit_config_once",
    issued_at: $issued_at,
    status: "PASS",
    completion_sentinel: "WIN_PHASE_B_JIT_ISSUANCE_COMPLETE"
  }' >"$issuance_temp"
chmod 600 "$issuance_temp"
mv -f "$issuance_temp" "$issuance_out"
if ! mv -f "$jit_temp" "$jit_config_out"; then
  rm -f "$issuance_out"
  exit 1
fi
issuance_complete=1

printf 'WIN_PHASE_B_JIT_CONFIG_READY runner=%s binding=%s issuance=%s\n' \
  "$runner_name" "$runner_binding" "$issuance_out"
