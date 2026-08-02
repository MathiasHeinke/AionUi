// THE APPROVED-COPY CONTRACT FOR THE DESKTOP CLIENT'S LOCALE SURFACES.
//
// WHY THIS MODULE EXISTS AT ALL, STATED BEFORE ANYTHING ELSE:
//
//   CI CANNOT INFER TRUTH SEMANTICALLY. It cannot read a German sentence and decide
//   whether the business behind it can underwrite the promise in it. The sibling web
//   repo tried twice and failed twice, the same way both times:
//
//     v1 was a FIXED-PHRASE BLOCKLIST of guarantee wordings. A novel guarantee that
//        shared no literal with the list shipped GREEN.
//     v2 replaced it with a CATEGORY rule — an OUTCOME_NOUN within one clause of an
//        un-negated GUARANTEE_WORD — proven by five probes that all reddened. Then ONE
//        isolated probe defeated it:
//
//            "Wir sichern dir den ersten zahlenden Auftraggeber binnen vier Wochen zu."
//
//        It uses the separable verb "sichern … zu" instead of *garantieren*, and
//        *Auftraggeber* instead of *Kunde*. Neither token was in the vocabulary, so a
//        first-customer guarantee shipped GREEN on a live surface.
//
//   A SYNONYM VOCABULARY IS NOT SEMANTIC COVERAGE. There is no vocabulary that closes,
//   because the next sentence is drawn from outside whatever vocabulary was written.
//
// THIS REPO HAD THE SAME DEFECT AND A WORSE VERSION OF IT: no committed test read any
// locale JSON at all. MEASURED before this module existed — the desktop client ships its
// live product, pricing and trial copy in
// packages/desktop/src/renderer/services/i18n/locales/**, including the 99 EUR /
// 100.000-credit terms in de-DE/registrationGate.json, and nothing in the test suite
// opened those files. A guarantee sentence added there would have shipped green.
//
// SO THIS IS NOT A DETECTOR. It is a REVIEW-FORCING BOUNDARY.
//
//   Every translated string on a covered locale surface is listed, verbatim, in a
//   committed manifest. The gate compares the surfaces to the manifest and FAILS CLOSED
//   on any difference: a string that is new, a string that changed, a string that
//   vanished, a surface that appeared, a surface that disappeared, an occurrence count
//   that moved. Nothing about the SENSE of a sentence is judged — the gate has no opinion
//   about whether a sentence is honest, and claims none.
//
//   THE MANIFEST DIFF IS THE REVIEW BOUNDARY. A human approving a copy change approves a
//   visible, verbatim manifest diff, in a pull request, with the old and the new sentence
//   side by side. The defect class this replaces is "nobody saw the sentence", not "a
//   regex missed it". It is therefore still possible to approve a bad sentence. This
//   mechanism cannot stop that and does not pretend to. It only makes it impossible to do
//   it WITHOUT SOMEONE LOOKING.
//
// ONE DELIBERATE DIVERGENCE FROM THE WEB REPO'S VERSION, AND IT IS A STRENGTHENING.
//   There, copy has to be dug out of .tsx/.ts source next to Tailwind class strings, so
//   it needs a heuristic filter and cannot simply take every string. Here the surfaces
//   are pure translation dictionaries: EVERY string value is, by construction, text a
//   customer reads. So there is NO filter at all — no shape test, no length floor. A
//   two-word promise is inside this contract.
//
//   THE WEB REPO NO LONGER HAS A LENGTH FLOOR EITHER, and this note used to say it did.
//   Its MIN_COPY_LENGTH of 12 was removed after it was measured to drop 1,485 distinct
//   strings — including every short price on the site ('99 €/Monat', 'ab 25 €', '€0').
//   Its filter is now SHAPE-based, so the remaining divergence is that it still HAS a
//   filter and this one does not. A comment that describes the other tree's gate as
//   weaker than it is invites someone to "align" the two in the wrong direction.
//
// Pure string/JSON analysis. No bundler, no DOM, no network. Imported by the committed
// gate (tests/unit/approved-copy/localeCopyManifest.test.ts) AND by update.mjs, so the
// gate and the updater can never disagree about what a surface contains.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(dirname(HERE));

export const I18N_ROOT = join(REPO_ROOT, 'packages/desktop/src/renderer/services/i18n');
export const LOCALES_ROOT = join(I18N_ROOT, 'locales');
export const LOCALES_ROOT_ID = 'packages/desktop/src/renderer/services/i18n/locales';

/**
 * WHICH LOCALES ARE COVERED — DERIVED, NEVER HAND-LISTED.
 *
 * i18n-config.json is the product's own declaration of which languages it supports:
 * `supportedLanguages: ["de-DE", "en-US"]`. Reading it here means adding a language to
 * that list makes its files APPEAR to this walk, which the gate reports as a new,
 * unapproved surface. A hand-written array would instead have silently kept the new
 * language outside the contract — the exact failure this whole file exists to end.
 */
