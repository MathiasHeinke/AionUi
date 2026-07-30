/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE VIDEO generation — pure cost core.
 *
 * Video is the most expensive action in the credit economy: one ~5s clip can cost
 * an order of magnitude more than a chat turn or an image. This module owns the
 * credit MATH, the default-tier DECISION and the intent classifier.
 *
 * It used to open a blocking cost preview before every generation and this header
 * said the desktop "NEVER fires a video generation silently". That is no longer
 * how the product works: asking for a video is the authorisation for it, the same
 * way attaching an image is the authorisation to analyse it. The confirmation was
 * a second question about an intent the request already carried.
 *
 * What protects the money is server-side. This module never was a brake, and the
 * brake it used to name was the wrong one: `reservePaidLane` → `canAfford` lives
 * in eve-inference, and video does not go through eve-inference at all — the
 * deployed function contains no reference to video. Video routes to
 * `eve-multimodal`, and its reservation runs there, before the provider call.
 * Citing the inference brake here made a limit sound like it covered a lane it
 * has never seen.
 *
 * The cheaper Fast/720p tier remains the default, and the picker is inline and
 * non-blocking (VideoQualityPill).
 *
 * The tier list is CAPABILITY-AWARE, and that is not a refinement — it is a
 * correction. The selector previously offered 1080p to everyone. Per the official
 * xAI model profiles, `grok-imagine-video` (the only text-to-video model) tops out
 * at 720p, and `grok-imagine-video-1.5`, which does reach 1080p, is IMAGE->VIDEO
 * ONLY. So a bare prompt can never yield 1080p, and offering it was a promise the
 * provider cannot keep. `listAvailableVideoTiers` returns only what the request can
 * actually produce; `isVideoTierAvailable` refuses the rest at submit rather than
 * quietly downgrading — a silent downgrade would charge 720p for a 1080p promise.
 *
 * PURE (no Electron, no fs, no network) so the math and the classifier stay
 * unit-testable in plain Node, mirroring `creditsCore.ts` / `eveInferenceCore.ts`.
 */

// ---------------------------------------------------------------------------
// Tiers (Fast/720p default; 1080p = explicit upgrade)
// ---------------------------------------------------------------------------

/** Video quality tier ids. `fast` (720p) is the default. */
export type VideoQualityTier = 'sd' | 'fast' | 'hd';

/** Supported video resolutions. */
export type VideoResolution = '480p' | '720p' | '1080p';

/** The two xAI video models, which differ in what they ACCEPT, not just price. */
export type VideoModelId = 'grok-imagine-video' | 'grok-imagine-video-1.5';

/** What the user actually gave us: a prompt alone, or a prompt plus an image. */
export type VideoInputMode = 'text' | 'image';

export interface VideoTierSpec {
  id: VideoQualityTier;
  resolution: VideoResolution;
  /** The xAI model that can actually produce this resolution. */
  model: VideoModelId;
  /** Provider list price per generated second, in USD. From the model profile. */
  usdPerSecond: number;
  /**
   * Retail credits per generated second, DERIVED from `usdPerSecond` through the
   * existing internal conversion — not hand-tuned, not the raw USD relabelled:
   *
   *   raw cents -> retailCostEurCents(raw, <un-tiered>) -> x CREDITS_PER_EUR_CENT
   *
   * i.e. the universal DEFAULT_MARKUP_FACTOR = 2 floor (credits-core states the
   * metered image/video/music lane takes exactly that floor) and 10 credits per
   * EUR cent. See `deriveVideoCreditsPerSecond` for the executable derivation.
   *
   * ONE assumption is stated rather than hidden: there is no USD->EUR converter
   * anywhere in this codebase (eve-inference never needs one — OpenRouter reports
   * `cost_eur_cents` directly). USD cents are therefore treated 1:1 as EUR cents.
   * Since EUR > USD that OVER-states the cost slightly and can never under-charge,
   * which is the safe direction for a preview — but it is an assumption, and if a
   * real FX source appears this is the line to change.
   */
  creditsPerSecond: number;
  /** True for the resting default tier (Fast/720p). Exactly one tier is default. */
  isDefault: boolean;
  /** True iff selecting this tier costs more than the default. */
  isUpgrade: boolean;
  /**
   * True iff this tier can ONLY be produced from an image input. grok-imagine-video-1.5
   * is image->video ONLY per the official model page — it does not do text-to-video —
   * so every tier that needs it is unreachable for a bare prompt.
   */
  requiresImageInput: boolean;
}

