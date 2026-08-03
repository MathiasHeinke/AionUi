/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the ONE media-lane intent gate for the composer's media controls.
 *
 * FOUNDER CONTRACT (2026-08-03, refined by CoS): media option controls are
 * CONTEXTUAL to INTENT, never to content alone. An ordinary chat or draft —
 * "Hallo", "Danke", "Was kannst du?", a topic change — shows neither image
 * nor video controls, even when the conversation visibly contains a media
 * artifact. The artifact on screen is CONTEXT, not intent: it may resolve
 * WHICH medium a genuine mutation intent targets; it may never activate
 * controls by itself.
 *
 * The resolution contract, in order:
 *
 *   1. EXPLICIT image create/edit intent → image controls.
 *   2. EXPLICIT video create/edit intent → video controls.
 *      (Explicit video beats explicit image when a draft carries both:
 *      the most expensive lane wins the visible price.)
 *   3. A genuinely GENERIC artifact-mutation/reference intent PLUS the
 *      latest visible relevant artifact → the artifact's KIND decides image
 *      vs video. "Generic" means the mutation families below (add/put/give/
 *      change/edit/remove/replace/crop/animate/recolor and the German
 *      equivalents füge hinzu, gib … ein/eine/einen, setze, ändere,
 *      bearbeite, entferne, ersetze, schneide) — semantic families, never
 *      one pinned sentence. Greetings, thanks, questions, analysis/review
 *      requests, "mach weiter" and unrelated imperatives are excluded BEFORE
 *      the mutation families run.
 *   4. Artifact presence without create/edit/mutation intent → null.
 *   5. Explicit current-draft intent overrides artifact context. Image and
 *      video are structurally mutually exclusive (one return value).
 *
 * AUTHORITY BOUNDARY: the Hermes artifact envelope remains the authority for
 * actual TARGET resolution at send time. This renderer gate answers exactly
 * one question — whether preflight controls should be VISIBLE. It does not
 * route, does not name a target artifact, and invents no hard-coded artifact
 * ID path. Revealing controls is free by construction: no provider, upload
 * or debit may follow from it.
 *
 * The explicit-intent half is a GENERALIZATION OF THE EXISTING VIDEO GATE
 * (`isVideoLaneRequest` in videoCostCore.ts: addressed agent, resolved
 * skills, capability flag, NL classifier as last resort) — the image
 * predicate below is built from the same pattern families so the two lanes
 * read as one mechanism, not two hacks.
 *
 * PURE: no fs, no Electron, no IPC.
 */

import { isVideoLaneRequest, type VideoLaneRouting } from './videoCostCore';

export type MediaLane = 'image' | 'video';

/**
 * NL classifier for image creation/edit requests — the mirror of
 * `isVideoGenerationRequest`, same pattern families, same fail-closed
 * empty-input rule. Creation phrasing only: "show me the photo from
 * yesterday" must never match.
 */
