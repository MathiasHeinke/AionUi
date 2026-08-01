# MAT-1747 — the agent knows about the artifacts the user can see (Variant C)

**Date:** 2026-08-01 · **Status:** implemented on the desktop side, spending path default-off

> **CORRECTION OF RECORD — round 8 supersedes the `c330f32f` commit message on
> three points.** That message is immutable without an amend, so it still reads
> as originally written; where the two disagree, **this document is the record**.
>
> 1. It says the permit is bound to "the SHA-256 of the raw user turn — the exact
>    bytes, with no trim" and that a correction "moves the turn pointer to the
>    steer's own **raw** bytes". The second half is **false**: `AcpSendBox` sends
>    `steerText: normalizedInput`, i.e. trimmed. The raw-byte rule holds for the
>    **ordinary send path only**; the correction path binds the bytes **delivered
>    to the runtime**. See **C2d-bis**.
> 2. It describes the envelope-entry builder's source as having "no baseline in
>    any commit, stash or worktree". Post-`c330f32f` the accurate statement is
>    that the file is **new in that commit with no parent predecessor**. See
>    **gap 3d-bis**.
> 3. It leaves "the model addresses them through read-only capability handles"
>    to imply the tokens are incidental. They are **intentionally model-visible
>    opaque capability tokens** — the mechanism, not a leak. See **C1-bis**.

## The defect

Managed video generation is a direct renderer → IPC → gateway call. In the send
path's own words, *no message is sent to the agent for a managed video request*.
So the clip exists on disk, the renderer can play it, and the agent knows nothing
about it. A perfectly ordinary follow-up — "gib der Aubergine ein Gesicht" — has
nothing to refer to.

## What was rejected, and why

**A hidden turn that announces the artifact.** It costs an inference call per
artifact, and it writes sentences into the transcript that nobody said. The
transcript is the thing later turns reason over, so inventing dialogue there is
not a cosmetic problem. The code for it — `buildVideoArtifactEventTriple` and the
whole `agentArtifactContextCore` module that existed only to serve it, including
its id-based `resolveEditSourceArtifact` which handles superseded — has been
**deleted**, not left dormant. A rejected design kept in the tree is a design
someone reaches for later.

**A local keyword classifier.** With the cost wall gone (asking for a video *is*
the authorisation), a false positive routes an ordinary message into the paid
lane with nothing behind it to catch the mistake. `videoCostCore` already says
this about its own regex in its own comments — the fail-safe gate there exists
precisely to stop the regex being the sole decider.

**A "latest artifact" fallback.** It would spend real credits on a clip the user
never named. `tests/unit/command-eve/videoEditResolutionIsSemantic.test.ts` fails
if either of these ever reappears on the resolution path.

That gate now covers twelve modules including the loopback handler and the MCP
server process, and bans twenty-one string-matching and pick-the-last-clip
constructs rather than the handful it started with — `toLocaleLowerCase`,
`.indexOf(`, `.match(`, `.test(`, `startsWith`, `RegExp` and regex literals all
used to walk through it. Both numbers are the length of the lists in
`videoEditResolutionIsSemantic.test.ts` and are meant to be read against it, not
taken on this paragraph's word. The modules were
rewritten to do their shape checks with character scans (`eveOpaqueTokenCore`),
which is what lets the ban be flat: a structural test cannot tell a shape check
from a keyword classifier, and one that tried would be arguing with itself.

## What was built

### C1 — the envelope rides an existing turn

`buildCommandEveAgentTurnInput` (`eveArtifactContextEnvelopeCore.ts`) prepends a
sanitized artifact registry inside the **existing** `[[COMMAND_EVE_PREPARED_CONTEXT]]`
delimiters. `MessageText` already strips those at render time, so the displayed
message is byte-identical to what it would be **without** the envelope, and no
renderer change was needed. (Stated that way rather than "identical to what the
user typed", which was the earlier wording and is not quite true of either build:
`stripCommandEvePreparedContext` has always `trimStart`ed every message it
renders. Adding the envelope does not change that; claiming it restores something
it never did would be a claim in the wrong direction.) A conversation with no
artifacts produces `''` and is unchanged down to the character — the feature
costs nothing until it has something true to say.

One deliberate exception to "unchanged": the strip now also redacts anything
shaped like a capability credential on the way out, so a message that literally
contained `something_<64 hex>` renders with the hex replaced. That is a defence
for the abnormal case — an unterminated block, a model quoting its own context
back — and it is a real, if very narrow, change to what a message can display.

`buildCommandEvePreparedAgentInput` was deliberately **not** modified: an upstream
impact check rates it HIGH, and it carries a file-analysis routing contract that
must not fire on every turn. The envelope is its own block instead.

Contents: artifact id, kind, mime, duration, editable, capability handle, parent.
Bounded to 24 artifacts and 6000 characters, newest first, every value run
through `neutralizeContextBoundaries` so a title cannot forge a delimiter.

#### C1-bis — what the model may see, and what it may never see

An earlier version of this record wrote "**Not** in it: … credentials", which is
muddled: two of the things the envelope carries *are* credentials, on purpose.
Stated cleanly, because a reader who believes the wrong half will either treat a
design decision as a leak or treat a leak as a design decision.

**INTENTIONALLY MODEL-VISIBLE — this is the mechanism, not a leak:**

- `edit_handle` — an opaque capability token per editable clip. The model is
  *supposed* to hold it and quote it back; that is how a follow-up names a clip
  without a filesystem path existing anywhere in the conversation. Read-only
  authority, scoped to one conversation and one set of bytes, expiring.
- the **ephemeral spend capability** (`evespend_…`) — one per turn at most, only
  when a paid capability is actually advertised. Single-use, minutes-long,
  bound to the turn. The model holds it for exactly as long as one turn lasts.

Both are bounded rather than hidden. The defence is what a token can *do* —
scope, lifetime, single use, revocability — not who is able to read it.

**FORBIDDEN on any model-visible surface — the real no-list:**

- filesystem paths of any kind (this is also why the MCP lane returns an artifact
  id and not the `MEDIA:` line — see C5 and gap 3d);
- provider auth, licence wire, session authentication — nothing replayable
  against a third party or against our own gateway;
- seat ids (and user ids): identity, not capability;
- raw provider keys;
- and, separately from the auth list: bytes, `data:` URLs and the conversation id.

**Proof, both halves, by name.**

*(a) Redaction of the user-facing artefacts actually strips what it claims to* —
`tests/unit/command-eve/artifactCapabilitySecretsStayPrivate.test.ts` (4 cases)
covers the three doors that read message content differently: the rendered
transcript (`stripCommandEvePreparedContext`), the conversation **export**
including its structured JSON fallback that never met the strip
(`readMessageContent`, which the auto-title lane also reads through), and the
**support bundle** (`buildSupportBundleSummary`, HMAC fingerprints only,
`raw_log_content_included: false`). Each case carries a positive control proving
the credential really was present before the redaction ran. This is about
artefacts that outlive the turn and travel to other people — not about hiding
anything from the model.