/**
 * Derive retail credits/second from a provider USD/second list price, through the
 * existing internal conversion. Kept as a function so the derivation is executable
 * and testable instead of a comment next to a magic number.
 *
 * Mirrors `credits-core.ts`: DEFAULT_MARKUP_FACTOR = 2 (the un-tiered metered floor
 * that the image/video/music lane takes) and CREDITS_PER_EUR_CENT = 10.
 */
export const VIDEO_MARKUP_FACTOR = 2;
export const VIDEO_CREDITS_PER_EUR_CENT = 10;

export function deriveVideoCreditsPerSecond(usdPerSecond: number): number {
  // ROUND to integer cents FIRST, then stay in integer arithmetic. `0.05 * 100`
  // is 5.000000000000001 in IEEE-754, and a later ceil() turns that into 101
  // credits instead of 100 — a price that is wrong by a rounding artefact. This
  // is the same float trap credits-core calls out when it stores CREDITS_PER_EUR_CENT
  // as an integer ratio rather than dividing by 0.1. Provider list prices are
  // quoted in whole cents, so rounding here loses nothing real.
  const rawCents = Math.round(usdPerSecond * 100); // USD cents, 1:1 as EUR cents (above)
  return rawCents * VIDEO_MARKUP_FACTOR * VIDEO_CREDITS_PER_EUR_CENT;
}

/**
 * The video tiers, from the OFFICIAL xAI model profiles.
 *
 * This table previously carried SEEDANCE prices (24 / 68 credits/s) for a lane
 * that routes to xAI. Both the provider attribution and the figures were wrong:
 * the real 720p rate is 140 credits/s, so a 5s clip previewed 120 credits against
 * a true ~700. Off by a factor of ~6, in the direction that flatters us.
 *
 *   grok-imagine-video       text/image/video -> video, 480p $0.05/s, 720p $0.07/s.
 *                            NO 1080p. This is the only text-to-video model.
 *   grok-imagine-video-1.5   480p $0.08/s, 720p $0.14/s, 1080p $0.25/s — but
 *                            IMAGE -> VIDEO ONLY. It cannot take a bare prompt.
 *
 * The consequence drives the whole selector: there is no 1080p for a text prompt.
 * Offering it would be a promise the provider cannot keep. 480p/720p stay on the
 * cheaper base model even when an image is present; 1.5 is only reached for 1080p.
 */
export const VIDEO_TIERS: readonly VideoTierSpec[] = [
  {
    id: 'sd',
    resolution: '480p',
    model: 'grok-imagine-video',
    usdPerSecond: 0.05,
    creditsPerSecond: 100,
    isDefault: false,
    isUpgrade: false,
    requiresImageInput: false,
  },
  {
    id: 'fast',
    resolution: '720p',
    model: 'grok-imagine-video',
    usdPerSecond: 0.07,
    creditsPerSecond: 140,
    isDefault: true,
    isUpgrade: false,
    requiresImageInput: false,
  },
  {
    id: 'hd',
    resolution: '1080p',
    model: 'grok-imagine-video-1.5',
    usdPerSecond: 0.25,
    creditsPerSecond: 500,
    isDefault: false,
    isUpgrade: true,
    requiresImageInput: true,
  },
] as const;

/** What the caller knows about the pending request when choosing a tier. */
export interface VideoTierAvailability {
  /** Does the request carry an image the model can animate? */
  inputMode: VideoInputMode;
  /**
   * Is grok-imagine-video-1.5 actually reachable on the existing xAI entitlement?
   * Defaults to FALSE and must be proven, not assumed: an unavailable model that
   * we advertise is the same defect as a resolution the model cannot produce.
   */
  hd15Available?: boolean;
}

