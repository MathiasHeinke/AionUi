# Command EVE 1.822.3-alpha.1 preview intake

Status: `ALPHA_SCOPE_FOUND_SOURCE_INTEGRATED_REVIEW_PENDING`.

The isolated candidate integrates exactly the independently reviewed Voice
slice `62a11e11a54da7a513197a68aaede431f3b2f0be` on live AionUI 1.822.2 source
`a289ce2f077eb5c2bc7a568ab4c334f179a4c528`. The base is the exact merge-base,
so the source slice is conflict-free and ordered by its nine original commits.

This is a meaningful user-visible alpha scope: local microphone input, local
STT, one exact ACP turn, local OS TTS dialogue, stop/barge behavior, and the
stream-terminal fixes required to keep the two real UI consumers idempotent.
The source changes do not alter dependencies, lockfiles, AionCore source or
pin, Hermes payload or pin, resources, or a protocol schema. Focused source
revalidation passed 86/86 tests across five Voice/ACP files on the owner head;
the isolated integrated candidate then passed all 255/255 tests across its 19
changed unit-test files. The initial isolated-WT `bunx` attempt executed zero
tests because dependencies were intentionally absent and is not counted as a gate.

The candidate deliberately remains version `1.822.2` until a separate alpha
version gate authorizes `1.822.3-alpha.1`. It is not package-, device-,
runtime-, signing-, notarization-, upload-, or release-ready. Stable 1.822.2
feed bytes must remain unchanged; any later alpha is a separate direct download.
