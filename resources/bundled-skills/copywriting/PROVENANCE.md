# copywriting — third-party skill provenance

This skill is **vendored, not authored here**. Every file listed below is a
byte-identical copy of the upstream release. Nothing in the upstream tree was
edited, reworded, reformatted or wrapped — the only files this repo adds are
`LICENSE` (copied verbatim from the upstream repository root) and this record.

## Upstream identity

| Field | Value |
| --- | --- |
| Registry slug | `coreyhaines31/marketingskills@copywriting` (skills.sh) |
| GitHub repository | `coreyhaines31/marketingskills` |
| Pinned commit | `7868cb9251fad80a73d26e488a5ad5f6c4a9f335` |
| Upstream skill version | `2.0.1` (`metadata.version` in `SKILL.md` frontmatter) |
| Licence | MIT — © 2025 Corey Haines (full text in `LICENSE`) |
| Retrieval date | 2026-08-01 |
| Upstream path | `skills/copywriting/` |

## Pinned file digests (sha256)

Computed on the vendored copy; identical to the upstream clone at the pinned
commit and to the independent installer reproduction.

| File | sha256 |
| --- | --- |
| `SKILL.md` | `ecdaabca28863d1472f79ba637842fdf4ac2fd9acc92b215ab7f152e757b2a33` |
| `references/natural-transitions.md` | `4ff23f8943af2f65b072f26f1c53ce55f19cc26d7be211c11cae8e34b43e859f` |
| `references/copy-frameworks.md` | `f387b6ed4b510efa9f0d3c459f4898971c8b0176e8c34185040cb264eca50186` |
| `evals/evals.json` | `1cd7c27538b91d46c2b2cd007f2064922a4874ece1f2851b4bd844fe6f78a3e6` |
| `LICENSE` | `b70d71e24e40fce5da8f4b6f9cd862096a048e433db7f3c8cac5e348e6d34591` |

`LICENSE` is copied from the upstream repository ROOT (`LICENSE`), not from
`skills/copywriting/` — upstream ships one licence for the whole repository.

## Two-source verification

The retrieval was reproduced twice, independently, and the two reproductions
agree on all four skill files:

1. `git clone` of `coreyhaines31/marketingskills`, checked out at
   `7868cb9251fad80a73d26e488a5ad5f6c4a9f335`.
2. The official installer flow for `coreyhaines31/marketingskills@copywriting`.

A disagreement between those two sources is a STOP condition, not a merge
conflict to resolve by preference.

## What is NOT here

- No executables, no scripts, no shell, no network calls. The tree is four text
  files (markdown + one JSON eval fixture) plus the licence and this record.
- No product, billing, entitlement, credit or history logic. This skill is
  copywriting method only.
- No Command EVE wrapper. The upstream `SKILL.md` already satisfies the bundled
  skill hygiene gate as shipped (valid frontmatter, `name`, a trigger-bearing
  `description`), so no adapter file was needed and none was added.

## Refreshing to a newer upstream version

1. Re-clone at the NEW commit and reproduce it a second way (installer).
2. Diff both reproductions; a mismatch STOPS the update.
3. Replace the files, update the commit / version / retrieval date / digests in
   this record, and update the pinned digests in the AionUI snapshot verifier
   (`tests/unit/command-eve/copywritingSkillSnapshot.test.ts`). That verifier is
   fail-closed: stale digests break the build rather than shipping silently.
