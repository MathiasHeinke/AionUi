---
name: brainstorm-divergent
description: COLD, open-ended divergent idea generation — produce MANY genuinely-different ideas, angles, or approaches for a goal (not minor variations on one), then cluster the field and hand the best candidates downstream for selection. Forces real divergence with multiple lenses (different customers, channels, business models, analogies from other industries, constraints-removed, first-principles, inversion), runs quantity-then-quality with judgment deferred, then clusters and feeds the strong clusters to option-tournament / decision-brief. Use when the user says "give me ideas", "brainstorm this", "what are all the ways", "I'm stuck / out of angles", "blue-sky this", or before any selection step when the option field doesn't exist yet. DISTINCT from option-tournament (which SELECTS a winner from a bounded fork) — brainstorm-divergent GENERATES the wide field that option-tournament then judges.
---

# Brainstorm Divergent

Selection tools choose well from a field — but only as well as the field is wide. `option-tournament` judges a
bounded fork; nothing _generates_ it. This is that generator: **cold, open-ended divergence** that produces
**many genuinely-different ideas** for a goal — different _in kind_, not three rewordings of the first thought —
then clusters them and hands the strong clusters downstream to be selected. The discipline is **quantity first,
judgment deferred**: the field is the product here, and a field of near-duplicates has taught you nothing.

Works in **DE and EN** — match the operator's language. Honesty wall: a "divergent" set that's secretly one idea
six ways is a failure dressed as work — if two lenses collapse into the same idea, kill one and push for a real
alternative.

## When to use

- When the user says "give me ideas", "brainstorm this", "what are all the ways to…", "I'm out of angles", "blue-sky it", "I'm stuck on this".
- **Before any selection step** when the option field doesn't exist yet — you can't run `option-tournament` or write a `decision-brief` on options no one has generated.
- When a problem has a **wide solution space** and the operator is anchored on the first one or two ideas (most founder choices are made from a field of three; this widens it before narrowing).
- NOT for narrow/closed problems with one right answer, and NOT the selection step itself — generate wide here, then hand off to `option-tournament` to judge and pick.

## The method

**Defer judgment.** No evaluating, ranking, or "yes-but" during generation — judgment now kills the weird idea
that becomes the best one. Generate first, sort later.

1. **FRAME the goal as a wide question.** State the actual job to be done ("how might we reach the solvent buyer
   who already tried ChatGPT and gave up") — broad enough to admit different _kinds_ of answer, specific enough to
   aim at. A frame too narrow pre-selects; a frame too vague produces mush.
2. **GENERATE across DISTINCT divergence lenses** — each lens is a different _door into the problem_, not a
   restyling of the last idea. Push hard on at least several of:
   - **Different customers / segments** — who else has this problem, in a form you're ignoring?
   - **Different channels** — every plausible way to reach them, including the ones you'd dismiss.
   - **Different business models** — same value, radically different shape (service / product / marketplace / subscription / done-for-you).
   - **Analogies from other industries** — how does a _completely_ different field solve the structurally-same problem? Steal the mechanism.
   - **Constraints removed** — "if budget / time / headcount / the rules were no object, then…" — then drag the best of it back to reality.
   - **First-principles** — strip to what's physically/economically true and rebuild from zero, ignoring how it's "always done."
   - **Inversion** — how would you make this goal _fail_ completely? Invert each failure into an idea.

   When the goal is consequential, fan the lenses out as **blind parallel generators** (one lens per sub-agent,
   blind to each other) through Hermes so the field is genuinely varied, not one mind's reflex.

3. **PUSH FOR QUANTITY, then quality.** Go past the comfortable stopping point — the first ideas are the obvious
   ones; the non-obvious ones come after the well feels dry. Quantity is a means: a wide field is what makes the
   later selection meaningful. Only after the field is wide do you let quality back in.
4. **CLUSTER the field.** Group the raw ideas into a handful of distinct _approaches_ (drop the exact dups, keep
   the productively-weird). Name each cluster by its underlying bet, and pull the **2–4 strongest, most-different
   candidates** forward — the ones worth actually deciding between.

## Output

- The **raw field grouped by lens** (so the spread is visible) — proof the divergence was real, not cosmetic.
- The **clusters**, each named by its underlying bet, with the near-duplicates collapsed.
- The **2–4 strongest, genuinely-different candidates** pulled forward — the shortlist to hand downstream.
- An explicit **handoff**: pipe the shortlist into `option-tournament` (to judge and pick a winner) or `decision-brief` (to turn it into one call). Generation ends here; this skill does not select.

## Key discipline

- **Defer judgment during generation.** No ranking, no "that won't work" until the field is wide. The premature "no" is where good fields die.
- **Diverge in KIND, not degree.** Six variations of one idea is not a field. If two lenses produce the same idea, replace one and push for an actually-different door.
- **Quantity is a means, not the point.** Go wide _so that_ the selection downstream is real — a wide field of junk still needs the clustering pass to earn its keep.
- **Generate, don't select.** This is the upstream feeder. The moment you start picking a winner, you've left this skill — hand the shortlist to `option-tournament`.

## EVE Runtime Link

Shared Command EVE posture lives in `eve-doctrine`; this section only explains how this skill plugs into the runtime.
This is the **upstream feeder** to `option-tournament` — it opens the solution space so EVE narrows from a wide,
honestly-divergent field instead of from the operator's first three ideas.

- **EVE runs the divergence.** EVE frames the goal, fans the lenses out as blind parallel generators through
  Hermes (one lens per sub-agent), clusters the field, and hands back the shortlist as a saved artifact.
- **Feeds the selection chain.** Brainstorm-divergent **generates** → `option-tournament` **judges and picks** →
  `icp-persona-panel` **checks it lands with the buyer** → `decision-brief` **compresses it to one call**. This
  skill is step one; never let it pretend to be the decision.
- **Alois on his own goals first, then clients.** Alois runs it to widen his own thinking on offer/channel/angle
  before he commits, then points the same divergence at each **client's** campaign or positioning problem — so
  every choice downstream is made from a real field, inside the version it serves (`plan-system`).
