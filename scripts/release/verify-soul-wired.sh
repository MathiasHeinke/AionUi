#!/usr/bin/env bash
# Command EVE — SOUL-1 live check: prove SOUL.md actually reaches the running agent.
#
# The doctrine (1.1.7) says "one live check decides if the whole soul/onboarding
# doctrine ships or silently no-ops." This script IS that check. It verifies the
# end-to-end wiring statically against the real source + the bundled hermes wheel,
# so a regression (a thin soul, a dropped write, or the ACP chat lane disabling
# context files without keeping the soul) fails CI instead of silently shipping an
# identity-less agent.
#
# The chain it proves:
#   1. The desktop WRITES a RICH SOUL.md (the Operator frame + honesty wall), not
#      the old 5-line capability stub, to $HERMES_HOME/SOUL.md per seat.
#   2. The bundled hermes agent's system-prompt builder LOADS it, gated by
#      `load_soul_identity OR NOT skip_context_files`.
#   3. The ACP (chat) lane the desktop user talks to builds the agent WITHOUT
#      forcing skip_context_files=True — so the gate stays TRUE and the soul loads.
#
# Exit 0 = the soul is wired; non-zero = a broken link (printed).

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
ROOT="$(pwd)"
BOOT="packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts"
WHEEL="$(ls resources/bundled-hermes/hermes_agent-*.whl 2>/dev/null | head -1)"

fail=0
pass() { printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; fail=1; }

echo "== SOUL-1 live check =="

# --- 1. The desktop writes a RICH SOUL.md ---------------------------------------
if [ ! -f "$BOOT" ]; then bad "runtimeBootstrapCore.ts not found at $BOOT"; fi
if grep -q "writeFileSync(path.join(paths.hermesHome, 'SOUL.md')" "$BOOT" 2>/dev/null; then
  pass "desktop writes \$HERMES_HOME/SOUL.md (per-seat)"
else
  bad "no writeFileSync of \$HERMES_HOME/SOUL.md in the bootstrap"
fi
# Richness: the deliberate anchors must be present, and it must not be a tiny stub.
soul_lines=$(awk '/EVE_SOUL_MARKDOWN = `/{f=1} f{c++} /^`;?$/{if(f){print c; exit}}' "$BOOT" 2>/dev/null)
soul_lines=${soul_lines:-0}
if [ "$soul_lines" -ge 40 ]; then
  pass "EVE_SOUL_MARKDOWN is rich (${soul_lines} lines, not the 5-line stub)"
else
  bad "EVE_SOUL_MARKDOWN looks like a stub (${soul_lines} lines, expected >= 40)"
fi
for anchor in "The Operator" "FACT / INFERENCE / HYPOTHESIS"; do
  if grep -qF "$anchor" "$BOOT" 2>/dev/null; then pass "soul anchor present: \"$anchor\""; else bad "soul anchor MISSING: \"$anchor\""; fi
done

# --- 2 + 3. The bundled hermes agent loads it, and the ACP lane keeps the gate ---
if [ -z "$WHEEL" ] || [ ! -f "$WHEEL" ]; then
  bad "bundled hermes wheel not found under resources/bundled-hermes/"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  if unzip -qo "$WHEEL" -d "$TMP" 2>/dev/null; then
    GATE="$TMP/agent/system_prompt.py"
    SESS="$TMP/acp_adapter/session.py"
    # 2. the load gate exists.
    if grep -q "if agent.load_soul_identity or not agent.skip_context_files:" "$GATE" 2>/dev/null \
       && grep -q "load_soul_md()" "$GATE" 2>/dev/null; then
      pass "wheel loads SOUL.md (gate: load_soul_identity OR NOT skip_context_files)"
    else
      bad "wheel system_prompt.py gate / load_soul_md() not as expected"
    fi
    # 3. the ACP lane must NOT force skip_context_files=True (that would drop the
    #    soul unless it also set load_soul_identity=True, which it does not).
    if [ -f "$SESS" ]; then
      if grep -qE "skip_context_files\s*=\s*True" "$SESS" 2>/dev/null \
         && ! grep -qE "load_soul_identity\s*=\s*True" "$SESS" 2>/dev/null; then
        bad "ACP session.py forces skip_context_files=True WITHOUT load_soul_identity=True -> soul DROPS"
      else
        pass "ACP lane keeps the gate TRUE (no skip_context_files=True, or paired with load_soul_identity=True)"
      fi
    else
      bad "acp_adapter/session.py not found in the wheel"
    fi
  else
    bad "could not unzip the hermes wheel"
  fi
fi

echo "== $([ $fail -eq 0 ] && echo 'SOUL IS WIRED — the agent loads its identity' || echo 'BROKEN — see FAIL lines above') =="
exit $fail