*(b) The tool surface is scoped as described* —
`tests/unit/command-eve/eveArtifactToolSurface.test.ts` (16 cases) pins that
`eve_video_edit` is absent from the advertised tool list whenever the flag is
off, so the model is never offered a capability the handler would refuse;
`tests/unit/command-eve/eveArtifactContextEnvelope.test.ts` (16 cases) pins what
the envelope may and may not contain; `artifactCapabilityLoopback.test.ts` (14
cases) pins that the model-facing tool result is built from four named fields and
carries no filesystem path, with a positive control proving the handler did
return a path-bearing directive; and
`tests/unit/command-eve/videoEditResolutionIsSemantic.test.ts` (32 cases) bans
keyword-classifier and pick-the-last-clip constructs across twelve modules
including the loopback handler and the MCP server process.

### C2 — a handle says WHICH clip; it does not say "you may spend"

A conversation id is guessable and a model can invent one, so it can never be
treated as proof. Main mints `evecap_<64 hex>` (32 bytes from `crypto.randomBytes`)
bound to `(conversation, artifact, artifact sha256, operation)`, stores it 0600
under a filename that is the SHA-256 of the handle, and emits it only into the
envelope of the conversation it belongs to. Handles are reused per artifact, not
minted per turn — otherwise every turn would create another live key. TTL 14 days,
swept on mint.

Resolution refuses, before any spend, on: malformed handle · unknown handle ·
wrong conversation · wrong operation · bytes changed on disk. The bytes are
hashed **by the caller, from what it actually read and is about to send**, so
there is no time-of-check/time-of-use window between the check and the upload.

A handle is never minted for a clip that is not editable, so its presence is
already the statement that the 8.7-second ceiling and the tier eligibility were
checked.

**Correction, after independent review.** The first build made possession of this
handle *sufficient* for a paid edit. That was wrong, and the reasoning that
produced it — "possession is the proof" — is only sound for a credential that is
scarce. This one is not: it rides every turn's envelope, is shipped to a
third-party model API, is persisted in transcripts, lives fourteen days and has no
revocation. It is the right authority for a **read** and an unacceptable one for a
**charge**. Handles are therefore now read-only authority; see the spend permit
below.

The handle store's own header used to claim that hashing the filename kept the
secret out of a backup. It does not — the grant body holds the handle in
cleartext, and it must, because the envelope re-emits it every turn. The comment
now says so.

### C2b — the ephemeral single-use SPEND PERMIT

The founder decided there is **no confirmation popup** for image and video
actions. That decision bounds what a paid action may *ask*; it does not license a
reusable key to one, and it does not license an unbounded loop. What replaces the
popup is a permit, not a prompt:

`evespend_<64 hex>` (`eveVideoEditSpendPermitCore.ts`, `videoEditSpendPermitStore.ts`)

- **bound server-side** to the conversation, the operation, the SHA-256 of the
  **raw ordinary user turn** — the exact bytes, with no trim, case fold,
  line-ending or Unicode normalisation anywhere between the IPC boundary and the
  digest — and the exact artifact bytes visible in that turn's envelope. **The
  scope of that sentence is the ordinary send path**, which is the only path that
  mints; the correction path binds something different and is described in C2d
  and C2d-bis;
- **that turn hash is re-compared at redeem** against the conversation's current
  turn, which the send path records on every turn that builds a context envelope,
  whether or not it mints anything. A permit whose turn has passed fails closed.
  (Round 1 stored the hash and never read it; an independent audit called that
  correctly — a field written and never checked is not a binding.);
- **and a mid-run CORRECTION retires it outright.** See C2d below. This is the
  round-3 correction, and it is here because round 2 wrote "the turn pointer
  moves on every real send" when it moved on every *enveloped* send. A steer is
  real text that the agent reads, and it moved nothing;
- **TTL 15 minutes**, not 14 days;
- **one live permit per conversation** — minting retires the previous turn's, so
  permits cannot be banked across turns and spent in a burst;
- **one spend per user turn, atomically** — the turn itself is claimed with an
  exclusive `wx` create keyed on (conversation, raw-turn hash). Re-driving the
  mint path for a turn that has already spent yields **no** permit, and two
  permits minted for one turn cannot both be consumed. Round 1 relied on the
  renderer minting once, which is not an enforcement;
- **consumed atomically** by an exclusive `wx` create *before* the provider call.
  Not a read-then-write: that pattern is exactly how two concurrent arrivals both
  conclude the permit is unused;
- **one in flight per conversation**, via a second `wx` lock with a 240s stale-lock
  reclaim so a crash costs one wait rather than a permanently dead lane;
- **same permit + different instruction ⇒ refused.** This is the closure of the
  varied-instruction loop: one user turn buys one paid edit, and a second
  variation needs the person to ask for a second variation;
- **same permit + same instruction ⇒ the first result**, replayed from a receipt.
  Failing closed must not mean a dropped response costs the user both their turn
  and their money.

Unlike the handle store, the permit store contains **no secret at rest**: records
are filed under the digest and the permit value appears in no file body, because a
permit is emitted once and never has to be recovered.

**What the permit does NOT prove**, stated because round 1 claimed it did: it does
not prove a human pressed send. Main cannot observe an active turn on the pinned
AionCore, and the mint path is an IPC handler — the renderer is the only caller,
and the model's MCP loopback exposes no mint operation at all, so a model cannot
obtain one for itself. That is a property of the exposed surface, not of a check
in the mint path. The bindings above are the strongest available proxy for "the
user just asked": exact turn bytes, single use, one spend per turn, minutes-long
life, re-compared against the conversation's current turn at redeem.

### C2c — one gate, both lanes

The flag and the permit are enforced inside `handleCommandEveVideoEdit`, which is
the single handler behind **both** the renderer IPC provider
(`command-eve.video-edit`) and the MCP loopback. The first build checked the flag
only in the loopback wrapper while `commandEveBridge` registered the identical
paid handler with no gate at all. A gate that lives in one lane's wrapper is not
a gate.

### C2d — a mid-run correction is a real turn, and now behaves like one

Round 2 claimed "the turn pointer moves on EVERY real send". It did not. A STEER
— the correction a user types while the model is still working — does not go
through the send path that builds a context envelope; it is an HTTP call straight
to the runtime (`/api/conversations/<id>/steer`). It is real text, the agent
reads it, and it moved nothing. So the previous turn's permit survived the person
saying something else, and the sentence on the box was wider than the code
underneath it. That is the defect class this whole remediation exists to stamp
out, arriving in the remediation itself.

`revokeVideoEditSpendOnUserSteer` closes it, from `dispatchSteer`, **before** the
correction reaches the run. Three effects, because the first two are both
operations that can fail:

- every still-live permit for the conversation is **revoked** — the load-bearing
  half;
