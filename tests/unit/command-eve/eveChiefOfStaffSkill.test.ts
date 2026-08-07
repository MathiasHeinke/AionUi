/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1751 — eve-chief-of-staff-orchestration + the ai-coding-delegation revision.
 *
 * Two classes of assertion live here, and the split is deliberate:
 *
 *  1. DOCTRINE assertions on the two SKILL.md bodies. These are the guardrails that a
 *     later editor would otherwise silently soften — the money floor, the audit policy,
 *     the failure taxonomy, the permanence of the HG-3.5 seat.
 *
 *  2. BEHAVIOURAL assertions that EXECUTE the shell helpers the skill actually teaches,
 *     against a scripted fake tmux. Grepping for the presence of a helper proves nothing
 *     about whether it can tell "still working" from "finished" — and a status helper that
 *     cannot is worse than none, because callers trust it. So we run it.
 *
 * Red-before observations for the behavioural cases were taken against the PRIOR draft's
 * `wait_idle` / `grep -qE .` implementations with these same fixtures:
 *   - history fixture   -> prior wait_idle RETURNED 0 (reported FINISHED) while mid-stream
 *   - notstarted fixture-> prior wait_idle RETURNED 0 (reported FINISHED) before the turn began
 *   - bare-prompt paste -> prior `grep -qE .` PASSED on a bare shell prompt
 *
 * Second review, three more helpers that ASSERTED a state they had not established. Each
 * red-before below was OBSERVED by executing the then-current fence against these fixtures:
 *   - fast-ready launch  -> `await_start claude-del 60` returned 1 => "TIMED_OUT" for a
 *                           CLI that was up and healthy (ready mistaken for timeout)
 *   - crashed-to-shell   -> `await_state` matched '(❯|>|\$)[[:space:]]*$' on the surviving
 *                           bash prompt and printed FINISHED, exit 0 (dead mistaken for done)
 *   - 90s working wait   -> `await_state claude-del 90` emitted 0 status lines
 *                           (silence mistaken for progress)
 *
 * THIRD review — the liveness proof itself was unsafe, and in fixing "dead read as
 * FINISHED" it had introduced the mirror defect "alive read as DEAD". `coder_alive` read
 * `pane_current_command` and treated bash/sh/zsh as death — but while a coder runs an
 * ALLOWED SHELL TOOL that IS the pane's foreground command, with the coder alive one level
 * up. Red-before, all three OBSERVED by executing the then-current fence (2026-08-01):
 *   - bash tool child    -> pane showing `⏺ Bash(pytest…)` + `✻ Working…`, foreground `bash`:
 *                           await_state printed "RUNTIME_ERROR: the coder exited to the
 *                           shell after 0s" / DEAD / exit 3 — an ACTIVE worker killed off
 *   - exited top-level   -> coder gone, a lingering `node` owning the pane, idle prompt:
 *                           await_state printed FINISHED, exit 0 — success for a dead worker
 *   - absent ancestor    -> coder nowhere in the pane tree, `python` in front, idle prompt:
 *                           await_state printed FINISHED, exit 0
 * Both misreads have ONE cause: inferring a state from a proxy signal. The replacement
 * ESTABLISHES the fact — an exit sentinel written only after the TOP-LEVEL coder returns
 * (a tool child runs inside the coder and can never advance the launcher shell to it), plus
 * an ancestry check that asks "is the coder anywhere in this pane's tree", not "is it in
 * front". So a temporary shell/tool child stays WORKING; only the sentinel or an absent
 * ancestor is DEAD.
 *
 * FOURTH review — the failing assertion was OURS, not the skill's. See
 * aiCodingDelegationGate.test.ts: that suite demanded `disable_model_invocation: true` from
 * 'plaud-recording-ingest', and the failure had been excused as "pre-existing" for this whole
 * workstream. It was a wrong test model on two counts — PLAUD's handoff contract requires
 * STANDARD frontmatter (plaudRecordingIngestSkill.test.ts:68 asserts the exact opposite, so
 * the two tests could never both pass), and the key is not a runtime control at all. The
 * correction lives there; the constant imported below is now the single source of truth for
 * which skills that key is required from.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK, EVE_STRATEGY_SKILL_IDS } from '@/process/commandEve/runtimeBootstrapCore';
import {
  EVE_STRATEGY_SKILL_IDS as STAGED_SKILL_IDS,
  SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION,
} from '../../../scripts/fetch-bundled-skills.mjs';

const BUNDLED = path.resolve(__dirname, '../../../resources/bundled-skills');
const COS_PATH = path.join(BUNDLED, 'eve-chief-of-staff-orchestration', 'SKILL.md');
const DELEGATION_PATH = path.join(BUNDLED, 'ai-coding-delegation', 'SKILL.md');

const cos = fs.readFileSync(COS_PATH, 'utf8');
const delegation = fs.readFileSync(DELEGATION_PATH, 'utf8');