const IMAGE_GENERATION_PATTERNS: readonly RegExp[] = [
  // EN: "generate/create/make/draw/design an image/picture/icon/logo/poster"
  /\b(generate|create|make|produce|render|draw|paint|design|build|whip\s+up)\b[^.!?]{0,60}\b(image|picture|photo|icon|logo|illustration|artwork|poster|thumbnail|wallpaper|avatar|graphic|cover\s?art)s?\b/i,
  // EN: noun-first — "an icon for ... — create it", "profile picture"
  /\b(image|picture|photo|icon|logo|illustration|artwork|poster|thumbnail|wallpaper|avatar|profile\s+picture|cover\s?art)s?\b[^.!?]{0,60}\b(generate|create|make|produce|render|draw|design|build|für\s+mich|for\s+me)\b/i,
  // EN: format/lane keywords — "text-to-image", "ai image", "image generation"
  /\b(text[-\s]?to[-\s]?image|img[-\s]?to[-\s]?image|image[-\s]?to[-\s]?image|image\s+gen(eration)?|ai\s+image|ai\s+art|image\s+edit|edit\s+(this|the|that)\s+(image|picture|photo))\b/i,
  // DE: "erstelle/mach/generiere/zeichne/male ein Bild/Foto/Icon/Logo".
  // `schneid` stays OUT here ("schneide ein Bild" is cropping, not generating).
  /\b(erstell|erstelle|erstellst|mach|mache|machst|generier|generiere|generierst|produzier|produziere|zeichn|zeichne|mal|male|erzeug|erzeuge|bau|baue|design|entwirf|brauch|brauche|brauchst|braucht|möcht|möchte|möchtest|hätte?\s+gern)\b[^.!?]{0,60}\b(bild|bilder|foto|icon|logo|illustration|grafik|poster|thumbnail|avatar|profilbild|titelfoto)s?\b/i,
  // DE: verb-after-noun — "Bild erstellen/generieren", "Logo entwerfen".
  /\b(bild|bilder|foto|icon|logo|illustration|grafik|poster|thumbnail|avatar|profilbild|titelfoto)s?\b[^.!?]{0,60}\b(erstellen|erstell|generieren|generier|produzieren|produzier|zeichnen|zeichn|malen|machen|mach|erzeugen|erzeug|bauen|bau|entwerfen|entwirf|für\s+mich)\b/i,
];

/** Empty / whitespace / non-string input is never an image-creation request. */
export function isImageLaneRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return IMAGE_GENERATION_PATTERNS.some((re) => re.test(text));
}

/**
 * Explicit image EDIT phrasing with a medium noun ("bearbeite das Bild",
 * "edit this image"). An edit is a different operation than a create — the
 * discriminated resolver below never confuses the two, so the UI can never
 * promise creation settings for an edit the tool cannot honour.
 */
const IMAGE_EDIT_PATTERNS: readonly RegExp[] = [
  /\b(bearbeit|bearbeite|veränder|verändere|ändere|ändre|editier|editiere|ergänz|ergänze|füg|füge)\b[^.!?]{0,40}\b(bild|bilder|foto|icon|logo)\b/i,
  /\b(bild|bilder|foto|icon|logo)\b[^.!?]{0,30}\b(bearbeiten|verändern|ändern|editieren)\b/i,
  /\b(edit|change|modify|retouch|restyle|adjust|crop|recolou?r)\b[^.!?]{0,40}\b(image|picture|photo|icon|logo)s?\b/i,
  /\b(image|picture|photo|icon|logo)\s+edit\b/i,
];

/** Explicit video EDIT phrasing with a medium noun ("bearbeite das Video"). */
const VIDEO_EDIT_PATTERNS: readonly RegExp[] = [
  /\b(bearbeit|bearbeite|veränder|verändere|ändere|ändre|editier|editiere|schneid|kürz)\w*\b[^.!?]{0,40}\b(video|clip|reel|kurzvideo)s?\b/i,
  /\b(video|clip|reel|kurzvideo)s?\b[^.!?]{0,30}\b(bearbeiten|verändern|ändern|editieren|schneiden|kürzen)\b/i,
  /\b(edit|trim|cut|crop|modify|retouch|restyle|animate|recolou?r)\b[^.!?]{0,40}\b(video|clip|reel|footage|movie)s?\b/i,
  /\b(video|clip)s?\s+(edit|trim)\b/i,
];

/** True iff the draft explicitly asks to EDIT an image (medium named). */
export function isImageEditRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return IMAGE_EDIT_PATTERNS.some((re) => re.test(text));
}

/** True iff the draft explicitly asks to EDIT a video (medium named). */
export function isVideoEditRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return VIDEO_EDIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Greetings, thanks, closings, and continuation filler. These are never an
 * artifact mutation, whatever artifact is on screen. Anchored to the whole
 * message (modulo punctuation) so "Hallo, und jetzt bearbeite das Bild" can
 * still resolve through the mutation families.
 */