/**
 * The tiers that are genuinely offerable for THIS request. Anything that cannot
 * be produced is not returned — the honest selector shows two options for a text
 * prompt, not three with one that fails on submit.
 */
export function listAvailableVideoTiers(availability: VideoTierAvailability): readonly VideoTierSpec[] {
  const hasImage = availability.inputMode === 'image';
  const hd15 = availability.hd15Available === true;
  return VIDEO_TIERS.filter((tier) => {
    if (tier.requiresImageInput && !hasImage) return false;
    if (tier.model === 'grok-imagine-video-1.5' && !hd15) return false;
    return true;
  });
}

/**
 * Is this tier actually producible for the request? The submit path calls this so
 * an impossible tier is refused with a precise capability error instead of being
 * silently downgraded — a silent downgrade would bill 720p while the user was
 * shown 1080p, which is the exact dishonesty this lane keeps producing.
 */
export function isVideoTierAvailable(tierId: VideoQualityTier, availability: VideoTierAvailability): boolean {
  return listAvailableVideoTiers(availability).some((tier) => tier.id === tierId);
}

/** The cheaper Fast/720p tier id — the default the wall pre-selects. */
export const DEFAULT_VIDEO_TIER_ID: VideoQualityTier = 'fast';

/** A typical clip length (seconds) used when the caller does not specify one. */
export const DEFAULT_VIDEO_DURATION_SECONDS = 5;

/** Look up a tier spec by id (falls back to the default tier if unknown). */
export function getVideoTier(id: VideoQualityTier | undefined): VideoTierSpec {
  return VIDEO_TIERS.find((t) => t.id === id) ?? VIDEO_TIERS.find((t) => t.isDefault) ?? VIDEO_TIERS[0];
}

// ---------------------------------------------------------------------------
// Cost preview math
// ---------------------------------------------------------------------------

export interface VideoCostRequest {
  /** Clip duration in seconds (defaults to DEFAULT_VIDEO_DURATION_SECONDS). */
  durationSeconds?: number;
  /** Selected quality tier (defaults to the Fast/720p default tier). */
  tierId?: VideoQualityTier;
}

export interface VideoCostPreview {
  /** Resolved clip duration (seconds, min 1). */
  durationSeconds: number;
  /** The resolved tier the estimate is for. */
  tier: VideoTierSpec;
  /** Estimated credits this generation will cost (rounded UP — never understate). */
  estimatedCredits: number;
  /** Convenience: true iff the resolved tier is the explicit 1080p upgrade. */
  isUpgrade: boolean;
}

/**
 * Estimate the credit cost of a video generation. Rounds UP so the preview is a
 * conservative ceiling (a user should never be surprised by a HIGHER charge than
 * the wall showed). Duration is floored to a minimum of 1s so a degenerate
 * `0`/negative never previews "0 credits".
 */
export function estimateVideoCost(request: VideoCostRequest): VideoCostPreview {
  const rawDuration = request.durationSeconds;
  const durationSeconds =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.ceil(rawDuration)
      : DEFAULT_VIDEO_DURATION_SECONDS;
  const tier = getVideoTier(request.tierId);
  const estimatedCredits = Math.ceil(durationSeconds * tier.creditsPerSecond);
  return { durationSeconds, tier, estimatedCredits, isUpgrade: tier.isUpgrade };
}

// ---------------------------------------------------------------------------
// The pre-submit gate decision
// ---------------------------------------------------------------------------

/**
 * The pre-submit gate state for a video request.
 */
export interface VideoSubmitGate {
  /**
   * Whether a blocking confirmation must be shown before submitting. FALSE:
   * asking to generate a video IS the authorisation for it, exactly as attaching
   * an image is the authorisation to analyse it.
   */
  requiresConfirm: boolean;
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The tier a request resolves to when the user did not pick one (Fast/720p). */
  defaultTierId: VideoQualityTier;
}

