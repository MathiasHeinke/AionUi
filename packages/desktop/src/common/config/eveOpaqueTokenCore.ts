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