const PLEASANTRY_PATTERNS: readonly RegExp[] = [
  /^\s*(hallo|hi|hey|moin|servus|grüß\s?dich|guten\s+(morgen|tag|abend)|good\s+(morning|afternoon|evening)|hello)\b[\s!.]*$/i,
  /^\s*(danke|danke\s+schön|vielen\s+dank|thanks?|thank\s+you|thx|merci)\b[\s!.]*$/i,
  /^\s*(ok(ay)?|alles\s+klar|passt|perfekt|super|toll|great|nice|cool|weiter|mach\s+weiter|continue|go\s+on|ja|jap|yes|nein|no|nö)\b[\s!.]*$/i,
];

/**
 * Opinion, analysis, review and question requests. Asking ABOUT an artifact
 * is not mutating it. ("Kannst du der Aubergine ein Gesicht geben?" is a
 * request and survives: it matches a mutation family; "Was hältst du davon?"
 * matches nothing below and stays null.)
 */
const ANALYSIS_PATTERNS: readonly RegExp[] = [
  /\b(was\s+(hältst|meinst|denkst)|wie\s+findest|analysier|analyse|bewert|bewerte|review|erklär|erkläre|beschreib|beschreibe|interpretier|was\s+(siehst|erkennst)|ist\s+das|was\s+ist|was\s+kannst\s+du)\b/i,
  /\b(what\s+do\s+you\s+(think|see|make)|analy[sz]e|review|explain|describe|interpret|tell\s+me\s+about)\b/i,
  /\?[\s]*$/,
];

/** Meta targets that are not the visible artifact: app, chat, settings… */
const META_TARGET_PATTERN =
  /\b(chat|konversation|conversation|verlauf|app|anwendung|einstellungen|settings|account|konto|profil\s+seite|modellwahl|skill|agent|workspace|projektordner)\b/i;

/**
 * GENERIC artifact-mutation families — the draft asks to change something,
 * without naming a medium. The visible artifact supplies the medium.
 * EN: add/put/give/change/edit/remove/replace/crop/animate/recolor/adjust…
 * DE: füge … hinzu, gib … ein/eine/einen, setze, ändere, bearbeite,
 * entferne, ersetze, schneide, animiere, färbe um.
 */
const ARTIFACT_MUTATION_PATTERNS: readonly RegExp[] = [
  /\b(add|put|give|place|insert|attach|append|change|edit|modify|adjust|remove|delete|replace|swap|crop|animate|recolou?r|darken|lighten|blur|sharpen|resize|rotate|flip|retouch|restyle|tweak)\b/i,
  /\bfüg\w*\s+[^.!?]{0,40}\s*(hinzu|dazu|ein|eine|einen)\b/i,
  /\bgib\w*\s+[^.!?]{0,40}\s+(ein|eine|einen|einem|einer)\b/i,
  /\bsetz\w*\s+[^.!?]{0,30}\s*(ein|drauf|darauf|auf|davor|dahinter|zusammen)\b/i,
  /\b(änder|veränder|bearbeit|entfern|lösch|ersetz|schneid|kürz|animier|umfärb|färb\w*\s+[^.!?]{0,30}\s+um|einfärb|aufhell|abdunkel|verpixel|schärf|dreh|spiegel|rettuschier|überarbeit)\w*\b/i,
];

/** True iff the draft is a genuine generic artifact-mutation/reference intent. */
export function isArtifactMutationIntent(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  if (PLEASANTRY_PATTERNS.some((re) => re.test(text))) return false;
  if (ANALYSIS_PATTERNS.some((re) => re.test(text))) return false;
  if (META_TARGET_PATTERN.test(text)) return false;
  return ARTIFACT_MUTATION_PATTERNS.some((re) => re.test(text));
}

/** The artifact payload kinds this gate reads as media context. */
export type MediaArtifactType = 'image' | 'video';