/**
 * Build the pre-submit gate for a video request.
 *
 * This used to hard-code `requiresConfirm: true` — every single generation
 * opened a modal that asked the user to approve a cost they had just asked to
 * incur. That is not a safety boundary, it is a second question: the request
 * itself already carried the intent.
 *
 * The real brake was never here. It is server-side, fail-closed, and it runs
 * BEFORE the upstream call: `reservePaidLane` loads the balance and answers 402
 * rather than proceeding, via `canAfford`, which refuses on both
 * `insufficient_credits` and `spend_cap_exceeded`
 * (Company.OS supabase/functions/_shared/eve-inference-core.ts and credits-core.ts).
 *
 * Not to be confused with `commitDebit` in eve-inference/index.ts: that is the
 * post-generation ledger reconcile, and its `insufficient` branch is a retry, not
 * a refusal. An earlier revision of this comment cited it as the brake. It is not
 * one, and naming the wrong mechanism is how a limit gets believed into existence.
 *
 * The estimate does not disappear with the wall: the resolved tier and credit
 * figure travel into the dispatched message (`buildResolvedVideoMessage`), so
 * the number stays visible without blocking on it.
 *
 * Still gated elsewhere, unchanged: a provider that is not configured, new
 * billing, and any new sensitive egress.
 */
export function buildVideoSubmitGate(): VideoSubmitGate {
  return {
    requiresConfirm: false,
    allowed: true,
    defaultTierId: DEFAULT_VIDEO_TIER_ID,
  };
}

/**
 * Guard that an upgrade to 1080p (the `hd` tier) was an EXPLICIT user action.
 * The wall starts on the default tier; this returns true only when the selected
 * tier is the upgrade AND the user explicitly toggled it (never auto-selected).
 */
export function isExplicitUpgrade(args: { selectedTierId: VideoQualityTier; userToggledUpgrade: boolean }): boolean {
  const tier = getVideoTier(args.selectedTierId);
  if (!tier.isUpgrade) return false;
  return args.userToggledUpgrade === true;
}

// ---------------------------------------------------------------------------
// Video-generation INTENT detection (the send-path seam)
// ---------------------------------------------------------------------------

/**
 * Phrases that signal the user is asking to GENERATE a video, not merely
 * mentioning one. Matched case-insensitively against the trimmed message; DE + EN.
 *
 * PRECISION OVER RECALL, and that is a deliberate reversal. This list used to be
 * wide because a cost wall stood behind it: an over-firing pattern only cost the
 * user a cancel click. The wall is gone — asking for a video is now the
 * authorisation — so a false positive routes a perfectly ordinary message into
 * the video lane and spends on it with nothing left to catch the mistake.
 *
 * These nouns were removed for exactly that reason, each with a real sentence
 * that tripped it: `short(s)` ("create a short summary of this meeting"),
 * `story/stories` ("make a short story for my blog"), `ad/advert` ("design an ad
 * for Google Ads, text only"), and bare German `film` ("ich will heute Abend
 * einen Film schauen"). The verbs `edit` and `cut` went with them ("edit this
 * blog post about our new ad campaign"), and German `will`, which is a plain
 * future auxiliary.
 *
 * Losing those does not lose genuine video edits: a real editing request still
 * reaches the lane through the capability, the addressed videomarketer or a video
 * skill (see {@link requestRoutesToVideoLane}). Only the regex-ONLY path narrows,
 * and that is the path with no other check behind it.
 *
 * `youtube shorts` survives in the format list, where it is unambiguous.
 */
