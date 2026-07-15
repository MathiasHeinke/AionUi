#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: dispatch-private-workflow.sh \
  --issuance /secure/path/jit-issuance.json \
  --jit-config /secure/path/jit-config.txt \
  --receipt-out /secure/path/dispatch-receipt.json \
  --evidence-out-dir /secure/path/evidence \
  [--poll-timeout-seconds 300] \
  [--run-timeout-seconds 15000]
EOF
  exit 2
}

issuance_path=''
jit_config_path=''
receipt_out=''
evidence_out_dir=''
poll_timeout_seconds=300
run_timeout_seconds=15000
expected_control_repository='MathiasHeinke/command-eve-windows-lab'
expected_source_repository='MathiasHeinke/AionUi'
workflow_file='windows-phase-b-lab.yml'
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while (($# > 0)); do
  case "$1" in
    --issuance) issuance_path="${2:-}"; shift 2 ;;
    --jit-config) jit_config_path="${2:-}"; shift 2 ;;
    --receipt-out) receipt_out="${2:-}"; shift 2 ;;
    --evidence-out-dir) evidence_out_dir="${2:-}"; shift 2 ;;
    --poll-timeout-seconds) poll_timeout_seconds="${2:-}"; shift 2 ;;
    --run-timeout-seconds) run_timeout_seconds="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$issuance_path" && -n "$jit_config_path" && -n "$receipt_out" && -n "$evidence_out_dir" ]] || usage
[[ ! -e "$receipt_out" ]] || {
  printf 'Refusing to overwrite an existing dispatch receipt: %s\n' "$receipt_out" >&2
  exit 1
}
[[ "$poll_timeout_seconds" =~ ^[1-9][0-9]*$ && "$poll_timeout_seconds" -le 600 ]] || usage
[[ "$run_timeout_seconds" =~ ^[1-9][0-9]*$ && "$run_timeout_seconds" -le 21600 ]] || usage

control_repository="$(jq -r '.control_repository.full_name // empty' "$issuance_path")"
workflow_commit="$(jq -r '.workflow_commit // empty' "$issuance_path")"
workflow_template_blob="$(jq -r '.workflow_template_blob // empty' "$issuance_path")"
source_repository="$(jq -r '.source_repository.full_name // empty' "$issuance_path")"
source_ref="$(jq -r '.source_ref // empty' "$issuance_path")"
source_commit="$(jq -r '.source_commit // empty' "$issuance_path")"
memory_class="$(jq -r '.memory_class // empty' "$issuance_path")"
memory_label="$(jq -r '.memory_label // empty' "$issuance_path")"
runner_binding="$(jq -r '.runner_binding // empty' "$issuance_path")"
runner_name="$(jq -r '.runner_name // empty' "$issuance_path")"
runner_id="$(jq -r '.runner_id // empty' "$issuance_path")"
jit_config_sha256="$(jq -r '.jit_config_sha256 // empty' "$issuance_path")"
jit_config_bytes="$(jq -r '.jit_config_bytes // empty' "$issuance_path")"

issued_runner_identity_matches() {
  local runner_json="$1" safe_memory_name safe_memory_label expected_runner_name
  [[ "$control_repository" == "$expected_control_repository" ]] || return 1
  [[ "$runner_binding" =~ ^[0-9a-f]{32}$ && "$runner_id" =~ ^[1-9][0-9]*$ ]] || return 1
  case "$memory_class" in
    lowmem-8gb) safe_memory_name='lowmem'; safe_memory_label='phase-b-lowmem' ;;
    normal-16gb) safe_memory_name='normal'; safe_memory_label='phase-b-normal' ;;
    *) return 1 ;;
  esac
  expected_runner_name="command-eve-phase-b-${safe_memory_name}-${runner_binding:0:12}"
  [[ "$runner_name" == "$expected_runner_name" ]] || return 1
  jq -e \
    --arg runner_name "$runner_name" \
    --arg memory_label "$safe_memory_label" \
    --arg binding_label "ceve-bind-$runner_binding" \
    '.name == $runner_name and
      ([.labels[]?.name] | index("command-eve-phase-b")) != null and
      ([.labels[]?.name] | index($memory_label)) != null and
      ([.labels[]?.name] | index($binding_label)) != null' \
    <<<"$runner_json" >/dev/null
}