/**
 * The UI-ONLY result of the intent gate (CoS 2026-08-03, second correction):
 *
 *   - `{ operation: 'none' }` — ordinary chat: visually clean, no controls.
 *   - `{ operation: 'create', medium }` — an explicit creation request: the
 *     full relevant CREATION options may show (image model selector, or the
 *     video generation settings). `create + video` may use the existing
 *     direct videoGenerate branch at send.
 *   - `{ operation: 'edit-hint', medium }` — a genuine edit/mutation intent
 *     over a visible source artifact. This is a HINT for preflight
 *     affordances only: it MUST remain a normal Hermes dispatch turn, it
 *     never widens the direct generation branch, it infers no
 *     selectedArtifactIds and names no target — the Hermes artifact envelope
 *     and the eve_video_edit tool resolve the actual handle semantically at
 *     send time. An edit-hint NEVER shows creation settings the edit tool
 *     cannot honour (a video edit inherits source quality/duration).
 */
export type MediaLaneIntent =
  | { operation: 'none' }
  | { operation: 'create'; medium: MediaLane }
  | { operation: 'edit-hint'; medium: MediaLane };

export interface MediaLaneIntentInput extends VideoLaneRouting {
  /**
   * The `artifact_type` of the LATEST VISIBLE, SOURCE-CAPABLE conversation
   * artifact (`'image'` or `'video'`; anything else is passed as null by the
   * caller). CONTEXT, never intent: used only to disambiguate a genuine
   * mutation intent, per the contract above. Dismissed, failed or
   * source-less media must already be filtered out by the caller's shared
   * visible-artifact selector.
   */
  latestVisibleArtifactType?: MediaArtifactType | null;
}

const NONE: MediaLaneIntent = { operation: 'none' };

/**
 * Which media controls — if any — belong in the draft band for this draft in
 * this conversation. Visibility only: no routing, no target id, no provider,
 * no debit, no send decision.
 */
export function resolveMediaLaneIntent(input: MediaLaneIntentInput): MediaLaneIntent {
  // 1+2. EXPLICIT CREATE intent wins, video before image (the most expensive
  // lane takes the visible price when a draft carries both). Semantics of
  // the shipped video gate untouched.
  if (
    isVideoLaneRequest({
      message: input.message,
      resolvedAgentId: input.resolvedAgentId ?? null,
      ...(input.resolvedSkills === undefined ? {} : { resolvedSkills: input.resolvedSkills }),
      ...(input.resolvedVideoCapability === undefined
        ? {}
        : { resolvedVideoCapability: input.resolvedVideoCapability }),
    })
  ) {
    return { operation: 'create', medium: 'video' };
  }
  if (isImageLaneRequest(input.message)) return { operation: 'create', medium: 'image' };

  // 3. EDIT intent — and an edit is only offerable with a visible source of
  // the SAME medium. Without one there is nothing the affordance could
  // honestly promise, so the answer is `none` (the turn still goes out; the
  // agent says what is missing).
  const artifactType = input.latestVisibleArtifactType ?? null;
  if (artifactType) {
    if (artifactType === 'image' && isImageEditRequest(input.message)) {
      return { operation: 'edit-hint', medium: 'image' };
    }
    if (artifactType === 'video' && isVideoEditRequest(input.message)) {
      return { operation: 'edit-hint', medium: 'video' };
    }
    // GENERIC mutation intent: the artifact's KIND disambiguates. This is
    // the "Gib der Aubergine ein Gesicht" case — and the only way the
    // artifact may influence anything.
    if (isArtifactMutationIntent(input.message)) {
      return { operation: 'edit-hint', medium: artifactType };
    }
  }

  // 4. Everything else: ordinary chat, no controls — including "Hallo",
  // "Danke", "Was hältst du davon?" and topic changes in a conversation
  // that happens to show an artifact.
  return NONE;
}
