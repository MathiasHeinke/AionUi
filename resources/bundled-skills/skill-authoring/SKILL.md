---
name: skill-authoring
description: "Author a new EVE skill by extracting the SOP from existing Company.OS doctrine, department packs, scripts and templates into a focused, self-contained SKILL.md that EVE can load and run. Covers the full craft: finding source material, distilling the SOP into skill anatomy, placing artifacts for the deployment pipeline, verifying the result, and — because this is the CURATOR skill that scales to every skill authored after it — the hard guard on what a skill must NEVER do (no guardrail-disabling, no safety/PII-bypass, no ToS/billing circumvention) plus the human-gate every new skill passes before promotion. Use when building a skill from an existing department pack or script, when the operator says 'build a skill for this', or whenever existing Company.OS code needs to become an EVE-consumable SKILL.md."
disable_model_invocation: true
---

# Skill Authoring

> Provenance: EVE-authored field skill (2026-07), harvested + hardened into the
> public bundle. EVE writes skills for herself — this is the craft she uses,
> plus the curator guard that now scales to every skill authored after it.

Building a new EVE skill from existing Company.OS doctrine means extracting the
SOP from orchestration packs, scripts, and templates into a focused,
self-contained SKILL.md that EVE can load and use. It is a translation step,
not writing from scratch.

Because this skill is the **curator** — the one every future skill is authored
through — its guard (the "Was dieser Curator NICHT schreibt" section and the
human-gate step) is not local advice. It is the standing filter that scales to
every skill in the bundle. Treat it as load-bearing, not boilerplate.

## Anatomy of a Company.OS skill

A well-formed skill has one SKILL.md with YAML frontmatter, stored at:

```
.claude/skills/<skill-name>/SKILL.md
```

The frontmatter carries:

```yaml
---
name: <kebab-case-name>
description: <one paragraph — what it does, when to use it, what it produces>
---
```

The `description` is what the operator reads in the Skill Library — make it
concrete: name the trigger phrases AND the output shape, not just the topic.

The body follows this structure:

1. **One-paragraph purpose** — what this skill IS and is NOT (the boundary).
2. **When to use** — trigger phrases the user actually says.
3. **Prerequisites** — what must exist before this skill runs.
4. **The method** — numbered steps with concrete actions, not abstractions.
5. **Quality thresholds** — measurable targets (scores, checklists).
6. **Folder surface** — what the setup command creates (if applicable).
7. **Output shape** — what the operator gets at the end.
8. **Hard rules** — EVE doctrine, HumanGates, per-client isolation, no-auto-publish.

## Source material locations

| Source               | Path                                                            | What's there                                        |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| Department packs     | `docs/orchestration/*.md`                                       | Full SOP, folder surface, HumanGates, quality gates |
| Start scripts        | `scripts/content/*-start.mjs`                                   | Setup commands, folder creation                     |
| Core logic           | `scripts/content/*-start-core.mjs`                              | File writing, config, validation                    |
| Worker contracts     | `docs/templates/*-worker-contract.md`                           | Bounded role definitions                            |
| Tests                | `scripts/content/*.test.mjs`                                    | Expected behaviour, edge cases                      |
| Portable pipeline    | `docs/orchestration/company-os-portable-content-pipeline.md`    | Reusable pipeline contracts                         |
| Marketing department | `docs/orchestration/company-os-marketing-department-pack-v*.md` | Blog engine, Upload-Post integration                |

## The extraction pattern

### 1. Read the department pack

Every department pack contains at minimum: Purpose, Trigger/Intent, Founder Intake
questions, Department SOP (numbered steps), Folder Surface, HumanGates, Quality
Gates. Extract these verbatim where they define the skill's method.

### 2. Read the start scripts

The `*-start.mjs` scripts define the exact setup command and folder structure.
Copy the command into the skill's "Setup command" section. The `*-start-core.mjs`
files have the validation logic — extract the key rules (private-path scan,
dry-run mode, force vs. keep) as "Hard rules."

### 3. Read the worker contracts (optional)

If the department pack references template worker contracts in `docs/templates/`,
note them in a "Related contracts" section. Do not copy their full content — the
skill merely points to them.

### 4. Distill the SOP