const i18nConfig = JSON.parse(
  readFileSync(join(REPO_ROOT, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
);

export const COVERED_LOCALES = [...i18nConfig.supportedLanguages].sort();

/** Every locale directory that exists on disk, covered or not. */
export const allLocalesOnDisk = () =>
  readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

/**
 * THE HONEST BOUNDARY, PART 1 — THE UNCOVERED LANGUAGES.
 *
 * ja-JP, ko-KR, pt-BR, ru-RU, tr-TR, uk-UA, zh-CN and zh-TW ship in the bundle and are
 * selectable in the settings language switcher, and they are NOT in this manifest.
 *
 * That is a stated gap, and it is a narrow one for a reason that is MEASURED rather than
 * assumed: the nine Command EVE product namespaces — commandCenter, commandEve,
 * connectorCatalog, credits, deinTeam, kanban, localRuntime, registrationGate,
 * skillLibrary — EXIST ONLY in de-DE and en-US (30 files each vs. 21 in every other
 * locale). When a user switches to any other language, services/i18n/index.ts calls
 * mergeWithFallback(fallbackLocale, modules) with de-DE as the fallback, so those users
 * are rendered THE GERMAN STRINGS FROM de-DE, verbatim. Every pricing, trial, credit and
 * seat sentence the product can display in ANY language therefore comes from a file this
 * manifest covers.
 *
 * What the uncovered locales DO carry on their own is translated application chrome for
 * the twenty-one upstream AionUi namespaces. That copy is not covered here. It is a real
 * gap and it is written down instead of inherited.
 */
export const uncoveredLocales = () => allLocalesOnDisk().filter((l) => !COVERED_LOCALES.includes(l));

/**
 * THE HONEST BOUNDARY, PART 2 — ONLY `.json` IS A SURFACE.
 *
 * Each locale directory also holds an `index.ts` that imports and re-exports the JSON
 * modules. It contains no translated text; it is module wiring. It is excluded, and the
 * gate asserts that the exclusion is exactly that one filename per locale, so a future
 * `.ts` file carrying copy cannot slip in behind this exclusion unnoticed.
 */
export const SURFACE_EXT = /\.json$/;
export const EXCLUDED_FILENAMES = ['index.ts'];

/** Every covered locale surface, DISCOVERED — never a hand-listed set of files. */
export function discoverSurfaces() {
  const found = [];
  for (const locale of COVERED_LOCALES) {
    const dir = join(LOCALES_ROOT, locale);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SURFACE_EXT.test(entry.name)) continue;
      found.push(join(dir, entry.name));
    }
  }
  return found.sort();
}

/** A discovered absolute path, as the stable id used everywhere: e.g. `de-DE/credits.json`. */
export const surfaceId = (file) => relative(LOCALES_ROOT, file).split(sep).join('/');

export const activeSurfaces = (surfaces = discoverSurfaces()) => surfaces.map(surfaceId).sort();

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * Collapse whitespace runs and trim. This is what makes a re-indent or a re-wrap invisible
 * to the manifest while a REWORDING is always visible, and it is also what guarantees the
 * tab-separated format can never be broken by a literal tab or newline inside a string.
 */
export const normalise = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Every translated string on one surface: normalised string -> occurrence count.
 *
 * Walks the parsed JSON — objects, nested objects and arrays — and takes EVERY string
 * value. Keys are not copy and are not recorded: a key rename does not change what the
 * customer reads, and key parity between de-DE and en-US is already enforced by the
 * separate committed gate scripts/check-i18n.js. Values that are empty after
 * normalisation carry no copy and are skipped; check-i18n.js reports those as empty-value
 * warnings, so they are not silently unowned.
 *
 * A malformed JSON file THROWS rather than yielding an empty surface, because an empty
 * surface would read as "this file has no copy" and pass.
 */
export function extractCopy(id, text) {
  const counts = new Map();
  const visit = (node) => {
    if (typeof node === 'string') {
      const s = normalise(node);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) visit(value);
    }
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`approved-copy: ${id} is not valid JSON — ${error.message}`);
  }
  visit(parsed);
  return counts;
}

/** The full observed contract: ordered surface ids + their copy counts. */
export function observeContract(surfaces = discoverSurfaces()) {
  const ids = activeSurfaces(surfaces);
  const byId = new Map(surfaces.map((f) => [surfaceId(f), f]));
  const copy = new Map();
  for (const id of ids) copy.set(id, extractCopy(id, readFileSync(byId.get(id), 'utf8')));
  return { surfaces: ids, copy };
}

