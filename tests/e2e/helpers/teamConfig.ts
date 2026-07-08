// E2E test infrastructure — public Team Create intentionally exposes only
// Command EVE. Raw Claude/Codex/Gemini lanes are Hermes-controlled internals,
// not user-selectable team leaders.
const PUBLIC_LEADER_TYPES = new Set(['command-eve']);

// Support TEAM_AGENT=command-eve for compatibility with older invocations.
// Values are validated against the public list; unknown raw worker values are
// silently dropped so legacy TEAM_AGENT=claude/codex/gemini runs skip instead
// of re-opening internal lanes in the UI contract.
const envLeaderTypes = process.env.TEAM_AGENT;

export const TEAM_SUPPORTED_BACKENDS: ReadonlySet<string> = envLeaderTypes
  ? new Set(
      envLeaderTypes
        .split(',')
        .map((s) => s.trim())
        .filter((t) => PUBLIC_LEADER_TYPES.has(t))
    )
  : PUBLIC_LEADER_TYPES;

export const TEAM_PUBLIC_LEADER_TYPE = 'command-eve';

// Long-running, model-backed team-agent workflows are opt-in. The deterministic
// release E2E lane covers public UI contract, CRUD and workspace affordances.
export const RUN_TEAM_AGENT_LIVE = process.env.RUN_TEAM_AGENT_LIVE === '1';