// The SOUL literal is module-private, so read the PROSE out of the source the same way the
// soul-wiring tripwire does — assert on the soul text itself, never on a comment near it.
const RUNTIME_SOURCE_PATH = path.resolve(
  __dirname,
  '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'
);
const soulMarkdown = (): string => {
  const raw = fs.readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
  const marker = 'const EVE_SOUL_MARKDOWN = `';
  const start = raw.indexOf(marker);
  expect(start, 'EVE_SOUL_MARKDOWN literal must exist').toBeGreaterThan(-1);
  const bodyStart = start + marker.length;
  const end = raw.indexOf('`;', bodyStart);
  expect(end, 'EVE_SOUL_MARKDOWN literal must be terminated').toBeGreaterThan(bodyStart);
  return raw.slice(bodyStart, end);
};
const SOUL = soulMarkdown();

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('MAT-1751 wiring: the chief-of-staff skill is really bundled', () => {
  it('is in the runtime copy allowlist and the build staging allowlist, in lockstep', () => {
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain('eve-chief-of-staff-orchestration');
    expect(STAGED_SKILL_IDS).toContain('eve-chief-of-staff-orchestration');
    expect(STAGED_SKILL_IDS).toEqual([...EVE_STRATEGY_SKILL_IDS]);
  });

  it('has a user-facing capability card, active (the seat is permanent, not opt-in)', () => {
    const card = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'eve-chief-of-staff-orchestration');
    expect(card).toBeDefined();
    expect(card?.default_state).toBe('active');
    expect(card?.name).not.toBe('eve-chief-of-staff-orchestration');
    expect(card?.source.trim()).not.toBe('');
  });

  it('is deliberately NOT on the explicit-invocation-only list', () => {
    // The bundled Hermes 0.20.0 wheel contains ZERO occurrences of
    // `disable_model_invocation` — the key is a REPO-SIDE curation contract enforced by
    // this list, not a Hermes runtime switch. Keeping the permanent seat off the list is
    // the intended state; the assertion stops it drifting on.
    expect(SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION).not.toContain('eve-chief-of-staff-orchestration');
    expect(cos).not.toMatch(/^disable_model_invocation:/m);
  });

  it('carries valid frontmatter with a trigger-bearing description', () => {
    expect(cos.startsWith('---\nname: eve-chief-of-staff-orchestration\n')).toBe(true);
    expect(cos).toMatch(/^description: >-$/m);
    expect(cos).toMatch(/\bUse when\b/);
  });
});

// ---------------------------------------------------------------------------
// Doctrine — the seat, the lane, the session, the audit, the card
// ---------------------------------------------------------------------------