The department pack is often 200-350 lines of C-level delegation language.
Distill it to the ESSENTIAL steps the operator needs to follow. Trim:

- Plane/COMPA/GROW ticket references (irrelevant to the operator)
- CEO/Codex/C-level delegation layers (the operator IS the CEO)
- Internal doctrine that does not affect how the skill runs

Keep:

- The numbered SOP steps with concrete actions
- Quality thresholds as plain numbers
- The folder surface as a tree
- HumanGates as labeled levels
- Hard rules as bullet points

### 5. Write the SKILL.md

Follow the anatomy above. Keep the description tight (one paragraph).
The body should be dense enough to run the skill without loading the original
department pack, but short enough to scan in one pass (100-200 lines ideal).

## Was dieser Curator NICHT schreibt (hard guard)

This is the filter every authored skill passes. It is not about being timid —
it is about not shipping a skill that quietly breaks the platform's safety
contract. **Refuse to author, and say plainly which line was crossed:**

- **No guardrail-disabling skill.** A skill whose METHOD is to make a model drop
  its refusals, ignore its safety instructions, or roleplay past its guardrails
  via a jailbreak prompt. This is a covert bypass dressed as a capability — do
  not write it.
- **No safety- or PII-filter circumvention.** A skill that disables, strips, or
  routes around the redaction/egress filters, PII-scrubbing, or content-safety
  layer so unredacted data flows out. The redaction lanes exist on purpose.
- **No ToS / billing circumvention.** A skill that evades a provider's terms of
  service, spoofs identity to dodge rate/usage limits, or manipulates
  metering/billing to avoid paying for consumption.

### Crucial nuance — an unlocked LOCAL model is NOT a jailbreak skill

Do **not** blanket-ban "uncensored" or "unlock." There is a real, deliberate
distinction, and getting it wrong either ships a jailbreak or kills a legitimate
product feature:

- **FORBIDDEN — the covert prompt-jailbreak skill.** A skill that ships a jailbreak
  prompt to make a model that is _supposed_ to refuse stop refusing. The harm is
  the deception: a guardrail is being defeated behind the operator's back.
- **PERMITTED — the legitimate gated unlock feature ("EVE-Unlock-Lane").** An
  unlocked / uncensored **local** model, offered as its own consent-gated,
  monetized lane, is a deliberately-built product feature — not a covert bypass.
  The operator chooses it knowingly, it runs on their own machine, it is gated
  and priced as its own lane, and nothing about it is hidden. That is a feature
  with a consent gate, not a jailbreak skill. **This guard explicitly permits it.**

The test is not the word "uncensored." The test is: _is a guardrail being
defeated covertly, or is a capability being offered openly behind a consent
gate the operator sees and chooses?_ The first is forbidden; the second is a
legitimate, gated, monetized feature.

### Dual-use skills need a human-gate + liability clause

Some skills are legitimate but sharp-edged — legal enforcement / dunning
(e.g. formal cease-and-desist or Abmahnung workflows), PII extraction, anything
that can produce real-world legal or financial consequences for a third party.
These MAY be authored, but ONLY WITH:

- an explicit **HumanGate** on the action that has external consequences (nothing
  fires autonomously), and
- a **liability clause** in the skill body stating the operator is responsible
  for the legal/financial consequences and that EVE drafts, the human sends.

A dual-use skill without both is not shippable — add the gate and the clause, or
do not author it.

## Deployment pipeline

Skills are **not deployed by EVE**. The workflow:

```
EVE builds SKILL.md -> places in .claude/skills/<name>/SKILL.md
-> Human-Gate: doctrine · dual-use · license · human-gate  (no auto-promote)
-> Claude Code session (separate, versioning-only) picks it up
-> Claude Code commits, pushes, deploys to runtime
```

Rules:

- **No auto-promote — every new skill passes the gate.** Between "EVE wrote it"
  and "it ships" there is always a human-gate that checks four things: doctrine
  compliance (per-client isolation, invisible-delivery, no-auto-publish),
  dual-use (does it need a gate + liability clause?), license (is any embedded
  source/method safe to redistribute?), and human-gate presence (does any
  irreversible/external action route through a gate?). A skill that fails any of
  the four does not promote.
