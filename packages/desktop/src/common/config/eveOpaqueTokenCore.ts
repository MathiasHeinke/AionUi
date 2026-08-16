/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shape primitives for the opaque tokens on the paid-edit path.
 *
 * Every check here is a character-code scan, and that is not a style preference.
 * The semantic gate over this path forbids `RegExp`, `.test(`, `.match(`,
 * `.indexOf(` and `startsWith` as well as the obvious `toLowerCase`/`.includes(`
 * pair — because a structural test cannot judge intent, and a gate that tried to
 * allow "the harmless regexes" would be a gate that argues with itself. So the
 * whole path carries no regular expression at all and the ban can stay flat and
 * checkable.
 *
 * The scans are also length-total on purpose: they look at every character
 * rather than returning early, so a shape check on a secret does not hand out
 * its prefix through timing. That is a weaker property than the constant-time
 * comparison that follows it, but it costs nothing here.
 *
 * PURE: no fs, no crypto, no Electron.
 */

const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_LOWER_Z = 122;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_HYPHEN = 45;
const CHAR_DOT = 46;
const CHAR_COLON = 58;
const CHAR_UNDERSCORE = 95;
const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_CR = 13;

/** `value` begins with `prefix` — spelled without `startsWith`, see the header. */
export function hasAsciiPrefix(value: string, prefix: string): boolean {
  if (typeof value !== 'string' || value.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (value.charCodeAt(i) !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** Exactly `length` lowercase hex characters — the shape every digest here has. */
export function isLowerHexOfLength(value: unknown, length: number): boolean {
  if (typeof value !== 'string' || value.length !== length) return false;
  let bad = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= CHAR_0 && code <= CHAR_9;
    const isHexLetter = code >= CHAR_LOWER_A && code <= CHAR_LOWER_F;
    bad |= isDigit || isHexLetter ? 0 : 1;
  }
  return bad === 0;
}

/** A SHA-256 digest as this codebase writes them: 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): boolean {
  return isLowerHexOfLength(value, 64);
}

/**
 * `<prefix><64 hex>` — the single shape both the long-lived capability handle
 * and the ephemeral spend permit take. Sharing it means a future third token
 * cannot quietly invent a looser one.
 */
export function isOpaqueToken(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== prefix.length + 64) return false;
  if (!hasAsciiPrefix(value, prefix)) return false;
  return isLowerHexOfLength(value.slice(prefix.length), 64);
}

/**
 * The identifier shape this app writes for conversations, turns, messages,
 * seats, queue items and durable artifact records: an alphanumeric first
 * character followed by up to 255 more from the same set plus `: . _ -`.
 *
 * It lives HERE, as one exported owner, for two independent reasons.
 *
 * First, the semantic gate over the paid-edit path forbids every string-matching
 * primitive in the modules it covers, so a caller on that path cannot spell this
 * shape as a literal at all — not even as a harmless form check, because a
 * structural test cannot tell a form check from a keyword classifier.
 *
 * Second, the shape is a boundary invariant: the renderer-facing policy, the
 * bridge and the durable Office store must accept exactly the same identifiers.
 * A second spelling that drifted by one character class would let a value pass
 * one fence and fail the next, which reads as data corruption rather than as
 * the refusal it actually is.
 *
 * Deliberately NOT reusing the two neighbouring predicates: the managed-image
 * record check is module-private and caps at 128 characters, and the external
 * action id allows `/` while forbidding `.`. Either would silently narrow the
 * identifiers this path already persists.
 */
export function isSafeOpaqueRecordId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= CHAR_0 && code <= CHAR_9;
    const isUpper = code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z;
    const isLower = code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z;
    const isSeparator = code === CHAR_COLON || code === CHAR_DOT || code === CHAR_UNDERSCORE || code === CHAR_HYPHEN;
    // A leading separator would make an identifier that sorts and reads like a
    // relative path, so the first character is alphanumeric without exception.
    if (!isDigit && !isUpper && !isLower && (i === 0 || !isSeparator)) return false;
  }
  return true;
}

/** Lowercase hex for a byte array, without reaching for a Buffer in `common/`. */
export function toLowerHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Collapse every run of tab/CR/LF into ONE space.
 *
 * This is what keeps a single artifact entry on a single line in the context
 * envelope. A value that could inject a newline could forge an entry, so this
 * runs on every scalar that reaches the envelope.
 */
export function collapseInlineWhitespace(value: string): string {
  let out = '';
  let inRun = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === CHAR_TAB || code === CHAR_LF || code === CHAR_CR) {
      if (!inRun) out += ' ';
      inRun = true;
      continue;
    }
    inRun = false;
    out += value[i];
  }
  return out;
}

/**
 * Does this string contain anything a person could have meant?
 *
 * A PREDICATE, never a transformer, and that distinction is the whole reason it
 * exists. The send path needs to know whether a turn is empty, and the obvious
 * `text.trim().length > 0` invites the next line to hash the trimmed value —
 * which is exactly what happened: two turns differing only by a leading space
 * collapsed into one digest, and every binding built on that digest quietly
 * covered both. This judges the value and hands back a boolean, so nothing
 * downstream can mistake a judgement for a cleaned-up copy.
 *
 * Space, tab, CR, LF, form feed, vertical tab and NBSP count as blank; anything
 * else counts as content. It is deliberately NOT a full Unicode whitespace
 * table — a false "this has content" is harmless here (the digest is still of
 * the exact bytes), while normalising the value would not be.
 */
export function hasVisibleCharacters(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isBlank = code === 32 || code === 160 || (code >= 9 && code <= 13);
    if (!isBlank) return true;
  }
  return false;
}

/**
 * Length-independent, content-constant-time comparison of two ASCII strings.
 *
 * Used wherever a presented secret is judged against a stored one. An early-exit
 * `===` leaks the matching prefix through timing to anything that can measure
 * the lookup, and both the handle and the permit are exactly the kind of secret
 * an attacker gets to submit repeatedly.
 */
export function constantTimeAsciiEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
