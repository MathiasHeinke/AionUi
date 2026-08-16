# Security convergence — MAT-1843 / Command EVE 1.823 source candidate

## Frozen remediation snapshot

`sha256:1ae8099e24e0dd093fbde706cfb9da9d86e869b0c06e3725fbb991af66991437`

Exact recipe:

```bash
{
  git diff --binary HEAD -- packages/desktop tests
  while IFS= read -r file; do
    printf 'untracked:%s\n' "$file"
    shasum -a 256 "$file"
  done < <(git ls-files --others --exclude-standard packages/desktop tests | LC_ALL=C sort)
} | shasum -a 256
```

Fable 5 independently reproduced the published digest bit-for-bit with this recipe.

## Independent reviewer convergence

| Reviewer    | Provider family | Initial | Remediation | Sentinel                      |
| ----------- | --------------- | ------- | ----------- | ----------------------------- |
| Opus 5      | Anthropic       | REJECT  | PASS        | `OPUS5_REMEDIATION_COMPLETE`  |
| Grok 4.6    | xAI             | REJECT  | PASS        | `GROK46_REMEDIATION_COMPLETE` |
| Fable 5 CAO | Anthropic       | n/a     | PASS        | `FABLE5_CAO_COMPLETE`         |

Both reviewers independently confirmed the original P1: image edit consumed its permit before an outer Seat/Seed operation fence and let managed generation recapture the active Seat. Both independently traced the remediation and agree that:

- Seat id/revision/dataPath are captured before spend;
- recovery/transition changes refuse before consume;
- the paid-artifact fence spans consume, managed work and finalization;
- `expectedSeat` plus deterministic request id reach Main's managed service;
- successful staged children write completion receipts;
- identical replay recovers before permit evaluation/consume;
- post-consume failure is not marked retryable;
- no new P0/P1 was introduced.

## Residuals

- P2 historical managed-image records/capability handles are not durably Seat-stamped. GitNexus reports HIGH impact for parser/stage migration. This is isolated as MAT-1845, blocked behind MAT-1843, and was not mixed into the bounded release-blocker fix.
- P2 first-bind of an edit-derived staged child does not yet require parent-conversation equality. This belongs to the same durable artifact-boundary follow-up, MAT-1845.
- P2 direct image create bypasses the conversation command queue; Main still prevents double spend. This is not a release-blocking paid-operation integrity defect.
- P2 global UI primitive/theme consistency is isolated as MAT-1844. It does not reopen the explicit composer authority or paid image-edit P1.
- No provider/runtime/package/release claim is made by this source convergence.

## Controller verdict

`PASS_SOURCE_SECURITY_CONVERGENCE_AND_CAO`

Merge, packaging, signing, notarization, R2/feed publication, deployment and Linear Done remain blocked.