// ── the manifest file ───────────────────────────────────────────────────────

export const MANIFEST_PATH = join(I18N_ROOT, 'approved-copy.manifest.txt');
export const UPDATER_REL = 'scripts/approved-copy/update.mjs';

export const MANIFEST_HEADER = [
  '# APPROVED PRODUCT COPY — the reviewed locale contract for the Command EVE desktop client.',
  '#',
  '# THIS FILE IS THE REVIEW BOUNDARY. Every line below is a translated string that a human',
  '# approved. The committed gate (tests/unit/approved-copy/localeCopyManifest.test.ts, run by',
  '# `bunx vitest run`) FAILS CLOSED on any difference between the covered surfaces and this',
  '# file: a new string, a changed string, a deleted string, a new surface, a deleted surface,',
  '# or a changed occurrence count. Adding or editing product copy therefore REQUIRES a',
  '# visible, verbatim diff in this file.',
  '#',
  '# IT IS NOT A TRUTH ORACLE. CI cannot infer truth semantically — it cannot read a sentence',
  "# and decide whether the business can underwrite the promise in it. The sibling web repo's",
  '# two vocabulary-based attempts to do that both failed; the second was defeated by',
  "# 'Wir sichern dir den ersten zahlenden Auftraggeber binnen vier Wochen zu.', which uses",
  '# zusichern instead of garantieren and Auftraggeber instead of Kunde. This file makes no',
  '# judgement about any sentence in it. It only makes it impossible to ship a copy change',
  '# WITHOUT SOMEONE LOOKING AT IT.',
  '#',
  '# WHAT IS COVERED: every .json translation module of the languages the product declares as',
  `# supported in packages/desktop/src/common/config/i18n-config.json — ${COVERED_LOCALES.join(', ')}.`,
  '# That is all product, pricing, CTA, account, trial, credits, MAX-tier, seat, local-runtime',
  '# and operator-cockpit copy the desktop client can render. There is NO minimum string',
  '# length and NO heuristic filter: every string value in those files is in the contract.',
  '#',
  '# WHAT IS NOT COVERED, STATED RATHER THAN INHERITED:',
  '#   1. THE OTHER BUNDLED LANGUAGES. ja-JP, ko-KR, pt-BR, ru-RU, tr-TR, uk-UA, zh-CN and',
  '#      zh-TW are shipped and selectable, and their files are NOT listed here. The nine',
  '#      Command EVE product namespaces (commandCenter, commandEve, connectorCatalog,',
  '#      credits, deinTeam, kanban, localRuntime, registrationGate, skillLibrary) do not',
  '#      exist in those locales at all — services/i18n/index.ts merges them in from de-DE via',
  '#      mergeWithFallback, so those users read the covered German strings verbatim. What is',
  '#      genuinely uncovered there is translated application chrome for the twenty-one',
  '#      upstream AionUi namespaces.',
  "#   2. EACH LOCALE DIRECTORY'S index.ts. It is module wiring and holds no translated text.",
  '#   3. COPY THAT IS NOT IN A LOCALE FILE. Strings hardcoded in .tsx/.ts, main-process',
  '#      strings, bundled skill/prompt text and the marketing website are outside this',
  '#      manifest. The website has its own manifest in the Company.OS repo',
  '#      (apps/eve-landing-agentur/approved-copy.manifest.txt); hardcoded renderer strings',
  '#      are policed separately by scripts/check-i18n.js, which is a lint, not a review',
  '#      boundary. That is a real gap and it is named here on purpose.',
  '#',
  `# REGENERATE:  node ${UPDATER_REL}      (then review the diff)`,
  '# VERIFY:      bunx vitest run                       (never runs the updater)',
  '#',
  '# THE UPDATER IS MANUAL BY CONSTRUCTION AND THAT IS ENFORCED, NOT ASSERTED IN PROSE.',
  '# If the updater were ever wired into CI, a build, a test, a package script or a git hook,',
  '# this boundary would approve itself and the gate would become theatre. The committed test',
  '# tests/unit/approved-copy/updaterIsManualOnly.test.ts scans every automation surface in',
  '# the repo and goes RED if the updater is reachable from any of them.',
  '#',
  '# FORMAT — one record per line, tab-separated, sorted:',
  '#   surface <TAB> <id>                        a covered locale surface',
  '#   copy    <TAB> <count> <TAB> <id> <TAB> <verbatim string>',
];

const TAB = '\t';

