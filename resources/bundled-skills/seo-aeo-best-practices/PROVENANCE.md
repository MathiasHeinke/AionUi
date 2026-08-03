# seo-aeo-best-practices — third-party skill provenance

This skill is **vendored, not authored here**. Every file listed below is a
byte-identical copy of the upstream source. Nothing in the upstream tree was
edited, reworded, reformatted or wrapped — the only file this repo adds is
this record.

## Upstream identity

| Field | Value |
| --- | --- |
| Source path | `${HOME}/.agents/skills/seo-aeo-best-practices` (user-scope agents skill directory, host-local canonical source) |
| Upstream skill version | none declared (no version field in `SKILL.md` frontmatter) |
| Upstream author | not stated anywhere in the upstream tree |
| Licence | **UNDECLARED / UNKNOWN** — see below |
| Retrieval date | 2026-08-03 |
| Upstream path | the whole skill directory (`SKILL.md` + `references/`) |

## Licence status: UNDECLARED

No `LICENSE` file exists anywhere in the upstream tree and the `SKILL.md`
frontmatter carries no `license` key. The licence of this skill is therefore
**unknown**, and no licence file was fabricated for it. This record names that
gap explicitly instead of papering over it. If the upstream declares a licence
later, vendor the licence text byte-identical as `LICENSE`, pin its digest
here, and update this section.

## Pinned file digests (sha256)

Computed on the vendored copy; identical to the upstream source at the
retrieval date.

| File | sha256 |
| --- | --- |
| `SKILL.md` | `21d5865242c9939ee524ec0cc396c3098ccd7eac846ca9e043789beef22c9c25` |
| `references/aeo-considerations.md` | `b9f7c5eca66a0b3594e57b648838f3e01c8daf39d69dfd542bc14199bc3ccd74` |
| `references/eeat-principles.md` | `7ff154f8f26df3a597f9f5f72751eda28f19f9064b8126b3c6cfb298fb700b22` |
| `references/structured-data.md` | `e61b75e85c4ad34caaa13a0dcf9e9f391ca609d0099db9419860734b5da78949` |
| `references/technical-seo.md` | `0f35171b8d423125143f10c9ec07a7fd46f7096e1da443b5fa00b8717b20d069` |

## What is NOT here

- No executables, no scripts, no shell. The tree is five markdown files plus
  this record. The `typescript` code fences in `references/` are documentation
  EXAMPLES (how an operator's app code would implement sitemaps, metadata and
  structured data) — prose for the agent to follow, not shipped runnable code.
- No network calls performed by the skill itself; example snippets reference
  an app's own CMS client in documentation context only.
- No product, billing, entitlement, credit or history logic. This skill is
  SEO/AEO method only.
- No Command EVE wrapper. The upstream `SKILL.md` carries valid frontmatter
  with `name` and a trigger-bearing `description` ("Use this skill when
  implementing …"), so no adapter file was needed and none was added. The
  AionUI build gate's exact-string trigger check does not recognise that
  phrasing; the gate exempts exactly `description_missing_trigger` for exactly
  this id rather than editing vendored bytes
  (`VENDORED_SKILL_HYGIENE_EXEMPTIONS` in `scripts/fetch-bundled-skills.mjs`).

## Refreshing to a newer upstream version

1. Copy the new upstream files byte-identical over this tree.
2. Update the retrieval date / digests in this record, the pinned digests in
   the AionUI build gate (`SEO_AEO_PINNED_SHA256` in
   `scripts/fetch-bundled-skills.mjs`) and the AionUI snapshot verifier
   (`tests/unit/command-eve/seoSkillSnapshot.test.ts`). That verifier is
   fail-closed: stale digests break the build rather than shipping silently.