- the turn pointer moves to the steer's own bytes **as delivered to the runtime**
  — which catches a revoke whose `unlink` failed. (The pointer alone would not be
  enough: a steer whose text is byte-identical to the minting turn would not move
  it. The revoke alone would not be enough: an `unlink` can fail. Each covers the
  other's case, and `videoEditSteerRevokesPermit.test.ts` has a case for each.)
  An earlier version of this line said "raw bytes" and that was **wrong**; see
  C2d-bis.
- the conversation is **denied** — round 4, see C2e. Deleting a file and writing a
  pointer are both things that can fail; *not spending* is not.

**Nothing is minted here**, and that is the shape of the answer rather than an
omission. A steer carries no envelope, so a permit minted for it could be shown
to nobody. After a correction the conversation therefore has **no** spend
authority at all until the person sends an ordinary message. Asking for a paid
edit *in* a steer is refused — the user is told to ask again, and asking again
mints. Refusing a correction is the cheap direction; charging for one is not.

### C2d-bis — the raw-byte invariant is TWO invariants, and saying it was one was an overclaim

**The finding, accepted.** `AcpSendBox.tsx` sends `steerText: normalizedInput` on
the retirement path — `normalizedInput` is `input.trim()`. Every sentence in this
record, in the commit message and in the source comments that claimed an
exact-raw-byte binding *across the board* was therefore false for that path.
The finding is correct and is not argued away.

**What was chosen, and why.** The claim is **SCOPED**, not unified. The two paths
were not made byte-identical, because they are answering two different questions
and one rule for both would make one of them wrong:

| path | mints? | binds | why that is the right binding |
| --- | --- | --- | --- |
| ordinary send | **yes** | the **exact raw user-turn bytes**, at mint and at redeem | a permit is the statement "the person asked for THIS". Normalising anywhere would merge two different requests into one authority |
| correction (steer) | **no — it retires** | the bytes **actually delivered to the runtime** | a retirement is the statement "THIS superseded it in the run". The recorded turn should be the turn the agent read |

Unifying was rejected on evidence rather than taste. `dispatchSteer` has no raw
value available to bind: both of its callers reach it through
`buildConversationBusyControlCommand`, which does **not** forward what the person
typed — it rebuilds the string as `/steer <trimmed args>`. Promoting a queued
message `"   mach den Hintergrund blau   "` delivers `"/steer mach den
Hintergrund blau"`, a command string the user never typed. Binding the pointer to
"raw keystrokes" would bind it to text the agent never saw, which is not a
stricter rule — it is a wrong one. Changing the correction transport to carry raw
bytes would also be re-opening settled, shipped send-box behaviour for no gain,
because the load-bearing defence on the steer path is the revoke plus the
**unconditional deny** (C2e), neither of which reads the pointer.

**The cost of the scoped rule, stated.** A correction differing from the minting
turn only in leading or trailing whitespace does not move the pointer. That case
is covered twice over by the revoke and the deny, which is exactly why the
pointer is documented as the backstop and not the defence.

**Proved at the real seam, not on a helper.** Six cases in
`tests/unit/renderer/AcpSendBox.dom.test.tsx` (in the round-5 production-route
suite) drive the real send box, the real bridge payload, the real Main handlers
and the real store:

- *ORDINARY TURN: the padded raw bytes reach the mint AND the runtime, and the
  pointer is those bytes* — `'   Hello   '` arrives at the mint IPC untouched,
  the string posted to the runtime **ends with** those same padded bytes, and the
  pointer on disk is `sha256('   Hello   ')` and provably not `sha256('Hello')`;
- *ORDINARY TURN: … spends exactly once — POSITIVE CONTROL* — the permit read out
  of the bytes the **model** received reaches the provider fetch and the debit
  once each, so the refusal below is not a broken fixture;
- *ORDINARY TURN: REDEEM is byte-exact too* — moving the pointer to the trimmed
  digest refuses the spend with **zero** fetch and **zero** debit. That is the
  "at BOTH mint and redeem" half;
- *CORRECTION: the retire and the runtime get the SAME bytes, and they are the
  trimmed ones* — leg 1 and leg 2 carry one value, and the pointer is its digest;
- *CORRECTION: a promoted queued command is REWRITTEN* — the delivered string is
  `/steer …`, and the pointer binds that rather than the padded queued text;
- *CORRECTION: whitespace never buys a spend back* — a whitespace-only variant of
  the minting turn still leaves a durable deny and still refuses with zero fetch
  and zero debit.

**Sabotage results, including the one that did not move.** Trimming the mint
binding (`userTurnText: input` → `input.trim()`) turns the two ordinary-turn
byte-exactness cases red. Decoupling the retire bytes from the delivered bytes
turns four correction cases red. And replacing `normalizedInput` with `input` at
the retire call leaves the suite **green** — recorded here rather than hidden,
because it is the measurement that proves the scoping decision: at that call site
the two expressions are already equal, so there is no raw value being discarded.

### C2e — a retirement that could not be stored retires the conversation instead

Round 3 shipped C2d with its failure path swallowed: if the revoke threw, the
correction went through and the permit stayed live, and the trade was written
down as "a permit that outlives one steer". Writing it down was honest. The trade
was not: it is **fail-open on spend authority** — local storage fails, and the app
silently keeps the ability to spend the user's credits against an instruction the
user has already superseded.

The rule is now **split**, not traded:

- the **correction** still goes through. `dispatchSteer` catches everything the
  retire IPC can do to it. A user fixing a running model is never refused because
  of a local file operation;
- the **paid edit authority** fails closed. Main holds a DENY state per
  conversation, and while a conversation is denied a video edit reaches neither
  the provider fetch nor the debit.

**Where it is checked.** `handleCommandEveVideoEdit` reads it through its injected
`isSpendDenied` (production-bound to `isVideoEditSpendDenied`), and both lanes —
the renderer IPC provider and the Hermes MCP loopback, which calls this same
function — pass through it. The check sits immediately after the grant fence: before the
source read, before retry recovery, before the permit judgement, before the
licence, before the in-flight lock, before the atomic consume, before `fetch`. It
is deliberately **not** derived from the permit record, because deleting that
record is exactly the operation whose failure raises the deny. A throw while
reading it counts as denied: if the state cannot be established, the answer is no.

**Two tiers.**

| tier | where | survives a restart |
| --- | --- | --- |
| durable | `spend-permits/deny/<sha256(conversation)>.json` | yes |
| process | a module-level `Set` in main | **no** |

The process tier is the last resort for the case where writing the durable marker
is *itself* what failed. Its limit is stated plainly rather than softened: a
process-scoped deny is lost on app restart, and it is not shared with any other
process. `videoEditSpendDeny.test.ts` asserts that loss instead of describing it
away. Round 5 removes the *consequence* of that loss rather than the loss itself —
after a restart there is no live permit left to revive, because **C2f** deletes
every one of them and refuses the paid path until it has proven that.

**What raises a deny.** Every steer that reaches a store which exists (not only a
failing one — after a steer the conversation has no spend authority anyway, so
denying unconditionally is the already-documented semantics with one fewer thing
to get wrong); a store we cannot even `existsSync`; a `getDataPath` that throws; a
throw out of the retire; a turn-pointer write that did not land on the send path;
an unclean revoke or any throw inside `issueVideoEditSpendPermit`.

Two steer paths deliberately do **not** deny, and both are cases where no permit
can exist to begin with: a request that named no conversation, and a seat whose
permit directory has never been created. The second is load-bearing for the
default-off posture — with no store on disk there is provably no permit to retire,
so a steer on an untouched seat still writes nothing at all, which
`videoEditSteerRevokesPermit.test.ts` pins.

**What clears a deny — and only this.** `issueVideoEditSpendPermit`, at the very
end, after the previous permits were provably retired, the turn pointer is
provably on disk and the new permit record is written. That sequence *is* "a later
successful ordinary user send establishes fresh turn state and a new valid
permit". Not a timer: the deny marker lives in a subdirectory and both sweep loops
take `entry.isFile()` only, so `pruneVideoEditSpendPermits` cannot reach it. Not a
retry of the edit: the edit path only ever reads the state. Not app start.

**The cost, stated.** While a conversation is retired, the free-retry recovery
path is refused too — even though a recovered result spends nothing. Recovery is a
decision made out of the same local store whose write or delete just failed;
trusting it while distrusting everything around it would be incoherent. The clip
is already saved and listed, so this costs a refusal, never a charge.

**The residual this does not close.** The retire is a renderer→main IPC provider
(`AcpSendBox.tsx:783` → `commandEveBridge.ts:2155`, traced in §3c);
`ipcBridge.acpConversation.steer` is an HTTP POST from the renderer straight to
the runtime. They do not share a transport. An IPC layer that is down therefore
takes the retire with it and leaves the correction working — main never learns a
correction happened, and nothing in the renderer can tell it. Closing that needs
the same runtime→main `append_context_event`-class seam as gap 1.

### C2f — no live spend authority outlives its process (round 5)

**The defect.** C2e's process tier is lost on restart. If the durable write was
what failed, a restart forgets the deny while the permit record it compensated for
is still on disk, still inside its window, with a turn pointer that also survived —
and nothing notices. A second durable marker cannot fix this, because writing to
this store is the premise of the failure.

**The rule instead.** A restart invalidates spend authority outright.

| kind | files | on reinitialization |
| --- | --- | --- |
| live authority | `<permit>.json`, `turns/<conv>.active.json`, `inflight/<conv>.lock` | **deleted** |
| completed receipt | `<permit>.consumed.json`, `<permit>.result.json`, `turns/<conv\|turn>.spent.json` | **kept** |
| deny marker | `deny/<conv>.json` | **kept** (lives in a subdirectory; every sweep takes `entry.isFile()` only) |

Receipts are kept because they are the double-charge defence: a completed edit
whose response was lost must be answered from its receipt after a restart, not
billed again.

**The gate.** `reinitializeVideoEditSpendStore` records whether the sweep was
PROVABLE. A directory that does not exist is provably clean — an untouched seat is
never denied for having nothing. A directory we could not read, or an `unlink`
that refused, is not, and the store health becomes `denied`. A fresh process
starts at `unproven`, **not** `healthy`: the model's loopback can present a permit
string it remembered from before the restart without any user send happening
first, so a proactive sweep that has not run yet is a race, not a guarantee.
`handleCommandEveVideoEdit` refuses on anything but `healthy` — process-wide, in
every conversation, second only to the flag gate and therefore before the fetch
and before the debit. Both lanes enter that function, so neither can walk past it.

**What clears it — and only this.** A successful reinitialization. There are
exactly two callers: main-process startup (`process/index.ts`, after
`initStorage`), and `issueVideoEditSpendPermit` when the store is not yet proven —
which is the contract's "a fresh ordinary user send", implemented so the send
*proves* the store rather than merely happening. Because the sweep runs before the
mint writes anything, the permit minted by that send cannot be revived alongside a
pre-restart one. Not a timer: `pruneVideoEditSpendPermits` never touches health.
Not a retry of the edit: the edit path only reads it.

**Pinned by** `videoEditStoreHealthBoundary.test.ts` (nine cases, all asserting on
the fetch spy and the debit spy directly) and `videoEditStoreStartupWiring.test.ts`
(runs the real `initializeProcess`). Removing the gate, removing the mint-path
sweep, or removing the startup call each turns a different subset of them red with
a real provider fetch.

**The cost, stated.** Between a restart and the first sweep, a legitimate free
retry of a completed edit is refused rather than answered from its receipt. It is
a refusal, never a charge, and the startup call closes the window in practice.

### C3 — an app-owned capability, not a user connector

Verbatim the doctrine the managed image generator proved: an app-owned capability
goes into Hermes' private 0600 config, **not** through the external-connector
vault flag. `COMMAND_EVE_MCP_VAULT_ENABLED` is untouched — it gates
`resolveVettedMcpServersForBootstrap`, which is not on this path.

- `builtinMcp/eveArtifactContextServer.ts` — stdio MCP child exposing
  `eve_artifact_get`, `eve_artifact_list`, and — **only when the spending flag is
  on** — `eve_video_edit`. Every tool takes a capability handle; there is
  deliberately **no** "list by conversation id" call. Which tools exist is decided
  by `builtinMcp/eveArtifactToolSurface.ts` from the same flag the paid handler
  reads, and the config emits that flag to the child when the seat is open, so the
  tool list and the handler cannot disagree. Round 1 registered the paid tool
  unconditionally: the envelope was gated, the tool list was not, and every seat
  advertised a capability the app would refuse.
- `POST /eve/artifact/call` on the loopback shim, bearer-gated like the kanban
  routes (empty bearer ⇒ 404, so it is inert on an unprovisioned seat).
- The child holds no credential: it reads the 0600 bearer file and calls back into
  main, which owns the CEVE licence, the credit authority and the idempotency key.

`buildCommandEveRuntimeReconciliation` no longer hardcodes `mcp_servers: []` — the
config and the receipt are now rendered from **one** list, so they cannot disagree
about what the seat is running.

### C5 — the result lands beside the source

`buildVideoConversationArtifact({ …, originCapability: 'video_edit',
parentArtifactId: source.id })`. The source is never overwritten: a bad edit must
not be data loss. The new artifact appears in the **next** envelope.

The `MEDIA: <path>` line crosses **Main → renderer only**, and that was checked
rather than assumed when an independent review asked whether the value can reach
the model by *any* route:

- **tool result** — no. `artifactCapabilityLoopback.ts` builds its success
  payload from four named fields (`ok`, `artifact_id`, `parent_artifact_id`,
  `replayed`). It never spreads the handler's result and never reads
  `mediaDirective`, so no spelling of the model-facing response contains a path.
  `artifactCapabilityLoopback.test.ts` pins it with a positive control that
  proves the handler DID return a path-bearing directive;
- **envelope** — no. The envelope carries no paths by construction, and this
  value is not one of its inputs;
- **transcript / export / support bundle** — no. Nothing under
  `packages/desktop/src/renderer` reads `mediaDirective`; the renderer IPC
  provider that returns it has no consumer yet.

So it stays: inline playback in the renderer lane depends on it. `MEDIA:
/Users/<name>/Downloads/…` handed to a model would contradict the envelope's own
no-paths rule and ship the account name to a third-party API, which is why the
loopback returns an artifact id instead. That leaves a real, named consequence —
a clip produced through the MCP lane does not render inline in chat the way one
produced through the renderer lane does. It is listed under *Known gaps* rather
than papered over.

### C7 — one debit per approved edit

The gateway's ledger key is content-only, so the desktop stamps nothing that
distinguishes *how* the request arrived. The `requestId` is **derived** —
`sha256("command-eve-video-edit-request-v1|promptSha|tier|sourceSha")` — so the
cost-wall arrival and the Hermes tool-call arrival produce a byte-identical body.
A test compares the two bodies rather than trusting this paragraph.

## Known gaps — stated, not solved

These are open. None of them is closed by a comment claiming otherwise.

### 1. The loopback cannot prove which conversation the CALLER is in

This is the honest residual of the finding that opened this remediation. On the
pinned AionCore the MCP child receives no trustworthy conversation identity, and
nothing it could send would be one — anything the model writes is a claim.

What is enforced instead is a comparison between **records we wrote**: the grant
names a conversation, the permit names a conversation, they must match, and that
match now runs **before** retry recovery rather than after it — recovery is itself
conversation-scoped, and the recovered artifact is looked up in the grant's
conversation, never in the receipt's. Round 1 had this the other way round, which
let a conversation holding a byte-identical clip recover another conversation's
edit and its filesystem path.

The permit additionally names the exact turn it was minted for, is re-compared
against that conversation's current turn at redeem, and is single-use. So the
residual exposure is narrow and specific: a model holding a valid handle for
conversation A *and* the permit emitted into conversation A's envelope, while A is
still on that turn, can spend A's permit. It cannot spend without one, it cannot
spend twice, it cannot spend on a clip A never showed, and it cannot spend after
the person has said something else.

What would close it: a runtime-supplied caller identity — an AionCore
`append_context_event`-class substrate that stamps the conversation on the tool
call itself. That is a release-train change to a sha256-pinned binary, not a line
in this slice.

### 2. The source duration is provider-reported, never measured

`sourceDurationSeconds` comes from the stored artifact record, which came from the
gateway's echo of the provider. The **bytes** are sha-pinned; the **length** is
taken on trust. A record claiming 5s for a 12s clip would pass the 8.7-second
ceiling and misprice the local preview. The gateway re-derives the charge, so the
money is right — the local estimate and the ceiling are the parts that can be
wrong. Closing it means parsing the container (`mvhd`) or bundling a prober;
neither is in this slice.

### 3. A clip edited through the MCP lane does not render inline

See C5. Consequence of removing the filesystem path from the model-facing result.

### 3b. Two costs the turn binding deliberately accepts

Both fail closed, both are refusals rather than charges, and both are the price of
making the turn a real unit instead of a label:

- **A permit dies if the user says anything else while the model is still
  working** — an ordinary send moves the turn pointer, a mid-run correction
  revokes the permit outright (C2d). Either way an edit the model gets round to
  after the person has moved on is refused. That is the intended reading of "the
  request the user just made".
- **Retyping the identical sentence, in the same conversation, within the receipt
  window (~19 minutes) mints no new permit** once that turn has spent. Two sends
  of byte-identical text are indistinguishable to us: the only turn identity we
  have is the text itself. Treating them as one turn can cost a user a retry;
  treating them as two would let a re-drive buy a second edit, which is the defect
  being closed. Any different wording works immediately.

### 3c. The steer revoke is renderer-driven, and its failure is answered in main

**Which trusted process observes a correction — traced, not assumed.** Round 4
recorded "a steer has no main-process seam", and that sentence was too broad. A
correction is TWO transports leaving the SAME renderer function, and only one of
them is HTTP:

| leg | code path | who observes it |
| --- | --- | --- |
| 1 — the retire | `AcpSendBox.tsx:783` `ipcBridge.commandEve.artifactTurnSteer.invoke` → `@office-ai/platform` bridge → `preload/main.ts:24` `electronAPI.emit` → `ipcRenderer.invoke('office-ai-bridge-adapter')` → `common/adapter/main.ts:127` `ipcMain.handle` → provider registered at `process/bridge/commandEveBridge.ts:2155` → `handleCommandEveArtifactTurnSteerBridge` | **MAIN** |
| 2 — the correction | `AcpSendBox.tsx:818` `ipcBridge.acpConversation.steer.invoke` → `ipcBridge.ts:393` `httpPost` → `http://127.0.0.1:<port>/api/conversations/<id>/steer` | the **aioncore binary** (`process/backend/binaryResolver.ts`), a separate process; main never sees it |

So main *does* observe the correction on the production path — through leg 1, at
a named line — and `artifactTurnSteer` is not decoration. What has no main-process
seam is the RUNTIME telling main a correction arrived, which is leg 2 and is a
different claim. `AcpSendBox.dom.test.tsx` now drives leg 1 end to end: the send
box, the real bridge payload, the real main handler, the real store — and asserts
that after the correction the old permit produces zero provider fetch and zero
debit. Removing the `artifactTurnSteer.invoke` call turns that test red with the
provider fetch it was supposed to prevent.

Round 3 also made the revoke's *failure* best-effort, and that part is now
withdrawn: see **C2e**. A retirement that cannot be stored retires the
conversation instead, main-side, and the edit path checks that state before any
provider call or debit. The renderer still never blocks the correction; it simply
no longer pays for that with a live permit.

One residue remains open, and one is closed by round 5:

- **OPEN — the IPC never reaching main.** The two legs above do not share a
  transport. A dead IPC layer therefore hides the correction from main while the
  correction itself still works, and no deny is raised. The renderer's
  contribution is bounded and is pinned: the retire is called and awaited first.
  Closing this means a runtime that tells main a correction happened — the same
  `append_context_event`-class substrate gap as gap 1;
- **CLOSED (round 5) — a process-scoped deny lost to a restart.** When writing the
  durable marker was what failed, the deny lived only in that process; a restart
  forgot it while the permit record it compensated for was still on disk and still
  inside its window. No second marker could fix that, because writing was the
  failure. Instead, **no live spend authority may outlive its process**: see
  **C2f**.

### 3d. `mediaDirective` is renderer-only because nothing forwards it, not because it is stripped

Verified route by route above. What is NOT enforced is the future: no test stops
a later renderer feature from writing that path into a message, at which point it
would reach the transcript and, through it, the model. The redaction on
`stripCommandEvePreparedContext` covers credentials, not paths, so it would not
catch that. Stated because "it cannot happen today" and "it cannot happen" are
different sentences.

### 3d-bis. "The exact envelope shape is preserved across the refactor" is UNPROVEN

Round 6 recorded that the entry builder's move from conditional spreads to
conditional assignments preserved the emitted shape exactly. **That claim is
withdrawn, and is recorded here as a known limit rather than as evidence.**

`buildConversationArtifactEnvelopeEntries` lives in
`packages/desktop/src/process/commandEve/artifactCapabilityHandleStore.ts`.

**Provenance, restated accurately.** An earlier version of this paragraph called
that file **untracked, with no baseline to diff**. Since `c330f32f` that sentence
is stale: the file is tracked, and `git show HEAD --name-status` lists it as `A`.
The statement that stays true is a different one and is the one that matters:

> The file is **NEW IN THIS COMMIT** (`c330f32f`, status `A`) and has **NO PARENT
> PREDECESSOR**. `git show c330f32f^:packages/desktop/src/process/commandEve/artifactCapabilityHandleStore.ts`
> exits non-zero — the path does not exist in the parent tree — so there is no
> earlier *shape* to compare the current one against.

"Untracked" was a claim about the index and it has been overtaken by events.
"No predecessor in the parent commit" is a claim about history and it does not
expire. Nobody — including the author — can verify that the new conditional
assignments reproduce what the old conditional spreads emitted, because the
pre-refactor text was never committed anywhere: not in this commit's parent, not
in a stash, not in a worktree.

One concrete way the two could differ, named because "probably identical" is not
a finding:

- `:354` reads `if (payload.parent_artifact_id !== undefined)`. A truthiness-based
  spread — `...(payload.parent_artifact_id ? { parentArtifactId: … } : {})` — would
  have dropped an **empty-string** `parent_artifact_id`, where the current code
  keeps it as an own property holding `''`. Whether the old code was truthiness- or
  `undefined`-based cannot be established from anything on disk.

What IS proven, and is a smaller claim: the shape the code emits **today** is the
one the type describes — inapplicable optionals are absent rather than
present-and-undefined — asserted with `Object.hasOwn` in
`artifactCapabilityHandleStore.test.ts` and proved by sabotage (making the three
assignments unconditional turns it red). That is a statement about the present
behaviour, not about identity with a predecessor that cannot be read.

### 3e. The lint gate did not read the two model-facing MCP modules

`.oxlintrc.json` ignores `resources/` and `scripts/` as bare path segments, so
`npm run lint` silently skipped
`packages/desktop/src/process/resources/builtinMcp/**` — the MCP server the model
actually talks to and the tool surface that decides what it is offered — along
with `scripts/build-mcp-servers.js`. Round 2 reported the linter as run over
these files. It was run; it opened 36 of the 39 paths it was handed and said so
in a line nobody read.

Narrowly fixed: `!packages/desktop/src/process/resources/builtinMcp/` now
un-ignores exactly that directory (4 files, +0 errors repo-wide, and one
`no-await-in-loop` in the new server that is now documented at the line rather
than invisible). The wider hole is NOT fixed and is deliberately left alone:
dropping `resources/` and `scripts/` outright brings 114 more files into the gate
and surfaces **7 pre-existing errors** elsewhere in the tree, which would break
`npm run lint` on contact. That is a repo-level cleanup with its own blast
radius, not a line in this slice. `scripts/build-mcp-servers.js` therefore
remains unlinted by the gate; checked once by hand against the same config minus
those two patterns: 0 warnings, 0 errors.

### 4. The envelope IPC will answer for any conversation id the renderer names

The provider is renderer-only and the renderer passes its own conversation, so
this is not reachable by the model. It is still a wider surface than it needs to
be, and it is written down rather than assumed away.

## Deliberately deferred

### `eve_video_edit` is behind a default-off flag

`COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT=1`, checked in the shared paid handler so
both lanes obey it, and — since round 2 — in the MCP **tool surface** as well, so
the capability is not merely refused when the seat is closed but never offered.
MCP tool calls do **not** pass through Hermes' approval prompt. This mirrors the
gateway half, which shipped behind `EVE_MULTIMODAL_ENABLE_XAI_VIDEO_EDIT`, also
default-false. The read operations are unaffected — they cost nothing and cannot
spend, and gating them too would make the feature absent in its own default
state.

**It stays off for 1.820.1.** It may be turned on only after a packaged,
signed-resource first run proves the MCP server actually lands in the emitted
Hermes config *and* a bounded no-paid dry path works. Neither can be established
by a unit test, and no test in this repo writes the flag into `process.env` — the
suite passes an env object per case, or injects the decision as a dep, so the
default is genuinely the default everywhere.

The flag NAME occurs exactly twice in the tree: its declaration in
`agentVideoEditFlag.ts` and this document. (Round 2 reported it as occurring
once. The material claim — that nothing sets it, so the default is the default —
survives; the count did not, and a count that is wrong in a report about honesty
is worth correcting rather than rounding off.) Every other reference goes through
the exported constant or through `isAgentVideoEditEnabled`, which is what makes
the tool surface, the loopback, the paid handler and the emitted Hermes config
incapable of disagreeing about what this seat may do.

While the flag is off, **no surface** names the paid capability: the envelope
advertises none, no permit is minted, and the MCP tool list does not contain
`eve_video_edit` at all. Getting this to two surfaces took two rounds — the first
build advertised it everywhere and minted live handles regardless; the second
fixed the envelope and left the tool list, which an independent audit caught.

### AionCore native `append_context_event`

The envelope is a **prefix on a message**, which is the right shape for today and
the wrong shape forever: it re-sends the same registry every turn, and it lives in
the user's message rather than in a structured event the runtime owns. The eventual
substrate is a native AionCore `append_context_event` — the app appends a typed
artifact event to the conversation, the runtime folds it into context once, and no
part of it rides the user's text.

**This release does not block on it, and must not.** AionCore is a sha256-pinned
binary (`aioncoreArtifactProvenance.darwin-arm64.commit 18913f5446…`); changing it
is a release-train action with its own build, provenance and verification, not a
line in this slice. When that substrate exists, `buildCommandEveAgentTurnInput`
becomes the compatibility path for older runtimes and the envelope stops being
emitted for newer ones — the handle model and the store are unchanged either way,
because they were never coupled to the transport.

### The MCP lane needs the signed managed Node

No MCP entry is emitted unless a managed node executable, the built script and a
provisioned bearer file are all present, so a dev tree emits nothing rather than
a server Hermes would fail to spawn. To be exact about which half does what,
because the earlier wording put it all in one function:
`writeHermesRuntimeFiles` checks that the three things EXIST, and
`buildCommandEveArtifactContextHermesMcpServer` refuses anything that is not an
absolute path or a loopback URL. Either refusal yields `undefined` and no server.
"Works in dev" proves nothing here: the packaged, signed `Contents/Resources`
node is the only real proof, and that is a packaged-build gate, not a unit test.

## Coverage packet — round 8, counted rather than remembered

The round 6 packet carried four inflated test counts; round 7 replaced it in
full. Round 8 re-derives every number again after the invariant-scoping
remediation, rather than adjusting the previous table by hand. Every number below
was read off a run, not recalled.

### How the counts drifted, so it does not recur

Counting `it(` occurrences in a source file **undercounts and mis-counts**. Two
constructs in this suite generate tests at runtime that no source line shows:

- `it.each(...)` — `videoEditSpendPermit.test.ts` and
  `commandEveVideoEditBridgeRegistration.test.ts`;
- a plain `for` loop around `it(...)` — `videoEditResolutionIsSemantic.test.ts`
  declares 10 `it(` lines and runs **32** tests, two per module in
  `RESOLUTION_PATH_MODULES`.

The authority is therefore the reporter, not the file:
`bunx vitest run <files> --reporter=json`, summing `assertionResults` per entry
in `testResults`. That is what produced the table.

### Per-file totals across the 23 MAT-1747 unit-test files

Scoped to the MAT-1747 test files. The diff now touches a **24th** changed
unit-test file, `tests/unit/command-eve/seatRailSwitchRealSeam.test.ts` (11
tests), which carries no MAT-1747 coverage at all — it is a test-isolation repair
recorded in "The flake this round closed" below, and is deliberately kept out of
this table so the slice's coverage number stays a coverage number.

| tests | file | in git at `f2e98d97` |
| ---: | --- | --- |
| 54 | `tests/unit/renderer/AcpSendBox.dom.test.tsx` | tracked, modified |
| 32 | `tests/unit/command-eve/videoEditResolutionIsSemantic.test.ts` | new |
| 31 | `tests/unit/command-eve/videoEditSpendPermit.test.ts` | new |
| 28 | `tests/unit/command-eve/commandEveVideoEditBridge.test.ts` | new |
| 18 | `tests/unit/command-eve/eveArtifactCapabilityHandleCore.test.ts` | new |
| 16 | `tests/unit/command-eve/eveArtifactContextEnvelope.test.ts` | new |
| 16 | `tests/unit/command-eve/eveArtifactToolSurface.test.ts` | new |
| 15 | `tests/unit/command-eve/artifactCapabilityHandleStore.test.ts` | new |
| 15 | `tests/unit/command-eve/videoEditPermitTurnBinding.test.ts` | new |
| 14 | `tests/unit/command-eve/artifactCapabilityLoopback.test.ts` | new |
| 13 | `tests/unit/command-eve/videoEditLegacyTierAuthority.test.ts` | new |
| 11 | `tests/unit/command-eve/artifactCapabilityShimRoute.test.ts` | new |
| 10 | `tests/unit/command-eve/commandEveVideoEditBridgeRegistration.test.ts` | new |
| 10 | `tests/unit/command-eve/videoEditSteerRevokesPermit.test.ts` | new |
| 10 | `tests/unit/command-eve/videoEditStoreHealthBoundary.test.ts` | new |
| 9 | `tests/unit/command-eve/videoArtifactStore.test.ts` | tracked, modified |
| 8 | `tests/unit/command-eve/artifactCapabilityShimSiteWiring.test.ts` | new |
| 8 | `tests/unit/command-eve/videoGenerateCapabilityMint.test.ts` | new |
| 7 | `tests/unit/command-eve/videoEditSourceBounds.test.ts` | new |
| 6 | `tests/unit/command-eve/videoEditSpendDeny.test.ts` | new |
| 4 | `tests/unit/command-eve/artifactCapabilitySecretsStayPrivate.test.ts` | new |
| 4 | `tests/unit/command-eve/runtimeReconciliationMcpServers.test.ts` | new |
| 1 | `tests/unit/command-eve/videoEditStoreStartupWiring.test.ts` | new |

**340 tests across 23 files, all passing** — `FILES 23 TOTAL 340 FAILED 0`,
summed from `--reporter=json` over exactly these 23 paths. Round 7 counted 334;
the whole delta is `AcpSendBox.dom.test.tsx` going 48 -> 54, which is the six
round-8 whitespace-seam cases in C2d-bis and nothing else. Every other row is
unchanged and was re-derived rather than copied.

Round 6's four inflated figures map onto this table as `32 -> 28`
(`commandEveVideoEditBridge`) and `12 -> 11` (`artifactCapabilityShimRoute`); the
two `-> 10` corrections cannot be attributed to a single file from the summary
alone, because three files run exactly 10. So rather than correct four numbers,
**every count in the slice was re-derived** and the whole table is stated.
`videoEditResolutionIsSemantic` is the file most likely to be miscounted next
time: 10 in the source, 32 at runtime.

### The two things the round 6 packet omitted

**1. `.oxlintrc.json` — a negation that WIDENS the lint gate.** The one-line diff
adds `"!packages/desktop/src/process/resources/builtinMcp/"` to `ignorePatterns`,
directly after the bare `"resources/"` entry. It is an **un-ignore**: it brings
the two model-facing MCP modules (`eveArtifactContextServer.ts`,
`eveArtifactToolSurface.ts`) INTO a gate that had been silently skipping them.
Nothing is excluded by it. Said plainly because a diff line inside
`ignorePatterns` reads at a glance like the opposite of what it does. The wider
hole stays open on purpose — see gap 3e — so `scripts/build-mcp-servers.js`
remains outside the gate, and the oxlint run below reports 48 processed files for
49 handed to it, that one file being the difference. Confirmed by isolating it:
`bunx oxlint scripts/build-mcp-servers.js` prints `Finished in 24ms on 0 files`.
(Round 6 measured 47-for-48; the changed-file set grew by one this round —
`seatRailSwitchRealSeam.test.ts` — so both numbers moved by exactly one and the
gap is unchanged.)

**2. An inline `no-await-in-loop` suppression in new model-facing code.**
`packages/desktop/src/process/resources/builtinMcp/eveArtifactContextServer.ts:172`
carries `// eslint-disable-next-line no-await-in-loop` above the `artifact_list`
fan-out, with the reason stated in the five comment lines above it: up to 24
sequential calls into the single Electron main process, deliberately not
parallelised so one tool call cannot spawn 24 concurrent handlers. Verified as
actually honoured by oxlint — the file is processed and reports zero warnings.
It became visible only BECAUSE of the negation in item 1; before it, the rule
never ran on this file.

Round 7 found a **second, unsuppressed** one that round 6 did not report:
`tests/unit/command-eve/videoEditPermitTurnBinding.test.ts:184`. It was the sole
warning contributed by any new file and it is why the honest changed-file total
was 38, not 37, before this round. The loop is genuinely sequential — the test
asserts `seen` against `variants` **in order**, which `Promise.all` would not
preserve — so it now carries an `oxlint-disable-next-line` with that reason, in
the same form the repo already uses in `runtimeBootstrapCore.ts` and
`workspaceSearchCore.ts`.

### Gate results, with the real numbers

| gate | result |
| --- | --- |
| `bunx vitest run tests/unit/command-eve/ tests/unit/renderer/` | 367 files: 366 passed, **1 failed**; 4003 tests: 3997 passed, 5 skipped, 1 failed |
| `bunx vitest run` (full) | 571 files: 567 passed, 2 skipped, **2 failed**; 5722 tests: 5708 passed, 12 skipped, 2 failed |
| `bunx tsc --noEmit` | exit 0, no output |
| `git diff --check` | exit 0, no output |
| `bunx vitest run` over the 23 MAT-1747 files, `--reporter=json` | `FILES 23 TOTAL 340 FAILED 0` |
| `bunx vitest run tests/unit/renderer/AcpSendBox.dom.test.tsx` | `Tests  54 passed (54)`, exit 0 |
| `bunx vitest run tests/unit/command-eve/seatRailSwitchRealSeam.test.ts`, 3× isolated | `Tests  11 passed (11)`, exit 0 each; no `/tmp/ce-rail-data` and no `$TMPDIR/ce-rail-data-*` left behind |
| oxlint, 49 changed/new source files, NUL-delimited `xargs -0` | `Found 37 warnings and 0 errors` / `on 48 files` |
| oxlint, the **17** previously-existing lintable files (current content) | `Found 37 warnings and 0 errors` / `on 16 files` |
| oxlint, the 32 NEW files alone | `Found 0 warnings and 0 errors` / `on 32 files` |
| oxlint, the 11 lintable files touched by the round-8 remediation alone | `Found 0 warnings and 0 errors` / `on 11 files` |
| `gitnexus detect_changes` (compare, base `f2e98d97`) | 90 changed symbols, 18 files, 11 affected processes, risk **high** |

**A count that was wrong and is corrected here.** Round 7 wrote "16 tracked files
at `f2e98d97` … on 15 files". A fresh enumeration finds **17**: `git diff
--name-status f2e98d97` reports 18 `M` paths, of which one (`.oxlintrc.json`) is
not lintable, leaving 17 handed and 16 processed — the one difference being
`scripts/build-mcp-servers.js`, which the gate still ignores (gap 3e). 33 `A`
paths minus the one `.md` gives 32 new lintable files; 17 + 32 = the 49 in the
row above, which is the arithmetic that should have caught the drift the first
time. A count in a packet about honesty is worth re-deriving rather than copying.

The lint total is **37 against a baseline of 37**: the slice adds zero warnings,
the 32 new files add zero, and the round-8 remediation adds zero.
`detect_changes` moved from round 6's
85 symbols / 17 files to 90 / 18; the whole delta is
`seatRailSwitchRealSeam.test.ts` and the five symbols inside it. The affected-process
count and the **high** risk level are unchanged, and both are rooted in
`handleAppReady` / `AcpSendBox` — this slice's own production changes, not the
test-isolation repair, whose blast radius is the one test file.

**The suite is NOT green.** Three things were wrong with it, and saying "two
pre-existing failures" without the third is the sentence this round had to
correct. The full state:

1. and 2. — two **pre-existing** failures, still failing, listed below. Both
   verified failing on the untouched base: a detached worktree at `f2e98d97` with
   `node_modules` symlinked runs the same two files and reports `Test Files 2
   failed (2) / Tests 2 failed | 13 passed (15)`.
3. — a **flake**, `seatRailSwitchRealSeam.test.ts`, which rounds 1–6 never named
   because it only fires under concurrent load. **CLOSED in round 7** — cause and
   evidence in "The flake this round closed" below. Re-verified in round 8: green
   isolated 3× (`Tests  11 passed (11)`, exit 0 each, no `/tmp/ce-rail-data` and
   no `$TMPDIR/ce-rail-data-*` left behind) and green under the full suite, so the
   two failures below are the whole remainder.

Round 8 changed neither of them. The full run moved from 5716 tests to 5722 —
exactly the six added seam cases, all passing — while the failing set is
byte-for-byte the same two names.

- `tests/unit/command-eve/aiCodingDelegationGate.test.ts` — a skill-catalog
  assertion on `resources/`, untouched by this slice;
- `tests/integration/i18n-packaged.test.ts` — `out/renderer is missing — run
  \`bun run package\` first`. An environment precondition: no packaged build
  exists in this sandbox. It does not appear in the focused run because it lives
  under `tests/integration/`, which is how round 6 saw one failure where the full
  suite has two.

The lint measurement is stated as three numbers rather than one because a single
"37" hides which set it was measured over. The `xargs -0` form is load-bearing:
in zsh an unquoted `$FILES` does not word-split, so oxlint receives one nonexistent
path, lints nothing, and prints zero warnings — a green gate measuring nothing.
The processed-file count oxlint prints is the only defence against that, which is
why it is quoted above rather than summarised.

### The flake this round closed — a shared fixture, not a bad assertion

`tests/unit/command-eve/seatRailSwitchRealSeam.test.ts` failed intermittently on
its H4 case:

```
FAIL |node| tests/unit/command-eve/seatRailSwitchRealSeam.test.ts
  > mirror (b) — REAL switch-seat handler: admin gate + Founder chip + label threading
  > an authorized switch to a target with NO valid runtime files FAILS-CLOSED and rolls back (never boots on wheel defaults)
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ tests/unit/command-eve/seatRailSwitchRealSeam.test.ts:263:32
```

The trace's `:263` is the pre-fix line number. In the current file that same
assertion sits at `:283` — the isolation block added 20 lines above it
(`describe` at `:189`, `it` at `:271`). The assertion text is **byte-identical**
across the change, which is the check that the fix did not quietly relax it:

```
263 (HEAD, before)   expect(restartBackendMock).toHaveBeenCalledTimes(1);
283 (now,   after)   expect(restartBackendMock).toHaveBeenCalledTimes(1);
```

**The assertion was never wrong.** The fixture was machine-global. The file
mocked `getDataPath()` to the fixed path `/tmp/ce-rail-data`, seeded seat runtime
files under it in `beforeEach`, and `rm -rf`'d **the whole root** in `afterEach`.
Every AionUi worktree on this machine resolved that same path, so two suites
running at once seeded and deleted each other's files.

Proven, not inferred. While only a *second* worktree ran the suite, a watcher
planted an outside marker in `/tmp/ce-rail-data` and watched the foreign
`afterEach` remove a file it had never created, then the root itself:

```
08:12:52.540 root=YES seatB_config=YES marker=no
08:12:52.544 PROBE PLANTED MARKER
08:12:52.579 PROBE PLANTED MARKER
08:12:52.608 root=no  seatB_config=no  marker=no
```

That is why the symptom looked impossible: the H4 case strips **only** SEAT_B and
expects the rollback to SEAT_A to re-spawn once, but the losing run's log shows
SEAT_A fail-closed too —

```
Seat-switch FAIL-CLOSED for aaaaaaaa-…: home (/tmp/ce-rail-data/…/seats/aaaaaaaa-…/home)
has no valid config.yaml + SOUL.md — rolling back rather than booting on wheel defaults.
```

— a seat that run had seeded itself and never deleted. With the rollback target
also fail-closed inside `prepareEnv`, `restartCommandEveBackendForSeat` was never
reached: 0 calls instead of 1.

**The fix is test isolation only.** The fixed root became a per-run
`fs.mkdtempSync(path.join(os.tmpdir(), 'ce-rail-data-'))`, wrapped in `vi.hoisted`
so the `vi.mock` factory can close over it, plus an `afterAll` that removes the
mkdtemp root itself. **No production file was touched, and no assertion was
weakened, widened, skipped, retried, serialized or marked flaky** — the
fail-closed rollback contract it enforces is unchanged, which is the point: a
real contract was being blamed for a dirty fixture.

Both halves are existing repo idiom, cited separately because they are two
different precedents and an earlier draft of this note merged them into one wrong
citation:

- `vi.hoisted` — used by **71** files under `tests/`;
- the `require('node:fs')` + `mkdtempSync(path.join(os.tmpdir(), …))` form inside
  a test — `tests/unit/command-eve/onboardingStatusSeatIdentity.test.ts:191-194`.
  That file does **not** use `vi.hoisted`, so it is a precedent for the temp-root
  idiom only.

Residual, stated rather than hidden: **nine** `tests/unit/command-eve/*.test.ts`
files — this one and eight others — still mock `getSkillsDir`/`getCronSkillsDir`
to the machine-global `/tmp/skills` and `/tmp/cron-skills`. That is the same class
of coupling. It is benign **today** and was left alone to keep this diff minimal:
verified by grep that no test `rm -rf`s either root, so nothing deletes another
process's files. `seatRailSwitchRealSeam.test.ts` was the only test in the tree
with a destructive fixed `/tmp` root.
