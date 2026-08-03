/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the ONE media-lane intent gate for the composer's media controls.
 *
 * FOUNDER INVARIANT (2026-08-03, final refinement): ordinary chat shows NO
 * image/video options. Image options appear only when the user genuinely
 * wants IMAGE work; video creation settings only when the user genuinely
 * wants to CREATE a video. Artifact presence is CONTEXT, never intent.
 * Follow-up edits stay normal Hermes turns and are never routed into direct
 * paid video generation.
 *
 * PRECISION OVER RECALL, BY DESIGN: an edit affordance requires an EXPLICIT
 * MEDIUM NOUN plus edit/mutation semantics ("Bearbeite das Bild", "Schneide
 * das Video", "Gib der Aubergine im Video ein Gesicht", "edit this clip").
 * There is deliberately NO generic mutation-verb authority and NO denylist
 * to grow: a bare "add/change/remove/give" without a medium noun is
 * ordinary work and shows NOTHING. An ambiguous "Gib der Aubergine ein
 * Gesicht" (no medium noun) shows no hint either — Hermes still receives
 * the full conversation and artifact envelope and can perform the edit.
 * The controls are preflight affordances, never semantic authority.
 *
 * The resolution contract, in order:
 *
 *   1. EXPLICIT video EDIT (medium noun + edit semantics) → edit-hint/video,
 *      but only with a visible, canonically EDIT-ELIGIBLE video source.
 *      This check runs FIRST: explicit edit recognition vetoes creation —
 *      "Schneide das Video." and "Mach das Video heller." must never fall
 *      into the video-creation regex and therefore never into the direct
 *      videoGenerate branch (the shared send-path veto below is the same
 *      predicate).
 *   2. EXPLICIT image EDIT → edit-hint/image with a visible image source.
 *   3. EXPLICIT video CREATE (the shipped video gate, semantics untouched)
 *      → create/video.
 *   4. EXPLICIT image CREATE → create/image.
 *   5. Everything else → none. Mixed-media conversations change nothing:
 *      explicit edit intent binds to the matching MEDIUM's source
 *      ("Bearbeite das Bild" needs a visible IMAGE even when the newest
 *      artifact is a video, and vice versa).
 *
 * AUTHORITY BOUNDARY: this gate is VISIBILITY ONLY. No routing, no target
 * id, no selectedArtifactIds, no provider, no debit. The Hermes artifact
 * envelope remains the authority for actual target resolution at send.
 *
 * UNICODE: every pattern here uses LETTER-AWARE boundaries
 * (`(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])` with the `u` flag), because
 * JavaScript's `\b` is ASCII-only and fails before an initial Ä/Ö/Ü —
 * "Ändere das Video" must match as reliably as "Bearbeite das Video".
 *
 * PURE: no fs, no Electron, no IPC.
 */

import { isVideoLaneRequest, type VideoLaneRouting } from './videoCostCore';

export type MediaLane = 'image' | 'video';

/** Letter-aware boundary pieces (JS `\b` is ASCII-only and breaks on ÄÖÜ). */
const LB = String.raw`(?<![\p{L}\p{N}])`;
const RB = String.raw`(?![\p{L}\p{N}])`;

const IMAGE_NOUN = String.raw`(?:bild|bilder|fotos?|icons?|logos?|illustrations?|grafik|posters?|thumbnails?|avatars?|profilbild\w*|titelfotos?|images?|pictures?|photos?|artworks?|wallpapers?|graphics?|cover\s?arts?)`;
const VIDEO_NOUN = String.raw`(?:videos?|clips?|reels?|kurzvideos?|footage|movies?)`;

const CREATE_VERBS_DE = String.raw`(?:erstell\w*|mach\w*|generier\w*|produzier\w*|zeichn\w*|mal\w*|erzeug\w*|bau\w*|design\w*|entwirf\w*|brauch\w*|möcht\w*|hätte?\s+gern)`;
const CREATE_VERBS_EN = String.raw`(?:generate|create|make|produce|render|draw|paint|design|build|whip\s+up)`;

/** Edit/mutation semantics — verbs and derived adjectives, never a medium. */
const EDIT_SEMANTICS_DE = String.raw`(?:bearbeit\w*|veränder\w*|änder\w*|ändre\w*|editier\w*|schneid\w*|kürz\w*|entfern\w*|lösch\w*|ersetz\w*|animier\w*|färb\w*|einfärb\w*|aufhell\w*|heller|abdunkel\w*|dunkler|verpixel\w*|schärf\w*|spiegel\w*|rettuschier\w*|überarbeit\w*|ergänz\w*|füg\w*\s+[^.!?]{0,30}\s+(?:hinzu|dazu)\b|füg\w*\s+[^.!?]{0,20}\s+(?:ein|eine|einen)\b|gib\w*\s+[^.!?]{0,40}\s+(?:ein|eine|einen|einem|einer)\b|setz\w*\s+[^.!?]{0,30}\s+(?:drauf|darauf|auf|davor|dahinter|zusammen))`;
// give/add/put were REMOVED (Grok MAJOR): "Give me a video of …" and "Add a
// video of …" are CREATE idioms, and a medium noun plus these verbs alone
// must never read as an edit. insert/attach/append were REMOVED too (Grok
// final MAJOR): they are ordinary workplace verbs ("insert the table",
// "attach the contract", "append the signature"), and with an artifact on
// screen they lit edit affordances on non-edit language.
const EDIT_SEMANTICS_EN = String.raw`(?:edit|change|modify|adjust|remove|delete|replace|swap|crop|animate|animates|animating|recolou?r|darken|darker|lighten|lighter|brighten|brighter|blur|sharpen|resize|rotate|flip|retouch|restyle|tweak|trim|cut)`;

const IMAGE_NOUN_RE = new RegExp(`${LB}${IMAGE_NOUN}${RB}`, 'iu');
const VIDEO_NOUN_RE = new RegExp(`${LB}${VIDEO_NOUN}${RB}`, 'iu');
const EDIT_SEMANTICS_DE_RE = new RegExp(`${LB}${EDIT_SEMANTICS_DE}${RB}`, 'iu');
const EDIT_SEMANTICS_EN_RE = new RegExp(`${LB}${EDIT_SEMANTICS_EN}${RB}`, 'iu');

/**
 * STRONG explicit creation — the precedence discriminator (CoS 2026-08-03):
 * a creation VERB PHRASE for new output (erstell|generier|produzier|erzeug|
 * design|entwirf|generate|create|produce|render|draw|paint|build) or an
 * unambiguous request idiom for new output ("Gib mir ein Video von …",
 * "Give me a video of …"). Edit-like WORDS in the same message ("Erstelle
 * ein animiertes Video", "Erstelle ein Bild und füge darauf ein Logo
 * hinzu", "Create an animated video") do NOT turn a strong creation into an
 * edit. `mach`/`make` stay OUT of the strong list deliberately: "Mach das
 * Video heller" is an edit, and only the explicit creation families above
 * may outrank edit semantics.
 */
const STRONG_CREATE_VERBS_DE = String.raw`(?:erstell\w*|generier\w*|produzier\w*|erzeug\w*|bau\w*|design\w*|entwirf\w*)`;
const STRONG_CREATE_VERBS_EN = String.raw`(?:generate|create|produce|render|draw|paint|design|build|whip\s+up)`;

const VIDEO_CREATE_STRONG_PATTERNS: readonly RegExp[] = [
  new RegExp(`${LB}${STRONG_CREATE_VERBS_DE}${RB}[^.!?]{0,60}${LB}${VIDEO_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${VIDEO_NOUN}${RB}[^.!?]{0,60}${LB}${STRONG_CREATE_VERBS_DE}${RB}`, 'iu'),
  new RegExp(`${LB}${STRONG_CREATE_VERBS_EN}${RB}[^.!?]{0,60}${LB}${VIDEO_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${VIDEO_NOUN}${RB}[^.!?]{0,60}${LB}${STRONG_CREATE_VERBS_EN}${RB}`, 'iu'),
  // unambiguous request idioms for NEW output
  new RegExp(`${LB}gib\\w*\\s+(?:mir|uns)\\b[^.!?]{0,40}${LB}${VIDEO_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}give\\s+me\\b[^.!?]{0,40}${LB}${VIDEO_NOUN}${RB}`, 'iu'),
];

const IMAGE_CREATE_STRONG_PATTERNS: readonly RegExp[] = [
  new RegExp(`${LB}${STRONG_CREATE_VERBS_DE}${RB}[^.!?]{0,60}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${IMAGE_NOUN}${RB}[^.!?]{0,60}${LB}${STRONG_CREATE_VERBS_DE}${RB}`, 'iu'),
  new RegExp(`${LB}${STRONG_CREATE_VERBS_EN}${RB}[^.!?]{0,60}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${IMAGE_NOUN}${RB}[^.!?]{0,60}${LB}${STRONG_CREATE_VERBS_EN}${RB}`, 'iu'),
  new RegExp(`${LB}gib\\w*\\s+(?:mir|uns)\\b[^.!?]{0,40}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}give\\s+me\\b[^.!?]{0,40}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
];

/** Strong explicit VIDEO creation (the precedence discriminator, shared). */
export function isExplicitVideoCreateRequest(message: string | null | undefined): boolean {
  return matchesAny(VIDEO_CREATE_STRONG_PATTERNS, message);
}

/** Strong explicit IMAGE creation (the precedence discriminator, shared). */
export function isExplicitImageCreateRequest(message: string | null | undefined): boolean {
  return matchesAny(IMAGE_CREATE_STRONG_PATTERNS, message);
}

const IMAGE_CREATION_PATTERNS: readonly RegExp[] = [
  // EN verb-first / noun-first
  new RegExp(`${LB}${CREATE_VERBS_EN}${RB}[^.!?]{0,60}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${IMAGE_NOUN}${RB}[^.!?]{0,60}${LB}${CREATE_VERBS_EN}${RB}`, 'iu'),
  // EN lane keywords
  new RegExp(
    `${LB}(?:text[-\\s]?to[-\\s]?image|img[-\\s]?to[-\\s]?image|image[-\\s]?to[-\\s]?image|image\\s+gen(?:eration)?|ai\\s+image|ai\\s+art)${RB}`,
    'iu'
  ),
  // DE verb-first / noun-first
  new RegExp(`${LB}${CREATE_VERBS_DE}${RB}[^.!?]{0,60}${LB}${IMAGE_NOUN}${RB}`, 'iu'),
  new RegExp(`${LB}${IMAGE_NOUN}${RB}[^.!?]{0,60}${LB}${CREATE_VERBS_DE}${RB}`, 'iu'),
];

function matchesAny(patterns: readonly RegExp[], message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return patterns.some((re) => re.test(text));
}

/** Explicit image-CREATION intent (generation). */
export function isImageLaneRequest(message: string | null | undefined): boolean {
  return matchesAny(IMAGE_CREATION_PATTERNS, message);
}

/**
 * EXPLICIT edit intent = an explicit MEDIUM NOUN plus edit/mutation
 * semantics, matched independently (order-free) — AND NOT a strong explicit
 * creation for that medium (the shared precedence rule: "Erstelle ein
 * animiertes Video" and "Create an animated video" are CREATE even though
 * they carry edit-like words; "Mach das Video heller", "Schneide das
 * Video", "Animate this video" stay EDIT).
 *
 * THIS IS ALSO THE SHARED SEND-PATH VETO for video: AcpSendBox's direct
 * videoGenerate branch must refuse when the video form matches, so an edit
 * can never be mis-routed into a fresh paid generation — even with NO
 * eligible source, the turn goes to Hermes, which explains a missing target
 * honestly.
 */
export function isExplicitVideoEditRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  if (isExplicitVideoCreateRequest(message)) return false;
  return VIDEO_NOUN_RE.test(message) && (EDIT_SEMANTICS_DE_RE.test(message) || EDIT_SEMANTICS_EN_RE.test(message));
}

/** EXPLICIT image EDIT intent, with the same creation precedence. */
export function isImageEditRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  if (isExplicitImageCreateRequest(message)) return false;
  return IMAGE_NOUN_RE.test(message) && (EDIT_SEMANTICS_DE_RE.test(message) || EDIT_SEMANTICS_EN_RE.test(message));
}

/** The artifact payload kinds this gate reads as media context. */
export type MediaArtifactType = 'image' | 'video';

/**
 * Per-medium source truth, supplied by the caller's shared selector:
 * whether a VISIBLE, edit-eligible source of that medium exists RIGHT NOW.
 * The gate never looks at artifacts itself — context is injected, and only
 * to bind explicit edit intent to a matching medium.
 */
export interface MediaLaneSources {
  image: boolean;
  video: boolean;
}

/**
 * The UI-ONLY result of the intent gate:
 *   - `{ operation: 'none' }` — ordinary chat: visually clean, no controls.
 *   - `{ operation: 'create', medium }` — explicit creation: the full
 *     relevant CREATION options (image selector / video generation settings).
 *   - `{ operation: 'edit-hint', medium }` — explicit edit intent over a
 *     visible, eligible source of the SAME medium. A compact affordance
 *     only: never creation settings the edit cannot honour, never a
 *     promise without a source.
 */
export type MediaLaneIntent =
  | { operation: 'none' }
  | { operation: 'create'; medium: MediaLane }
  | { operation: 'edit-hint'; medium: MediaLane };

export interface MediaLaneIntentInput extends VideoLaneRouting {
  /** Per-medium visible, edit-eligible source availability (see above). */
  sources?: MediaLaneSources;
}

const NONE: MediaLaneIntent = { operation: 'none' };

/**
 * Which media controls — if any — belong in the draft band for this draft
 * in this conversation. Visibility only: no routing, no target id, no
 * provider, no debit, no send decision.
 */
export function resolveMediaLaneIntent(input: MediaLaneIntentInput): MediaLaneIntent {
  const sources = input.sources ?? { image: false, video: false };

  // 1. EXPLICIT VIDEO EDIT — first, always. The edit veto outranks the
  // creation regex in BOTH directions the text can travel (visibility and
  // send routing). Without a visible edit-eligible video source there is
  // nothing the affordance could honestly promise → none; the turn still
  // goes out through Hermes, which explains the missing target.
  if (isExplicitVideoEditRequest(input.message)) {
    return sources.video ? { operation: 'edit-hint', medium: 'video' } : NONE;
  }
  // 2. EXPLICIT IMAGE EDIT — same contract against a visible image source.
  if (isImageEditRequest(input.message)) {
    return sources.image ? { operation: 'edit-hint', medium: 'image' } : NONE;
  }
  // 3. EXPLICIT VIDEO CREATE — the shipped gate plus the strong creation
  // families (request idioms like "Gib mir ein Video von …" are creation,
  // not edit; the precedence discriminator is shared with the veto above).
  if (
    isVideoLaneRequest({
      message: input.message,
      resolvedAgentId: input.resolvedAgentId ?? null,
      ...(input.resolvedSkills === undefined ? {} : { resolvedSkills: input.resolvedSkills }),
      ...(input.resolvedVideoCapability === undefined
        ? {}
        : { resolvedVideoCapability: input.resolvedVideoCapability }),
    }) ||
    isExplicitVideoCreateRequest(input.message)
  ) {
    return { operation: 'create', medium: 'video' };
  }
  // 4. EXPLICIT IMAGE CREATE.
  if (isImageLaneRequest(input.message) || isExplicitImageCreateRequest(input.message)) {
    return { operation: 'create', medium: 'image' };
  }
  // 5. Ordinary chat — including bare mutation verbs without a medium noun.
  return NONE;
}