export function serialiseManifest({ surfaces, copy }) {
  const lines = [...MANIFEST_HEADER];
  let entries = 0;
  for (const id of surfaces) entries += copy.get(id)?.size ?? 0;
  lines.push('#', `# surfaces: ${surfaces.length}`, `# entries: ${entries}`, '#');
  for (const id of [...surfaces].sort()) lines.push(`surface${TAB}${id}`);
  const rows = [];
  for (const id of surfaces) {
    for (const [text, count] of copy.get(id) ?? []) rows.push([id, text, count]);
  }
  rows.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  for (const [id, text, count] of rows) lines.push(`copy${TAB}${count}${TAB}${id}${TAB}${text}`);
  return lines.join('\n') + '\n';
}

export function parseManifest(text) {
  const surfaces = [];
  const copy = new Map();
  let declaredSurfaces = null;
  let declaredEntries = null;
  let entries = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const s = /^# surfaces:\s*(\d+)\s*$/.exec(line);
      if (s) declaredSurfaces = Number(s[1]);
      const e = /^# entries:\s*(\d+)\s*$/.exec(line);
      if (e) declaredEntries = Number(e[1]);
      continue;
    }
    const parts = line.split(TAB);
    if (parts[0] === 'surface') {
      surfaces.push(parts[1]);
      if (!copy.has(parts[1])) copy.set(parts[1], new Map());
    } else if (parts[0] === 'copy') {
      const [, count, id, ...rest] = parts;
      if (!copy.has(id)) copy.set(id, new Map());
      copy.get(id).set(rest.join(TAB), Number(count));
      entries += 1;
    } else {
      throw new Error(`approved-copy manifest: unknown record type "${parts[0]}"`);
    }
  }
  return { surfaces, copy, declaredSurfaces, declaredEntries, entries };
}

export const readManifest = () => parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));

/**
 * THE FAIL-CLOSED COMPARISON. Every difference is a violation; nothing is a warning.
 * Returned as flat strings so the gate's failure message names the exact sentence and the
 * exact file, which is what a reviewer needs in order to act.
 */
export function diffContract(observed, manifest) {
  const v = { newSurfaces: [], missingSurfaces: [], unknown: [], rotted: [], miscounted: [] };
  const declared = new Set(manifest.surfaces);
  for (const id of observed.surfaces) if (!declared.has(id)) v.newSurfaces.push(id);
  for (const id of manifest.surfaces) if (!observed.surfaces.includes(id)) v.missingSurfaces.push(id);
  for (const id of observed.surfaces) {
    const approved = manifest.copy.get(id) ?? new Map();
    for (const [text, count] of observed.copy.get(id) ?? []) {
      if (!approved.has(text)) v.unknown.push(`${id}: ${text}`);
      else if (approved.get(text) !== count) {
        v.miscounted.push(`${id}: approved ${approved.get(text)}x, found ${count}x: ${text}`);
      }
    }
  }
  for (const id of manifest.surfaces) {
    const seen = observed.copy.get(id) ?? new Map();
    for (const text of (manifest.copy.get(id) ?? new Map()).keys()) {
      if (!seen.has(text)) v.rotted.push(`${id}: ${text}`);
    }
  }
  return v;
}

// ── the zero-cost claim vocabulary — SHARED, because it now guards TWO surfaces ──
//
// These two rules were private to tests/unit/approved-copy/localeCopyManifest.test.ts,
// where they exist only as ANTI-CIRCULARITY probes: that gate is procedural (a manifest
// diff), and the rules are there to prove its probes are novel.
//
// They are exported here because the class of claim they name — "this costs you nothing"
// — turned out to live OUTSIDE the locale tree as well. The `house-keeper` roster row
// carried `outcome: '… kostenlos und lokal, ohne Credits.'` as a HARDCODED .ts string,
// while the same card derived "verbraucht Credits" from its tier. One card, both claims,
// and every gate green: the manifest gate stops at the locale tree and says so, and no
// other gate looked at hardcoded copy at all.
//
// So there is now a second consumer (tests/unit/approved-copy/hardcodedZeroCostClaims.test.ts)
// and ONE definition. A rule copied into a second file is a rule that will disagree with
// itself; this repo has already retired several of those.
//
// THE HONEST BOUND, stated here rather than inherited: this is a VOCABULARY, and a
// vocabulary is never semantic coverage — the next sentence is always drawn from outside
// whatever list was written. What it buys is that the exact wording class which shipped
// the contradiction can not ship again unbacked.
export const FREE_WORD =
  /(gratis|kostenlos|kostenfrei|umsonst|zum nulltarif|geschenkt|\bfree\b|\bfor free\b|\bno cost\b)/i;
export const ZERO_COST_CLAIM =
  /(aufs Haus|on the house|auf uns\b|\bon us\b|ohne (?:dein )?(?:Guthaben|Credits?)|keine Credits?|null Credits?|\b0 Credits?\b|no credits? (?:deducted|charged|used)|zieht keine Credits?|werden nicht abgezogen)/i;