const VIDEO_GENERATION_PATTERNS: readonly RegExp[] = [
  // EN: "generate/create/make/produce a video/clip/reel/animation/trailer"
  /\b(generate|create|make|produce|render|animate|shoot|design|build|whip\s+up)\b[^.!?]{0,60}\b(video|clip|reel|tiktok|tik[-\s]?tok|animation|commercial|trailer|montage|footage|movie)s?\b/i,
  // EN: noun-first — "a video for ... — create it", "promo video"
  /\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|trailer)s?\b[^.!?]{0,60}\b(generate|create|make|produce|render|animate|shoot|design|build|für\s+mich|for\s+me)\b/i,
  // EN: format/lane keywords — "text-to-video", "ai video", "video generation"
  /\b(text[-\s]?to[-\s]?video|img[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video|video\s+gen(eration)?|ai\s+video|video\s+ad|promo\s+video|explainer\s+video|product\s+video|youtube\s+shorts?)\b/i,
  // DE: "erstelle/mach/generiere/produziere/drehe/schneide ein Video/Clip/Reel".
  // `schneid` stays here although English `cut` was dropped: the ambiguity that
  // forced `cut` out is English-only ("cut the intro from the audio clip"), while
  // the German nouns this pairs with — Werbespot, Kurzvideo, Imagefilm — carry the
  // video meaning on their own.
  /\b(erstell|erstelle|erstellst|mach|mache|machst|generier|generiere|generierst|produzier|produziere|dreh|drehe|drehst|erzeug|erzeuge|schneid|schneide|bau|baue|design|entwirf|brauch|brauche|brauchst|braucht|möcht|möchte|möchtest|hätte?\s+gern)\b[^.!?]{0,60}\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|werbespot|werbevideo|trailer|imagefilm|produktvideo)s?\b/i,
  // DE: verb-after-noun — "Video erstellen/generieren/produzieren"
  /\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|werbespot|werbevideo|trailer|imagefilm|produktvideo)s?\b[^.!?]{0,60}\b(erstellen|erstell|generieren|generier|drehen|dreh|produzieren|produzier|machen|mach|erzeugen|erzeug|bauen|bau|für\s+mich)\b/i,
];

/**
 * Heuristically detect whether a chat message is asking to GENERATE a video
 * (the heavy paid lane). Pure + dependency-light so the send-path can decide,
 * BEFORE submitting, whether to route through the cost-wall.
 *
 * READ {@link requestRoutesToVideoLane} BEFORE WIDENING THIS. That function ORs
 * this regex with the capability, the addressed agent and the video skills — so
 * a match here is SUFFICIENT on its own to route into the video lane. An older
 * comment here claimed the opposite ("a helpful pre-filter, NOT the sole gate …
 * the fail-safe is the capability gate, not this function"); that was never true
 * of the code, and with the cost wall removed it was actively misleading, because
 * it invited widening a pattern that now spends money unattended.
 *
 * Empty / whitespace / non-string input is never a video request.
 */
export function isVideoGenerationRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return VIDEO_GENERATION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Fail-safe video-lane gate (DUX-6) — do NOT rely on the NL regex alone
// ---------------------------------------------------------------------------

/**
 * The stable roster agent id of the heavy video lane worker (the videomarketer).
 * Mirrors `eveTeamRoster` `video-marketer` — duplicated here as a plain string
 * so this module stays a pure, dependency-light core. If the roster id ever
 * changes (it must not — it is the ledger attribution key), update both.
 */
export const VIDEO_LANE_AGENT_ID = 'video-marketer';

/**
 * Hermes skills that mark a worker as the heavy GPU video lane. If a request is
 * routed to a worker that owns ANY of these, the cost-wall MUST fire — regardless
 * of what the prompt text said. Mirrors the `video-marketer` role's `skills`.
 */
const VIDEO_LANE_SKILLS: ReadonlySet<string> = new Set(['video-script', 'storyboard', 'social-video']);

/** Inputs the send-path knows about a pending send, used to decide video routing. */
export interface VideoLaneRouting {
  /** The raw chat message (run through the NL classifier). */
  message?: string | null;
  /** The agent id the request is addressed to / resolved to (if any). */
  resolvedAgentId?: string | null;
  /** The skill labels of the resolved worker / capability (if known). */
  resolvedSkills?: readonly string[] | null;
  /**
   * An explicit signal that the resolver already classified this as the video
   * capability (e.g. a tool/lane class). When true the wall fires unconditionally.
   */
  resolvedVideoCapability?: boolean | null;
}

/**
 * FAIL-SAFE gate (DUX-6): true iff a pending request reaches the heavy video
 * lane by ANY known path — so the cost-wall fires even when the NL regex misses.
 * The gate is the OR of every signal we have:
 *
 *   1. the request is addressed to / resolved to the videomarketer agent id, OR
 *   2. the resolved worker owns a video-lane skill (video-script/storyboard/…), OR
 *   3. the resolver explicitly flagged the video capability, OR
 *   4. (last resort) the NL prompt classifier {@link isVideoGenerationRequest}.
 *
 * Routing on the resolved capability/worker — not just the prompt — is the whole
 * point: it removes the regex as the SOLE gate. The wall over-firing (a false
 * positive) is cheap and recoverable (the user cancels); a false-negative silently
 * spends on the most expensive lane, which is the failure we refuse.
 */