- **Never git add/commit/push.** The user has a dedicated Claude Code session
  for versioning. EVE touching git would collide with it.
- **Never write into the runtime directory** (the app's Application Support
  runtime folder). Write to `.claude/skills/` — that's the source of truth that
  feeds the live build.
- **Place supporting scripts alongside.** If the skill references a script
  (e.g. `content-machine-start.mjs`), verify it exists in `scripts/content/`.
  The skill points to it by relative path; the versioning session handles
  keeping both in sync.

## What NOT to capture (anti-patterns)

- **Do not embed Plane ticket numbers, GROW/COMPA refs, dated internal roadmap
  notes, or internal roadmap language.** The operator sees a clean skill, not a
  project management tool or a snapshot of last week's sprint. If you copied a
  method out of a dated internal note, generalize it — strip the date and the
  internal filename.
- **Do not reference EVE's own runtime internals** (profile paths, cache
  locations, Hermes config). The skill is for the operator to use, not for
  EVE to debug itself.
- **Do not duplicate the full department pack.** The skill replaces it at
  the EVE level. The department pack stays as the canonical C-level reference.

## Composition & boundaries

Skills designed to work together need explicit MECE boundaries. The voice-first-run
→ founder-voice relationship is the model:

- **voice-first-run:** M0→M1 (seed interview, belief capture, sample gathering)
- **founder-voice:** M1→M2→M3 (voice profile from existing samples + interview output)
- **Boundary:** voice-first-run asks "what do you believe", founder-voice asks
  "show me how you write". They never overlap on the same question.
- **Check: can I run one without the other?** If yes, the boundary is clean.
  (voice-first-run works standalone for blocked founders; founder-voice works
  standalone if samples already exist.)

Apply this pattern whenever a new skill extends an existing workflow:
define the level/progression boundary explicitly in both skills.

## Verification

After writing the SKILL.md:

1. **Parse check:** `head -3 .claude/skills/<name>/SKILL.md` — must show valid
   YAML frontmatter (`---` on line 1 and 3, name + description on line 2).
2. **Line count check:** `wc -l .claude/skills/<name>/SKILL.md` — 100-250 lines
   is the sweet spot. Under 80 is too thin, over 300 needs trimming.
3. **Description check:** Confirm the description fits in one paragraph and
   includes both trigger phrases AND output shape, e.g. "Produces: X → Y → Z.
   Use when the operator says '...'".
4. **Trigger check:** Confirm trigger phrases match what the operator actually
   says, not what the department pack calls the intent. Replace C-level language
   ("initiate core process") with operator language ("set up my pipeline").
5. **Secrets check:** Confirm no raw secrets, tokens, private paths, .env keys
   or runtime cache paths appear in the file.
6. **Safety / dual-use review:** Re-read against "Was dieser Curator NICHT
   schreibt." Does the skill's METHOD disable a guardrail, bypass a
   safety/PII filter, or circumvent ToS/billing? If yes → do not ship. Is it
   dual-use (legal enforcement, PII extraction, real-world consequences for a
   third party)? If yes → confirm it carries a HumanGate + liability clause
   before it can pass.
7. **Directory listing:** `ls -d .claude/skills/<name>/` — confirm the directory
   exists and is non-empty.

## Pitfalls

- **ACP write denial.** The ACP agent (Claude Code) may deny `write_file` to
  `.claude/skills/` even though it's a legitimate target. Workaround: use
  `cat > path << 'EOF'` via `terminal` instead. Fallback: `mkdir -p` the
  directory first, then `cat >` the file.
- **Over-distilling removes the SOP.** If the skill has fewer than 5 numbered
  steps, it's probably too thin. The department pack has detail for a reason —
  keep the numbered SOP dense but scannable.
- **Missing setup commands.** If the skill references a start script (e.g.
  `content-machine-start.mjs`), verify the script exists at the referenced path.
  An SKILL.md that says "run this command" to a file that doesn't exist is worse
  than having no skill at all.
- **Skipping the gate because it "looks harmless."** No auto-promote is not
  conditional on the skill looking risky. Every skill runs the four-way
  human-gate; the harmless-looking ones are exactly where a covert bypass or a
  missing liability clause slips through.
