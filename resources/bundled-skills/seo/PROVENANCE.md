# seo — third-party skill provenance

This skill is **vendored, not authored here**. The file listed below is a
byte-identical copy of the upstream source. Nothing in the upstream tree was
edited, reworded, reformatted or wrapped — the only file this repo adds is
this record.

## Upstream identity

| Field | Value |
| --- | --- |
| Source path | `${HOME}/.codex/skills/seo` (user-scope Codex skill directory, host-local canonical source) |
| Upstream skill version | `1.0` (`metadata.version` in `SKILL.md` frontmatter) |
| Upstream author | `web-quality-skills` (`metadata.author` in `SKILL.md` frontmatter) |
| Licence | MIT — declared via `license: MIT` in `SKILL.md` frontmatter |
| Retrieval date | 2026-08-03 |
| Upstream path | the whole skill directory (a single `SKILL.md`) |

## Licence text: NONE exists upstream

The MIT declaration exists ONLY as the `license: MIT` frontmatter scalar. No
`LICENSE` file exists anywhere in the upstream tree, so there is no verbatim
licence text to vendor. Rather than write our own MIT file — which would
fabricate an attribution (copyright holder, year) the upstream never stated —
this record IS the licence documentation. If an upstream licence text appears
later, vendor it byte-identical as `LICENSE` and pin its digest here.

## Pinned file digests (sha256)

Computed on the vendored copy; identical to the upstream source at the
retrieval date.

| File | sha256 |
| --- | --- |
| `SKILL.md` | `a06ca86d0b0cc75982ee10651bd7398c0242a13d91d3b4c8eae0bf1360d18b92` |

## What is NOT here

- No executables, no scripts, no shell. The tree is one markdown file plus this
  record.
- No network calls. `SKILL.md` contains documentation URLs (example.com,
  schema.org, Google Search references) as REFERENCES inside prose and markup
  examples; it ships no code that performs requests.
- No product, billing, entitlement, credit or history logic. This skill is
  search-optimization method only.
- No Command EVE wrapper. The upstream `SKILL.md` already satisfies the bundled
  skill hygiene gate as shipped (valid frontmatter, `name`, a trigger-bearing
  `description`), so no adapter file was needed and none was added.

## Refreshing to a newer upstream version

1. Copy the new upstream `SKILL.md` byte-identical over this tree.
2. Update the version / retrieval date / digest in this record, the pinned
   digest in the AionUI build gate (`SEO_PINNED_SHA256` in
   `scripts/fetch-bundled-skills.mjs`) and the AionUI snapshot verifier
   (`tests/unit/command-eve/seoSkillSnapshot.test.ts`). That verifier is
   fail-closed: stale digests break the build rather than shipping silently.