export function requestRoutesToVideoLane(routing: VideoLaneRouting): boolean {
  if (routing.resolvedVideoCapability === true) return true;
  if (typeof routing.resolvedAgentId === 'string' && routing.resolvedAgentId.trim() === VIDEO_LANE_AGENT_ID) {
    return true;
  }
  if (Array.isArray(routing.resolvedSkills) && routing.resolvedSkills.some((s) => VIDEO_LANE_SKILLS.has(s))) {
    return true;
  }
  return isVideoGenerationRequest(routing.message);
}

/**
 * Convenience alias kept readable at the send-path call-site. Identical to
 * {@link requestRoutesToVideoLane}; named for the question the gate answers
 * ("is this the video lane?") so the SendBox reads as a fail-safe, not a regex.
 */
export function isVideoLaneRequest(routing: VideoLaneRouting): boolean {
  return requestRoutesToVideoLane(routing);
}

// ---------------------------------------------------------------------------
// Resolved video-request payload (DUX-5) — what CONFIRM actually sends
// ---------------------------------------------------------------------------

/** The user's resolved selection from the cost-wall (tier + previewed credits). */
export interface ResolvedVideoSelection {
  tierId: VideoQualityTier;
  estimatedCredits: number;
}

/**
 * Build the message the send-path dispatches AFTER the user confirms the wall
 * (DUX-5). The prior wiring discarded the resolved tier/resolution/cost and
 * re-fired the UNMODIFIED original text — so confirming did NOT actually route a
 * video request at the chosen spec. This appends an explicit, agent-readable
 * video directive carrying the resolved resolution + per-clip credit ceiling, so
 * the request the videomarketer/video lane receives matches exactly what the
 * user saw and approved.
 *
 * The directive is a deterministic suffix, so it is both human-legible and
 * parseable by the agent. The original intent text is preserved verbatim ahead
 * of it.
 *
 * A pre-existing directive is REPLACED, not preserved. It used to be kept ("never
 * double-stamp"), which was correct about the symptom and wrong about the cure:
 * a stamped message comes back into the composer through arrow-up history and
 * through editing a queued item, and keeping the old stamp meant the user could
 * pick HD, watch the pill say HD, and dispatch `tier=fast` — or inherit a stale
 * `tier=hd` while the pill read Fast and be billed for it. Found by CAO audit on
 * 6c59706a with an executed proof. Replacing is still idempotent for the case
 * that motivated the skip (same input, same output) and is correct for the case
 * it got wrong.
 */
export function buildResolvedVideoMessage(originalMessage: string, resolved: ResolvedVideoSelection): string {
  const tier = getVideoTier(resolved.tierId);
  const directive =
    `[EVE:VIDEO tier=${tier.id} resolution=${tier.resolution} ` +
    `quality=${tier.isUpgrade ? 'hd' : 'fast'} credits<=${resolved.estimatedCredits}]`;
  const base = typeof originalMessage === 'string' ? originalMessage : '';
  // Strip EVERY prior directive (a recalled message could carry more than one)
  // together with the blank line that separated it, then re-stamp the fresh one.
  //
  // `[^\]\n]*`, NOT `[^\]]*`: the class must not cross a line break. The emitted
  // directive never contains a newline, so binding it to one line matches every
  // real stamp — while the unbound version would swallow everything between a
  // user-typed "[EVE:VIDEO " and the next "]" anywhere later in the message,
  // silently deleting their text. CAO found that on ce8f90e7 with a worked
  // example. Removing a single-line lookalike is deliberate: it stops a typed
  // string from impersonating a resolved spec.
  const stripped = base.replace(/\n*\[EVE:VIDEO [^\]\n]*\]/g, '');
  const trimmed = stripped.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n\n${directive}` : directive;
}