revoke_issued_runner() {
  local runner_json
  [[ "$control_repository" == "$expected_control_repository" ]] || return 0
  [[ "$runner_id" =~ ^[1-9][0-9]*$ ]] || return 0
  runner_json="$(gh api "repos/$control_repository/actions/runners/$runner_id" 2>/dev/null)" || return 0
  issued_runner_identity_matches "$runner_json" || return 0
  gh api --method DELETE "repos/$control_repository/actions/runners/$runner_id" --silent >/dev/null 2>&1 || true
}

pre_dispatch_cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -f "$jit_config_path" && ! -L "$jit_config_path" ]]; then
    rm -f "$jit_config_path" || true
  fi
  if ((status != 0)); then
    revoke_issued_runner
  fi
  exit "$status"
}
trap pre_dispatch_cleanup EXIT
trap 'exit 130' HUP INT TERM

jq -e '
  .schema_version == "command-eve-windows-phase-b-jit-issuance/v2" and
  .control_repository.visibility == "private" and
  .source_repository.visibility == "public" and
  .credential_delivery == "encoded_jit_config_once" and
  .status == "PASS" and
  .completion_sentinel == "WIN_PHASE_B_JIT_ISSUANCE_COMPLETE"
' "$issuance_path" >/dev/null

[[ "$control_repository" == "$expected_control_repository" ]] || usage
[[ "$source_repository" == "$expected_source_repository" ]] || usage
[[ "$workflow_commit" =~ ^[0-9a-f]{40}$ && "$source_commit" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$workflow_template_blob" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$source_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || usage
[[ "$source_ref" != -* && "$source_ref" != /* && "$source_ref" != */ ]] || usage
[[ "$source_ref" != *..* && "$source_ref" != *//* ]] || usage
[[ "$runner_binding" =~ ^[0-9a-f]{32}$ ]] || usage
[[ "$runner_id" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$jit_config_sha256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$jit_config_bytes" =~ ^[1-9][0-9]*$ && "$jit_config_bytes" -ge 80 ]] || usage
[[ "$memory_class" == 'lowmem-8gb' || "$memory_class" == 'normal-16gb' ]] || usage

memory_name='lowmem'
expected_memory_label='phase-b-lowmem'
if [[ "$memory_class" == 'normal-16gb' ]]; then
  memory_name='normal'
  expected_memory_label='phase-b-normal'
fi
[[ "$memory_label" == "$expected_memory_label" ]] || usage
[[ "$runner_name" == "command-eve-phase-b-${memory_name}-${runner_binding:0:12}" ]] || usage

reject_dead_jit_config() {
  printf 'Refusing dispatch because the issued one-use JIT config is missing, changed, or not mode 0600.\n' >&2
  exit 1
}

[[ -f "$jit_config_path" && ! -L "$jit_config_path" ]] || reject_dead_jit_config
if ! jit_config_mode="$(stat -f '%Lp' "$jit_config_path" 2>/dev/null)"; then
  jit_config_mode="$(stat -c '%a' "$jit_config_path" 2>/dev/null || true)"
fi
[[ "$jit_config_mode" == '600' ]] || reject_dead_jit_config
actual_jit_config_bytes="$(wc -c <"$jit_config_path" | tr -d '[:space:]')"
actual_jit_config_sha256="$(shasum -a 256 "$jit_config_path" | awk '{print $1}')"
[[ "$actual_jit_config_bytes" == "$jit_config_bytes" ]] || reject_dead_jit_config
[[ "$actual_jit_config_sha256" == "$jit_config_sha256" ]] || reject_dead_jit_config

[[ "$(gh api "repos/$control_repository" --jq '.visibility')" == 'private' ]] || {
  printf 'Refusing dispatch because the control repository is not private.\n' >&2
  exit 1
}
[[ "$(gh api "repos/$source_repository" --jq '.visibility')" == 'public' ]] || {
  printf 'Refusing dispatch because the source repository is not public.\n' >&2
  exit 1
}
runner_ready=0
runner_deadline=$((SECONDS + poll_timeout_seconds))
while ((SECONDS < runner_deadline)); do
  if registered_runner="$(gh api "repos/$control_repository/actions/runners/$runner_id" 2>/dev/null)"; then
    issued_runner_identity_matches "$registered_runner" || {
      printf 'Refusing dispatch because the issued GitHub runner identity or labels do not match.\n' >&2
      exit 1
    }
    registered_runner_status="$(jq -er '.status' <<<"$registered_runner")"
    registered_runner_busy="$(jq -er '.busy' <<<"$registered_runner")"
    if [[ "$registered_runner_status" == 'online' && "$registered_runner_busy" == 'false' ]]; then
      runner_ready=1
      break
    fi
  fi
  printf 'Phase B JIT runner heartbeat: waiting for runner_id=%s name=%s to become online and idle.\n' \
    "$runner_id" "$runner_name"
  sleep 5
done
[[ "$runner_ready" == '1' ]] || {
  printf 'Refusing dispatch because the issued GitHub runner did not become online and idle.\n' >&2
  exit 1
}

source_ref_head="$(gh api "repos/$source_repository/git/ref/heads/$source_ref" --jq '.object.sha')"
[[ "$source_ref_head" == "$source_commit" ]] || {
  printf 'Refusing dispatch because the public source branch moved after JIT issuance.\n' >&2
  exit 1
}
control_workflow_blob="$(gh api \
  "repos/$control_repository/contents/.github/workflows/$workflow_file?ref=$workflow_commit" \
  --jq '.sha')"
source_workflow_blob="$(gh api \
  "repos/$source_repository/contents/.github/scripts/windows/phase-b/windows-phase-b-lab.workflow.yml?ref=$source_commit" \
  --jq '.sha')"
[[ "$control_workflow_blob" == "$workflow_template_blob" && "$source_workflow_blob" == "$workflow_template_blob" ]] || {
  printf 'Refusing dispatch because the public-source/private-control workflow binding drifted.\n' >&2
  exit 1
}

active_runs="$(gh api \
  "repos/$control_repository/actions/workflows/$workflow_file/runs?event=workflow_dispatch&per_page=100")"
active_run_count="$(jq -r \
  --arg display_prefix "Command EVE Phase B $memory_class " \
  '[.workflow_runs[] | select(
    .status != "completed" and
    (.display_title | startswith($display_prefix))
  )] | length' <<<"$active_runs")"
[[ "$active_run_count" == '0' ]] || {
  printf 'Refusing dispatch while another Phase B workflow run is active for %s.\n' "$memory_class" >&2
  exit 1
}

tag_name="command-eve-phase-b-$runner_binding"
tag_ref="refs/tags/$tag_name"
if gh api "repos/$control_repository/git/ref/tags/$tag_name" --silent >/dev/null 2>&1; then
  printf 'Refusing to reuse an existing Phase B workflow tag: %s\n' "$tag_name" >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$receipt_out")"
receipt_temp="${receipt_out}.$$"
tag_created=0
dispatch_submitted=0
run_id=''
run_completed=0

cancel_bound_runs() {
  local candidate_runs pending_id
  if [[ "$run_id" =~ ^[1-9][0-9]*$ ]]; then
    gh api --method POST "repos/$control_repository/actions/runs/$run_id/cancel" --silent >/dev/null 2>&1 || true
    return
  fi
  candidate_runs="$(gh api \
    "repos/$control_repository/actions/workflows/$workflow_file/runs?event=workflow_dispatch&per_page=100" \
    2>/dev/null || true)"
  while IFS= read -r pending_id; do
    [[ "$pending_id" =~ ^[1-9][0-9]*$ ]] || continue
    gh api --method POST "repos/$control_repository/actions/runs/$pending_id/cancel" --silent >/dev/null 2>&1 || true
  done < <(jq -r \
    --arg workflow_commit "$workflow_commit" \
    --arg tag_name "$tag_name" \
    '.workflow_runs[]? | select(
      .head_sha == $workflow_commit and
      .head_branch == $tag_name and
      .status != "completed"
    ) | .id' <<<"$candidate_runs" 2>/dev/null || true)
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  rm -f "$receipt_temp" "$jit_config_path"
  if ((status != 0 && dispatch_submitted == 1 && run_completed == 0)); then
    cancel_bound_runs
  fi
  if ((status != 0)); then
    revoke_issued_runner
  fi
  if ((status != 0 && tag_created == 1 && dispatch_submitted == 0)); then
    gh api --method DELETE "repos/$control_repository/git/refs/tags/$tag_name" --silent >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

jq -cn --arg ref "$tag_ref" --arg sha "$workflow_commit" '{ref: $ref, sha: $sha}' | \
  gh api \
    --method POST \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/$control_repository/git/refs" \
    --input - \
    --silent >/dev/null
tag_created=1
tag_target="$(gh api "repos/$control_repository/git/ref/tags/$tag_name" --jq '.object.sha')"
[[ "$tag_target" == "$workflow_commit" ]] || {
  printf 'Created workflow tag does not target the issued workflow commit.\n' >&2
  exit 1
}

dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dispatch_payload="$(jq -cn \
  --arg ref "$tag_name" \
  --arg workflow_commit "$workflow_commit" \
  --arg source_ref "$source_ref" \
  --arg source_commit "$source_commit" \
  --arg runner_binding "$runner_binding" \
  --arg runner_name "$runner_name" \
  --arg memory_class "$memory_class" \
  '{
    ref: $ref,
    inputs: {
      workflow_commit: $workflow_commit,
      source_ref: $source_ref,
      source_commit: $source_commit,
      runner_binding: $runner_binding,
      runner_name: $runner_name,
      memory_class: $memory_class
    }
  }')"
gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$control_repository/actions/workflows/$workflow_file/dispatches" \
  --input - \
  --silent <<<"$dispatch_payload" >/dev/null
dispatch_submitted=1

display_title="Command EVE Phase B $memory_class $runner_binding"
deadline=$((SECONDS + poll_timeout_seconds))
run=''
while ((SECONDS < deadline)); do
  runs="$(gh api \
    "repos/$control_repository/actions/workflows/$workflow_file/runs?event=workflow_dispatch&per_page=100")"
  run="$(jq -c \
    --arg workflow_commit "$workflow_commit" \
    --arg tag_name "$tag_name" \
    --arg display_title "$display_title" \
    '[.workflow_runs[] | select(
      .event == "workflow_dispatch" and
      .head_sha == $workflow_commit and
      .head_branch == $tag_name and
      .display_title == $display_title
    )] | sort_by(.id) | last // empty' <<<"$runs")"
  [[ -n "$run" ]] && break
  sleep 5
done
[[ -n "$run" ]] || {
  printf 'Timed out waiting for the uniquely bound Phase B workflow run.\n' >&2
  exit 1
}

run_id="$(jq -er '.id | tostring' <<<"$run")"
run_attempt="$(jq -er '.run_attempt' <<<"$run")"
run_url="$(jq -er '.html_url' <<<"$run")"
run_status="$(jq -er '.status' <<<"$run")"
run_created_at="$(jq -er '.created_at' <<<"$run")"
workflow_ref="$control_repository/.github/workflows/$workflow_file@$tag_ref"

jq -n \
  --arg control_repository "$control_repository" \
  --arg workflow_commit "$workflow_commit" \
  --arg workflow_template_blob "$workflow_template_blob" \
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
  --arg workflow_file "$workflow_file" \
  --arg workflow_tag "$tag_name" \
  --arg run_ref "$tag_ref" \
  --arg workflow_ref "$workflow_ref" \
  --arg run_id "$run_id" \
  --argjson run_attempt "$run_attempt" \
  --arg run_url "$run_url" \
  --arg run_status "$run_status" \
  --arg run_created_at "$run_created_at" \
  --arg dispatched_at "$dispatched_at" \
  '{
    schema_version: "command-eve-windows-phase-b-dispatch/v1",
    control_repository: $control_repository,
    workflow_commit: $workflow_commit,
    workflow_template_blob: $workflow_template_blob,
    source_repository: $source_repository,
    source_ref: $source_ref,
    source_commit: $source_commit,
    memory_class: $memory_class,
    memory_label: $memory_label,
    runner_binding: $runner_binding,
    runner_name: $runner_name,
    runner_id: $runner_id,
    jit_config_sha256: $jit_config_sha256,
    jit_config_bytes: $jit_config_bytes,
    workflow_file: $workflow_file,
    workflow_tag: $workflow_tag,
    run_ref: $run_ref,
    workflow_ref: $workflow_ref,
    run_id: $run_id,
    run_attempt: $run_attempt,
    run_url: $run_url,
    run_status_at_receipt: $run_status,
    run_created_at: $run_created_at,
    dispatched_at: $dispatched_at,
    status: "PASS",
    completion_sentinel: "WIN_PHASE_B_PRIVATE_DISPATCH_COMPLETE"
  }' >"$receipt_temp"
chmod 600 "$receipt_temp"
mv -f "$receipt_temp" "$receipt_out"

run_deadline=$((SECONDS + run_timeout_seconds))
run_conclusion=''
last_run_heartbeat=0
while ((SECONDS < run_deadline)); do
  run="$(gh api "repos/$control_repository/actions/runs/$run_id")"
  run_status="$(jq -er '.status' <<<"$run")"
  if [[ "$run_status" == 'completed' ]]; then
    run_conclusion="$(jq -er '.conclusion' <<<"$run")"
    run_completed=1
    break
  fi
  if ((SECONDS - last_run_heartbeat >= 30)); then
    printf 'Phase B workflow heartbeat: run_id=%s status=%s binding=%s.\n' \
      "$run_id" "$run_status" "$runner_binding"
    last_run_heartbeat=$SECONDS
  fi
  sleep 10
done
[[ "$run_completed" == '1' ]] || {
  printf 'Timed out waiting for Phase B workflow run %s; cancellation and runner revocation requested.\n' \
    "$run_id" >&2
  exit 1
}
[[ "$run_conclusion" == 'success' ]] || {
  printf 'Phase B workflow run %s completed with conclusion %s.\n' "$run_id" "$run_conclusion" >&2
  exit 1
}

binding_evidence_dir="$evidence_out_dir/$runner_binding"
[[ ! -e "$binding_evidence_dir" ]] || {
  printf 'Refusing to overwrite existing Phase B evidence directory: %s\n' "$binding_evidence_dir" >&2
  exit 1
}
mkdir -p "$binding_evidence_dir"
chmod 700 "$binding_evidence_dir"
artifact_name="windows-phase-b-bootstrap-$runner_binding"
gh run download "$run_id" \
  --repo "$control_repository" \
  --name "$artifact_name" \
  --dir "$binding_evidence_dir"

runner_policy_receipt=''
runner_policy_receipt_count=0
while IFS= read -r candidate; do
  runner_policy_receipt="$candidate"
  runner_policy_receipt_count=$((runner_policy_receipt_count + 1))
done < <(find "$binding_evidence_dir" -type f -name 'runner-policy-receipt.json' -print)
[[ "$runner_policy_receipt_count" == '1' ]] || {
  printf 'Expected exactly one runner-policy-receipt.json in artifact %s; found %s.\n' \
    "$artifact_name" "$runner_policy_receipt_count" >&2
  exit 1
}

binding_receipt="$binding_evidence_dir/jit-run-binding-receipt.json"
bun "$script_directory/validate-phase-b-run-binding.ts" \
  --issuance "$issuance_path" \
  --dispatch "$receipt_out" \
  --runner-policy-receipt "$runner_policy_receipt" \
  --output "$binding_receipt"
jq -e '
  .schema_version == "command-eve-windows-phase-b-jit-run-binding/v1" and
  .status == "PASS" and
  (.reject_codes | length) == 0 and
  .completion_sentinel == "WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE"
' "$binding_receipt" >/dev/null

revoke_issued_runner
printf 'WIN_PHASE_B_PRIVATE_DISPATCH_COMPLETE run_id=%s binding=%s dispatch_receipt=%s binding_receipt=%s\n' \
  "$run_id" "$runner_binding" "$receipt_out" "$binding_receipt"