describe('MAT-1751 doctrine: the permanent HG-3.5 seat', () => {
  it('fixes the seat as permanent, never CEO, never primary coder, never own auditor', () => {
    expect(cos).toMatch(/Your seat is permanent/);
    expect(cos).toMatch(/Chief of Staff at \*\*HG-3\.5\*\*|\*\*Chief of Staff at HG-3\.5\*\*/);
    expect(cos).toMatch(/\*\*Never the CEO\.\*\*/);
    expect(cos).toMatch(/\*\*Never the primary coder\.\*\*/);
    expect(cos).toMatch(/\*\*Never your own auditor\.\*\*/);
    expect(cos).toMatch(/not permission to leave it/i);
  });

  it('runs the loop: translate intent -> lane -> one session -> prove state -> evaluate -> ONE card', () => {
    expect(cos).toMatch(/\*\*Translate intent\.\*\*/);
    expect(cos).toMatch(/\*\*Choose the CEO lane\*\*/);
    expect(cos).toMatch(/\*\*Open ONE named session\*\*/);
    expect(cos).toMatch(/\*\*Prove state, don't guess it\*\*/);
    expect(cos).toMatch(/\*\*Evaluate the returned evidence\*\*/);
    expect(cos).toMatch(/\*\*Order correction\*\*/);
    expect(cos).toMatch(/\*\*Return ONE decision card\*\*/);
    expect(cos).toMatch(/## The decision card/);
    expect(cos).toMatch(/one call, not a menu/i);
    expect(cos).toMatch(/FACT \/ INFERENCE \/ HYPOTHESIS/);
  });

  it('selects a CEO lane by CAPABILITY, else a budgeted router CEO, with three absolute rules', () => {
    expect(cos).toMatch(/authenticated Claude \/ Codex \/ Gemini CLI/);
    expect(cos).toMatch(/\*\*by\s+capability\*\*/);
    expect(cos).toMatch(/Kimi K3 or Opus 5/);
    expect(cos).toMatch(/explicit budget/i);
    expect(cos).toMatch(/capability receipts/i);
    expect(cos).toMatch(/Never claim a model-less child is Kimi/);
    expect(cos).toMatch(/Never retry an unsupported model override/);
    expect(cos).toMatch(/Never silently substitute a model/);
  });

  it('keeps ONE named context-bearing session that ends only at a real boundary', () => {
    expect(cos).toMatch(/one named, context-bearing session per workstream/i);
    expect(cos).toMatch(/Re-attach before you create/i);
    expect(cos).toMatch(/It ends at a real boundary/i);
    expect(cos).toMatch(/Ending it because a single task\s+finished is throwing away/i);
    expect(cos).toMatch(/resumable trace/i);
  });

  it('pins the audit lane: Fable 5 at high, gpt-5.6-sol at xhigh via the LOCAL Codex CLI', () => {
    expect(cos).toMatch(/\*\*Final CAO:\*\* Fable 5/);
    expect(cos).toMatch(/highest supported effort[\s\S]{0,40}`high`/);
    expect(cos).toMatch(/There is no higher setting to ask for/i);
    expect(cos).toMatch(/`gpt-5\.6-sol` at `xhigh`/);
    expect(cos).toMatch(/\*\*local Codex CLI\*\*/);
    expect(cos).toMatch(/different provider families/i);
  });

  it('makes GPT-5.5 diagnostic-only and never a release PASS', () => {
    expect(cos).toMatch(/GPT-5\.5 is diagnostic-only/);
    expect(cos).toMatch(/can never constitute a release\s+\*\*PASS\*\*|\*\*can never constitute a release\s+PASS\*\*/);
    expect(cos).toMatch(/fabricated gate/i);
  });

  it('keeps skill authoring proposable but promotion human-gated', () => {
    expect(cos).toMatch(/\*\*propose or create\*\*/);
    expect(cos).toMatch(/Promotion is a different act/i);
    expect(cos).toMatch(/independently\s+reviewed and human-gated/i);
    expect(cos).toMatch(/do not promote it yourself/i);
  });

  it('refuses to re-specify the native runtime/product contracts', () => {
    expect(cos).toMatch(/## Not yours to re-specify/);
    for (const contract of [
      'Artifact and conversation-history behaviour',
      'Video editing implementation',
      'Standard / MAX inference routing',
      'Billing and credit logic',
    ]) {
      expect(cos, contract).toContain(contract);
    }
    expect(cos).toMatch(/a second copy of a contract is a contract that will drift/i);
  });
});

// ---------------------------------------------------------------------------
// The money floor — the correction that would otherwise reintroduce the popup
// ---------------------------------------------------------------------------

describe('MAT-1751 money floor: pre-priced media is NOT an escalation', () => {
  const bodies: Array<[string, string]> = [
    ['eve-chief-of-staff-orchestration', cos],
    ['ai-coding-delegation', delegation],
  ];

  it.each(bodies)('%s escalates buying credits, external payment and publishing', (_id, body) => {
    expect(body).toMatch(/purchas\w* credits|purchase credits|buying credits/i);
    expect(body).toMatch(/checkout|external payment/i);
    expect(body).toMatch(/publish/i);
  });

  it.each(bodies)('%s carves out an ALREADY SELECTED, PRE-PRICED media send', (_id, body) => {
    // `[\s>*]` tolerates the markdown blockquote/bold wrapping the phrase may wear.
    expect(body).toMatch(/already[\s>*]*selected/i);
    expect(body).toMatch(/shown price/i);
    expect(body).toMatch(/IS\b[\s\S]{0,40}authorization for that prepaid[\s>]+credit spend/i);
    expect(body).toMatch(/no second (confirmation|popup)/i);
  });

  it.each(bodies)('%s never re-asserts a blanket "spending money always escalates"', (_id, body) => {
    // The prior draft said hard floors escalate "no exceptions" and listed "spending money
    // or approving a payment" — which reintroduces the media cost popup the founder killed.
    expect(body).not.toMatch(/spend(ing)? money/i);
    expect(body).not.toMatch(/approv(e|ing) a payment/i);
    expect(body).not.toMatch(/no exceptions/i);
  });

  it('SOUL.md carries the same carve-out — pre-priced media send IS the authorization', () => {
    // RED-BEFORE (observed at base 891d126b): the boundary read "You do NOT move money —
    // checkout, payouts, and publishing are the operator's action", with NO carve-out, so the
    // always-on identity itself demanded a second confirmation for an already-priced send.
    expect(SOUL).toMatch(/Buying credits, checkout, payouts and publishing are the operator's action/);
    expect(SOUL).toMatch(/Not a second gate/);
    expect(SOUL).toMatch(/already sent at a shown price IS that authorization/i);
    expect(SOUL).toMatch(/run it, never ask again/i);
    expect(SOUL).not.toMatch(/spend(ing)? money/i);
  });

  it('SOUL.md fixes the PERMANENT HG-3.5 chief-of-staff identity (minimal, voice-slot only)', () => {
    // RED-BEFORE (observed at base 891d126b): the identity line read "A confidant and
    // chief-of-staff with the cadence of someone who has run real operations" — a role
    // DESCRIPTION with no seat, no permanence, and nothing forbidding the CEO/coder chair.
    expect(SOUL).toMatch(/PERMANENT chief-of-staff at HG-3\.5/);
    expect(SOUL).toMatch(/never the CEO seat, never the primary coder/i);
    // Minimal by design: the SOUL states the SEAT; the loop, the permanence rationale and the
    // "never your own auditor" rule live in the bundled skill, so there is no second copy to drift.
    expect(SOUL).not.toMatch(/^## (Chief of Staff|Orchestration|The loop)/m);
    expect(cos).toMatch(/does not change with the task, the lane, or how well the last run went/);
    expect(cos).toMatch(/beside them, not above them, and not in the chair/);
  });

  it('states where the gate actually sits: money in, work out — never in between', () => {
    expect(cos).toMatch(/money \*enters\* \(buying credits\)/);
    expect(cos).toMatch(/work \*leaves\* \(publishing\)/);
    expect(delegation).toMatch(/money ENTERS \(buying credits\)/);
    expect(delegation).toMatch(/work LEAVES \(publishing\)/);
  });
});

// ---------------------------------------------------------------------------
// The failure taxonomy — three codes, classified from the OBSERVED cause
// ---------------------------------------------------------------------------

describe('MAT-1751 failure taxonomy: auth vs capability vs runtime', () => {
  it('defines all three codes in the chief-of-staff skill, with their observed causes', () => {
    expect(cos).toMatch(/## Failure taxonomy/);
    expect(cos).toMatch(/`BLOCKED_AUTH`[^\n]*[Cc]redentials rejected|[Cc]redentials rejected[^\n]*/);
    expect(cos).toMatch(/`BLOCKED_CAPABILITY`[^\n]*unavailable or unsupported/);
    expect(cos).toMatch(/`RUNTIME_ERROR`[^\n]*(Crash|crash)[^\n]*timeout/);
  });

  it('classifies the live precedent — an unsupported model override — as CAPABILITY, not AUTH', () => {
    // Live 2026-07-31 observation: "model may not exist or you may not have access" on an
    // override. Calling that auth sends the founder to re-login for nothing.
    expect(cos).toMatch(/[Mm]odel may not exist or you may not have access/);
    expect(cos).toMatch(/is `BLOCKED_CAPABILITY`/);
    expect(cos).toMatch(/re-login for nothing/i);
    expect(cos).toMatch(/Do not blanket-call everything auth/i);
  });

  it('routes a model-less child to RUNTIME_ERROR, not a claimed Kimi', () => {
    expect(cos).toMatch(/`RUNTIME_ERROR model-alias-unproved`/);
  });

  it('no longer collapses "no lane can be proven" into BLOCKED_AUTH', () => {
    // The prior draft ended lane selection with a bare "If no lane can be proven: BLOCKED_AUTH."
    expect(cos).not.toMatch(/If no lane can be proven:\s*`?BLOCKED_AUTH`?\./);
    expect(cos).toMatch(/classify the failure by what you \*\*observed\*\*/i);
  });

  it('carries the same taxonomy in the delegation skill', () => {
    expect(delegation).toMatch(/`BLOCKED_AUTH`/);
    expect(delegation).toMatch(/`BLOCKED_CAPABILITY`/);
    expect(delegation).toMatch(/`RUNTIME_ERROR`/);
    expect(delegation).toMatch(/never re-send a rejected model override/i);
  });
});

// ---------------------------------------------------------------------------
// The judgment gate
// ---------------------------------------------------------------------------

describe('MAT-1751 judgment gate', () => {
  it('silently approves only in-scope benign work, escalates the rest, never rubber-stamps', () => {
    expect(cos).toMatch(/\*\*Silently approve\*\* only the clearly in-scope, benign operations/);
    expect(cos).toMatch(/\*\*Escalate\*\* anything consequential, out-of-scope, irreversible, or suspicious/);
    expect(cos).toMatch(/prompt-injection or goal drift/i);
    expect(cos).toMatch(/\*\*Never rubber-stamp\.\*\*/);
    expect(cos).toMatch(/permission\s+fatigue/i);
  });
});

// ---------------------------------------------------------------------------
// The two-phase state proof — DOCTRINE
// ---------------------------------------------------------------------------

describe('MAT-1751 two-phase state proof: doctrine', () => {
  it('names both defects it exists to prevent', () => {
    expect(cos).toMatch(/transcript HISTORY|transcript \*\*history\*\*/i);
    expect(delegation).toMatch(/matches transcript HISTORY/i);
    expect(delegation).toMatch(/never widen with `-S`/i);
    expect(cos).toMatch(/before processing has even started/i);
    expect(delegation).toMatch(/returns before processing starts/i);
  });

  it('states the two phases in order and the four states explicitly', () => {
    expect(cos).toMatch(/\*\*PHASE 1 — prove it STARTED\.\*\*/);
    expect(cos).toMatch(/\*\*PHASE 2 — only then wait for a terminal state\.\*\*/);
    expect(cos).toMatch(/do NOT proceed to Phase 2/);
    for (const state of ['WORKING', 'WAITING-FOR-DECISION', 'FINISHED', 'DEAD']) {
      expect(cos, `${state} must be an explicit state`).toContain(state);
      expect(delegation, `${state} must be an explicit state`).toContain(state);
    }
  });

  it('says out loud why a helper that cannot distinguish the states is worse than none', () => {
    expect(delegation).toMatch(/worse than no helper, because the caller trusts it/i);
  });

  it('requires positive delivery evidence and ONE explicit Enter', () => {
    expect(cos).toMatch(/task text itself\*\* or the paste marker must be visible/i);
    expect(cos).toMatch(/Text-is-on-screen is not\s+message-was-submitted/i);
    expect(cos).toMatch(/send Enter \*\*explicitly, once\*\*/i);
    expect(delegation).toMatch(/`grep -qE \.` matches the shell\s+prompt itself/);
    expect(delegation).toMatch(/Submit EXPLICITLY, exactly ONCE/);
  });
});

// ---------------------------------------------------------------------------
// The two-phase state proof — BEHAVIOUR (the helpers are executed)
// ---------------------------------------------------------------------------

const bashFences = (body: string): string[] => [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

const stateFence = (): string => {
  const fence = bashFences(delegation).find((f) => f.includes('await_state()'));
  expect(fence, 'the delegation skill must define await_start/await_state in a bash fence').toBeDefined();
  return fence as string;
};

const pasteFence = (): string => {
  const fence = bashFences(delegation).find((f) => f.includes('ANCHOR='));
  expect(fence, 'the delegation skill must define the paste verification in a bash fence').toBeDefined();
  return fence as string;
};

// A scripted fake tmux + a scripted fake process table. `sleep` is a no-op so the poll loops
// run instantly and the capture-pane call count stands in for elapsed time.
//
// The process table is the important part. Liveness is no longer "what is the pane's
// FOREGROUND command" — that question cannot distinguish a crashed coder from one that
// legitimately shelled out to run the tests. So the fakes model what the real helpers really
// walk:
//   * `pgrep -P` / `ps -o comm= -p` over "ppid:pid:comm" triples, so `coder_in_pane_tree`
//     does a real ancestry walk. DEFAULT = a live `claude` under the pane's shell.
//   * a FRESH TMPDIR per case, so `coder_sentinel` starts absent and a test can `touch` it
//     to model the TOP-LEVEL coder having exited.
//   * FAKE_PANE_CMD still exists, and is deliberately set to `bash`/`python` in the tool-child
//     cases to prove the foreground command NO LONGER drives the verdict.
const HARNESS_PRELUDE = `
set -u
export TMPDIR="$(mktemp -d)"           # fresh sentinel dir: no leakage between fixtures
STEP_FILE="$(mktemp)"; echo 0 > "$STEP_FILE"
sleep() { :; }
step() { local n; n="$(cat "$STEP_FILE")"; echo $((n + 1)) > "$STEP_FILE"; printf '%s' "$n"; }

# "ppid:pid:comm" triples. Default: the coder alive as a child of the pane's shell.
DEFAULT_PROCS='0:900:zsh 900:901:claude'
procs() { printf '%s\\n' \${FAKE_PROCS:-$DEFAULT_PROCS}; }
pgrep() { procs | awk -F: -v p="$2" '$1==p {print $2}'; }
ps() {
  local want=""
  while [ "$#" -gt 0 ]; do [ "$1" = "-p" ] && want="\${2:-}"; shift; done
  procs | awk -F: -v p="$want" '$2==p {print $3}'
}

tmux() {
  case "\${1:-}" in
    has-session) return "\${FAKE_TMUX_DEAD:-0}" ;;
    display-message)
      case "$*" in
        *pane_pid*) printf '%s' "\${FAKE_PANE_PID:-900}" ;;
        *) printf '%s' "\${FAKE_PANE_CMD:-node}" ;;
      esac ;;
    send-keys|new-session|kill-session|list-sessions) return 0 ;;
    capture-pane) pane "$(step)" ;;
    *) return 0 ;;
  esac
}
`;

const tmpFiles: string[] = [];
const runBash = (script: string): { stdout: string; status: number } => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cos-bash-')), 'harness.sh');
  tmpFiles.push(path.dirname(file));
  fs.writeFileSync(file, script, 'utf8');
  try {
    const stdout = execFileSync('bash', [file], { encoding: 'utf8' });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
};

afterAll(() => {
  for (const dir of tmpFiles) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MAT-1751 two-phase state proof: the helpers actually behave', () => {
  it('a historical prompt glyph in the scrollback does NOT satisfy FINISHED', () => {
    // RED-BEFORE (observed): the prior `wait_idle` used `capture-pane -S -20` + grep '❯'
    // and RETURNED 0 on this exact pane — reporting FINISHED while the coder was streaming.
    const pane = `
pane() {
  cat <<'PANE'
❯ add retry logic to the http client
I will add a bounded retry with jitter.
Reading the client module now.
Planning the change set:
- wrap the request in a retry loop
- add a jitter helper
- cover it with a unit test
PANE
}
`;
    const { stdout } = runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}\nawait_state claude-del 30\necho "EXIT=$?"\n`);
    expect(stdout).toMatch(/^WORKING$/m);
    expect(stdout).not.toMatch(/^FINISHED$/m);
    expect(stdout).toMatch(/EXIT=1/);
  });

  it('called immediately after Enter, the wait does NOT report FINISHED before the turn starts', () => {
    // RED-BEFORE (observed): the prior `wait_idle` RETURNED 0 on the first poll here,
    // because the pane still showed the idle prompt of the turn that had not begun.
    const pane = `
pane() {
  if [ "$1" -lt 3 ]; then
    printf '%s\\n' '❯ '
  else
    printf '%s\\n' '❯ refactor the auth module' '✻ Thinking…'
  fi
}
`;
    const script = `${HARNESS_PRELUDE}${pane}${stateFence()}
if await_start claude-del 30; then echo "STARTED"; else echo "NEVER_STARTED"; fi
await_state claude-del 30
`;
    const { stdout } = runBash(script);
    expect(stdout).toMatch(/^STARTED$/m);
    // and once started, the state is WORKING — never FINISHED.
    expect(stdout).toMatch(/^WORKING$/m);
    expect(stdout).not.toMatch(/^FINISHED$/m);
  });

  it('await_start reports NEVER_STARTED when the message did not land at all', () => {
    const pane = `pane() { printf '%s\\n' '❯ '; }\n`;
    const { stdout } = runBash(
      `${HARNESS_PRELUDE}${pane}${stateFence()}\nif await_start claude-del 5; then echo STARTED; else echo NEVER_STARTED; fi\n`
    );
    expect(stdout).toMatch(/^NEVER_STARTED$/m);
  });

  it('distinguishes FINISHED, WAITING-FOR-DECISION and DEAD from WORKING', () => {
    const finished = `pane() { printf '%s\\n' 'Done — 3 files changed.' '❯ '; }\n`;
    expect(runBash(`${HARNESS_PRELUDE}${finished}${stateFence()}\nawait_state claude-del 30\n`).stdout).toMatch(
      /^FINISHED$/m
    );

    const asking = `pane() { printf '%s\\n' 'Do you want to run rm -rf build?' '❯ 1. Yes' '  2. No'; }\n`;
    expect(runBash(`${HARNESS_PRELUDE}${asking}${stateFence()}\nawait_state claude-del 30\n`).stdout).toMatch(
      /^WAITING-FOR-DECISION$/m
    );

    const dead = `pane() { printf '%s\\n' ''; }\nFAKE_TMUX_DEAD=1\n`;
    expect(runBash(`${HARNESS_PRELUDE}${dead}${stateFence()}\nawait_state claude-del 30\n`).stdout).toMatch(/^DEAD$/m);
  });
});

// ---------------------------------------------------------------------------
// LIVENESS (correction 10) — the coder is ESTABLISHED, never inferred from the
// pane's foreground command. Both directions, both executed.
// ---------------------------------------------------------------------------

// A coder running an ALLOWED SHELL TOOL: the foreground command really is `bash`, and the
// coder is its PARENT — alive, mid-task, visibly working.
const PANE_TOOL_CHILD_BASH = `
pane() {
  cat <<'PANE'
⏺ Bash(pytest -q tests/http)
  ⎿ running…
✻ Working…
PANE
}
FAKE_PANE_CMD=bash
FAKE_PROCS='0:900:zsh 900:901:claude 901:902:bash'
`;

describe('MAT-1751 liveness: a tool child is not a dead coder, an exited coder is not FINISHED', () => {
  it('keeps a coder WORKING while its own bash TOOL CHILD is the pane foreground command', () => {
    // RED-BEFORE (OBSERVED 2026-08-01, this exact fixture against the then-current fence):
    //   [eve] claude-del RUNTIME_ERROR: the coder exited to the shell after 0s
    //   DEAD
    //   EXIT=3
    // `coder_alive` read `pane_current_command` == 'bash' and condemned a worker that was
    // visibly mid-test-run. That regression is the reason for this round.
    const { stdout, status } = runBash(
      `${HARNESS_PRELUDE}${PANE_TOOL_CHILD_BASH}${stateFence()}\nawait_state claude-del 30\n`
    );
    expect(stdout).toMatch(/^WORKING$/m);
    expect(stdout).not.toMatch(/^DEAD$/m);
    expect(stdout).not.toMatch(/^FINISHED$/m);
    expect(status).toBe(1);
  });

  it('keeps a coder WORKING while a python TOOL CHILD owns the foreground', () => {
    // HONEST NOTE — unlike its bash sibling above, this case did NOT go red against the
    // pre-fix primitive, and it is not claimed to have. That primitive asked "is the
    // foreground command a SHELL?" and `python3` is not on that list, so it happened to
    // land on WORKING for the wrong reason ("not a shell, therefore alive") — the very
    // inference that made the two DEAD cases below report FINISHED. This test pins the
    // RIGHT reason: WORKING because the coder is still in the pane's ancestry.
    const pane = `
pane() { printf '%s\\n' '⏺ Bash(python3 scripts/migrate.py)' '✻ Working…'; }
FAKE_PANE_CMD=python3
FAKE_PROCS='0:900:zsh 900:901:claude 901:905:python3'
`;
    const { stdout, status } = runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}\nawait_state claude-del 30\n`);
    expect(stdout).toMatch(/^WORKING$/m);
    expect(stdout).not.toMatch(/^DEAD$/m);
    expect(status).toBe(1);
  });

  it('await_ready does not mistake a tool child for a dead coder either', () => {
    // The readiness check shares the liveness primitive, so the same defect would have made a
    // busy-but-healthy session unlaunchable. It must simply be NOT-READY (still working), never DEAD.
    const out = runBash(`${HARNESS_PRELUDE}${PANE_TOOL_CHILD_BASH}${stateFence()}\nawait_ready claude-del 3\n`).stdout;
    expect(out).toMatch(/^NOT-READY$/m);
    expect(out).not.toMatch(/^DEAD$/m);
  });

  it('classifies a genuinely EXITED top-level coder as DEAD — never FINISHED, never WORKING', () => {
    // RED-BEFORE (OBSERVED 2026-08-01, this exact fixture): the then-current fence printed
    //   FINISHED
    //   EXIT=0
    // — success reported for a worker whose top-level process was gone, because a lingering
    // `node` in the foreground read as "not a shell, therefore alive".
    const pane = `
pane() { printf '%s\\n' 'Done — 3 files changed.' '❯ '; }
FAKE_PANE_CMD=node
FAKE_PROCS='0:900:zsh 900:903:node'
`;
    const { stdout, status } = runBash(
      `${HARNESS_PRELUDE}${pane}${stateFence()}\ntouch "$(coder_sentinel claude-del)"\nawait_state claude-del 30 2>&1\n`
    );
    expect(stdout).toMatch(/^DEAD$/m);
    expect(stdout).not.toMatch(/^FINISHED$/m);
    expect(stdout).not.toMatch(/^WORKING$/m);
    expect(stdout).toMatch(/RUNTIME_ERROR: the coder process EXITED \(sentinel\)/);
    expect(status).toBe(3);
  });

  it('classifies an ABSENT ANCESTOR (no sentinel, coder gone from the pane tree) as DEAD', () => {
    // RED-BEFORE (OBSERVED 2026-08-01): FINISHED / EXIT=0 — a `python` leftover in the
    // foreground passed the old "not a shell" test while the coder itself no longer existed.
    const pane = `
pane() { printf '%s\\n' 'Done.' '❯ '; }
FAKE_PANE_CMD=python
FAKE_PROCS='0:900:zsh'
`;
    const { stdout, status } = runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}\nawait_state claude-del 30 2>&1\n`);
    expect(stdout).toMatch(/^DEAD$/m);
    expect(stdout).not.toMatch(/^FINISHED$/m);
    expect(stdout).toMatch(/no longer in the pane process tree/);
    expect(status).toBe(3);
  });

  it('installs a session-derived exit sentinel on launch that only the LAUNCHER shell can write', () => {
    // The sentinel write is chained after the coder command in the SAME launcher shell. That
    // shell is blocked inside the coder for as long as the coder runs, so nothing the coder
    // spawns can advance it to the write. Here the coder never runs at all (fake send-keys),
    // and the sentinel is correctly ABSENT — it is not something a launch can pre-emit.
    const script = `${HARNESS_PRELUDE}
pane() { printf '%s\\n' '❯ '; }
tmux() {
  case "$1" in
    send-keys) shift; printf 'SENT:%s\\n' "$*" ;;
    display-message) printf '%s' 900 ;;
    *) return 0 ;;
  esac
}
${stateFence()}
launch_coder claude-del /repo claude --model opus
[ -f "$(coder_sentinel claude-del)" ] && echo SENTINEL_PRESENT || echo SENTINEL_ABSENT
echo "PATH_IS_SESSION_DERIVED=$(coder_sentinel other-session)"
`;
    const out = runBash(script).stdout;
    expect(out).toMatch(/SENT:.*claude --model opus; printf 'exit=%s/);
    expect(out).toMatch(/SENTINEL_ABSENT/);
    expect(out).toMatch(/PATH_IS_SESSION_DERIVED=.*eve-coder-other-session\.exit/);
  });

  it('the executable primitive no longer consults the pane foreground command at all', () => {
    const fence = stateFence();
    // It may still NAME `pane_current_command` — the comment explains why it is the wrong
    // question. What must be gone is the USE: the tmux format that reads the foreground command.
    expect(fence).not.toMatch(/#\{pane_current_command\}/);
    expect(fence).toMatch(/#\{pane_pid\}/);
    expect(fence).toMatch(/coder_exited\(\)/);
    expect(fence).toMatch(/coder_in_pane_tree\(\)/);
    expect(fence).toMatch(/pane_tree_pids\(\)/);
    expect(fence).toMatch(/launch_coder\(\)/);
  });
});

describe('MAT-1751 liveness doctrine: the false premise is gone from the prose too', () => {
  it('no longer asserts the foreground command IS the liveness proof (SKILL.md :132, :444, :477)', () => {
    expect(delegation).not.toMatch(/`pane_current_command` is the proof/);
    expect(delegation).not.toMatch(/Prove the coder process is still the pane's foreground command/);
    expect(delegation).not.toMatch(/\(`pane_current_command` is not a shell\)/);
    expect(delegation).not.toMatch(/Prove liveness with `pane_current_command`/);
    expect(delegation).not.toMatch(/A shell there means the coder CRASHED or EXITED/);
    expect(cos).not.toMatch(/prove the worker process is still the one in the foreground/i);
  });

  it('names the tool-child case in BOTH bodies and keeps it WORKING', () => {
    const bodies: Array<[string, string]> = [
      ['ai-coding-delegation', delegation],
      ['eve-chief-of-staff-orchestration', cos],
    ];
    for (const [id, body] of bodies) {
      expect(body, id).toMatch(/legitimately `bash`, `sh` or `python`/);
      expect(body, id).toMatch(/exit sentinel/i);
      expect(body, id).toMatch(/ancestry|process tree/i);
    }
    expect(delegation).toMatch(/A shell in the foreground keeps the state `WORKING`/);
    expect(cos).toMatch(/tool child therefore stays `WORKING`/);
  });

  it('states WHY a tool child can never forge the sentinel', () => {
    expect(delegation).toMatch(/NO tool child of the coder can make that line run/);
    expect(cos).toMatch(/a tool child runs \*inside\* the worker and can never trigger it/);
  });

  it('names the shared cause of both misreads — a proxy signal instead of an established fact', () => {
    expect(delegation).toMatch(/inferring a state\s+from a proxy signal instead of establishing the fact/i);
    expect(cos).toMatch(/inferring a state from a proxy signal instead of establishing it/i);
  });
});

// ---------------------------------------------------------------------------
// STARTUP READINESS (correction 6) — kept intact, re-verified by execution
// ---------------------------------------------------------------------------

describe('MAT-1751 startup readiness: a fast launch is READY, not a timeout', () => {
  it('await_ready satisfies on the FIRST poll when the CLI is already idle', () => {
    // RED-BEFORE (re-OBSERVED 2026-08-01 on this fixture): using the START-detector as the
    // STARTUP check — `await_start claude-del 60` — returned exit 1, i.e. TIMED_OUT, for a CLI
    // that was up, alive and sitting at its own prompt.
    const pane = `pane() { printf '%s\\n' '❯ '; }\n`;
    const out = runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}
echo "READY_CHECK=$(await_ready claude-del 60)"
if await_start claude-del 60; then echo "START_CHECK=STARTED"; else echo "START_CHECK=TIMED_OUT"; fi
`).stdout;
    expect(out).toMatch(/READY_CHECK=READY/);
    // The start-detector still (correctly) sees nothing start — which is precisely why it can
    // never be the startup check. Two questions, two primitives.
    expect(out).toMatch(/START_CHECK=TIMED_OUT/);
  });

  it('reports DIALOG for a first-run dialog and NOT-READY when the TUI never comes up', () => {
    const dialog = `pane() { printf '%s\\n' 'Do you trust this folder?' '❯ 1. Yes, I trust this folder'; }\n`;
    const d = runBash(`${HARNESS_PRELUDE}${dialog}${stateFence()}\nawait_ready claude-del 5\n`);
    expect(d.stdout).toMatch(/^DIALOG$/m);
    expect(d.status).toBe(2);

    const never = `pane() { printf '%s\\n' 'installing dependencies…'; }\n`;
    const n = runBash(`${HARNESS_PRELUDE}${never}${stateFence()}\nawait_ready claude-del 5\n`);
    expect(n.stdout).toMatch(/^NOT-READY$/m);
    expect(n.status).toBe(1);
  });

  it('never calls a session whose coder is gone READY', () => {
    const pane = `pane() { printf '%s\\n' '❯ '; }\nFAKE_PROCS='0:900:zsh'\n`;
    expect(runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}\nawait_ready claude-del 5\n`).stdout).toMatch(
      /^NOT-READY$/m
    );
  });
});

// ---------------------------------------------------------------------------
// HEARTBEAT CADENCE (correction 8) — kept intact, re-verified by execution
// ---------------------------------------------------------------------------

describe('MAT-1751 heartbeat: poll frequently, speak on a bounded cadence', () => {
  it('emits elapsed time AND the current step, far less often than it polls', () => {
    // RED-BEFORE (OBSERVED 2026-08-01 against a faithful reconstruction of the prior silent
    // watcher — the same loop with its two `heartbeat` calls stripped — on this fixture):
    // 0 status lines over a 90s wait. Silence read as progress.
    const pane = `pane() { printf '%s\\n' '✻ Working…' '⏺ Bash(pnpm vitest run)'; }\n`;
    const out = runBash(`${HARNESS_PRELUDE}${pane}${stateFence()}
await_state claude-del 90 2>&1
echo "POLLS=$(cat "$STEP_FILE")"
`).stdout;

    const beats = out.match(/still WORKING — \d+s elapsed, last step: /g) ?? [];
    const polls = Number(/POLLS=(\d+)/.exec(out)?.[1] ?? '0');

    expect(beats.length).toBeGreaterThanOrEqual(2); // it SPOKE
    expect(polls).toBeGreaterThanOrEqual(25); // it polled OFTEN (~3s cadence over 90s)
    expect(beats.length).toBeLessThanOrEqual(polls / 4); // but did NOT narrate every poll
    expect(out).toMatch(/still WORKING — 30s elapsed/);
    expect(out).toMatch(/last step: ⏺ Bash\(pnpm vitest run\)/); // WHAT it is doing, not just that time passed
    expect(out).toMatch(/^WORKING$/m); // budget exhausted is reported, never assumed done
  });
});

// ---------------------------------------------------------------------------
// MARKDOWN STRUCTURE (correction 9) — kept intact, with the structural check
// ---------------------------------------------------------------------------

const fenceErrors = (body: string): string[] => {
  const errors: string[] = [];
  let openedAt = 0;
  body.split('\n').forEach((line, idx) => {
    if (!line.startsWith('```')) return;
    const info = line.slice(3).trim();
    if (openedAt === 0) {
      if (info === '') errors.push(`line ${idx + 1}: closing fence with nothing open`);
      openedAt = idx + 1;
    } else {
      if (info !== '') {
        errors.push(`line ${idx + 1}: nested opening fence \`\`\`${info} inside the block opened at line ${openedAt}`);
      }
      openedAt = 0;
    }
  });
  if (openedAt !== 0) errors.push(`unclosed fence opened at line ${openedAt}`);
  return errors;
};

describe('MAT-1751 markdown structure: balanced fences, no duplicate helper block', () => {
  it('the structural check can actually FAIL — it catches a nested duplicate bash fence', () => {
    // RED-BEFORE for the check itself: fed the prior draft's shape (a second ```bash opened
    // inside an already-open block), it must report the nesting rather than silently pass.
    const nested = ['# x', '```bash', 'echo one', '```bash', 'echo two', '```', ''].join('\n');
    expect(fenceErrors(nested).join(' | ')).toMatch(/nested opening fence/);
    expect(fenceErrors(['```bash', 'echo one'].join('\n'))).toEqual(['unclosed fence opened at line 1']);
    expect(fenceErrors(['```bash', 'echo one', '```', ''].join('\n'))).toEqual([]);
  });

  it('both SKILL.md bodies are balanced with no nested block', () => {
    expect(fenceErrors(delegation), DELEGATION_PATH).toEqual([]);
    expect(fenceErrors(cos), COS_PATH).toEqual([]);
  });

  it('every bash fence in the skill is syntactically valid bash', () => {
    // A skill teaches by its fences; one that does not parse teaches a broken command. `<…>`
    // are documentation placeholders (pre-existing style at base 891d126b), substituted so the
    // check measures the SNIPPET rather than the placeholder.
    const fences = bashFences(delegation);
    expect(fences.length).toBeGreaterThanOrEqual(9);
    for (const [i, fence] of fences.entries()) {
      const src = fence.replace(/<session_name>/g, 'demo-session').replace(/<coder command…>/g, 'cmd');
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cos-syntax-')), `fence-${i}.sh`);
      tmpFiles.push(path.dirname(file));
      fs.writeFileSync(file, src, 'utf8');
      let status = 0;
      try {
        execFileSync('bash', ['-n', file], { encoding: 'utf8' });
      } catch (err) {
        status = (err as { status?: number }).status ?? -1;
      }
      expect(status, `bash fence #${i} must parse`).toBe(0);
    }
  });

  it('defines each state primitive EXACTLY once, so there is no second copy to drift', () => {
    expect(bashFences(delegation).filter((f) => f.includes('await_state()'))).toHaveLength(1);
    for (const helper of ['coder_alive', 'coder_exited', 'await_ready', 'await_start', 'await_state', 'heartbeat']) {
      expect([...delegation.matchAll(new RegExp(`^${helper}\\(\\) \\{`, 'gm'))], helper).toHaveLength(1);
    }
  });
});

describe('MAT-1751 paste verification: positive evidence only', () => {
  const runPaste = (paneFn: string): string => {
    // Cut the fence at the submit step: this case is about DELIVERY evidence only.
    // The state fence is sourced first because it defines `tail_now`, the bottom-region
    // reader the verification depends on — proving the two fences really compose.
    const fence = pasteFence().split('# 3. Submit')[0];
    return runBash(`${HARNESS_PRELUDE}${paneFn}${stateFence()}${fence}\necho "LANDED=$landed"\n`).stdout;
  };

  it('FAILS when only a bare prompt is on screen', () => {
    // RED-BEFORE (observed): the prior check was `capture-pane ... | grep -qE '.'`, which
    // MATCHED this bare prompt and broke out of the retry loop as if the task had landed.
    const out = runPaste(`pane() { printf '%s\\n' '❯ '; }\n`);
    expect(out).toMatch(/LANDED=0/);
    expect(out).toMatch(/never landed/i);
  });

  it('PASSES on the real task text', () => {
    const out = runPaste(`pane() { printf '%s\\n' '❯ Multi-line task description here'; }\n`);
    expect(out).toMatch(/LANDED=1/);
    expect(out).not.toMatch(/never landed/i);
  });

  it('PASSES on the "Pasted text" marker', () => {
    const out = runPaste(`pane() { printf '%s\\n' '❯ ' '[Pasted text #1 +42 lines]'; }\n`);
    expect(out).toMatch(/LANDED=1/);
  });

  it('issues Enter exactly once, and only after the verification', () => {
    const fence = pasteFence();
    const enters = fence.match(/tmux send-keys -t claude-del Enter/g) ?? [];
    expect(enters).toHaveLength(1);
    expect(fence.indexOf('landed')).toBeLessThan(fence.indexOf('send-keys -t claude-del Enter'));
    expect(fence.indexOf('send-keys -t claude-del Enter')).toBeLessThan(fence.indexOf('await_start'));
  });
});
