// Command EVE — THE BILLABLE-OPERATION REGISTRY (Deno + node compatible).
//
// WHY THIS FILE EXISTS. MAT-1749 measured 25 isolated billing bypasses; 11 shipped
// with every gate green. Three structural causes produced all eleven, and two of
// them are answered here:
//
//   1. DENYLISTS OF NAMES, NOT BEHAVIOUR. The metering gate enumerated five
//      OpenRouter endpoint URLs, so a new lane pointed at `api.x.ai` shipped green
//      (I9b). The gate was also FILE-granular, so a brand-new unmetered branch
//      inside an already-allowlisted file was free (I9c) — and that hole was not
//      hypothetical: `api.x.ai/v1/tts` was already through it, serving audio with
//      no debit and no reservation.
//   2. GATES ON THE CALL SITE, NOT THE CALLEE. A gate satisfied by a file
//      CONTAINING a symbol is satisfied by keeping the call and discarding the
//      verdict (I11a/b/d).
//
// So this registry is POSITIVE and the enforcement is in the CALLEE:
//
//   * Every paid remote operation is an ENTRY — including the video generate/edit
//     lanes that were already metered. A provider host that is not registered has
//     no entry, and an operation that is not registered has no entry.
//   * A receipt cannot be forged. It is minted only by `reserveBillableOperation`
//     and recognised through a module-private WeakSet, so a hand-built object of
//     the same shape is rejected. Renaming the symbol, renaming the env var, or
//     moving the branch to another file changes nothing: the callee still refuses.
//
// ── THE CONTRACT: TWO APPROVED CHOKEPOINTS, NOT ONE ───────────────────────────
//
// WHAT THIS COMMENT USED TO SAY, because the correction IS the lesson: "`billedFetch`
// is the ONLY way a deployed lane reaches a paid provider." That was FALSE on the
// tree it was committed to. `inference.chat` deliberately calls `deps.fetch`
// behind its own debit barrier, and a document asserting a universal its own
// codebase violates is the same defect as a test that passes while the property
// it names is false — the defect this whole file exists to close, one layer up.
//
// THE TRUE CONTRACT — the property, then the two mechanisms that keep it:
//
//     NO BYTE OF A PAID PROVIDER ARTIFACT REACHES A CALLER WITHOUT A DURABLE
//     DEBIT THAT ALREADY LANDED IN THE LEDGER FOR A REGISTERED OPERATION.
//
//   1. `billedFetch` (this file) — DEBIT BEFORE THE REQUEST. Refuses an
//      unregistered operation, an unregistered host, a URL that is not that
//      operation's EXACT registered endpoint, a method it does not declare, and
//      any call with no receipt minted by `reserveBillableOperation` — which
//      exists only after `command_eve_commit_debit` moved money. Nothing leaves
//      for the provider until the ledger has already been written.
//
//   2. THE INFERENCE DEBIT BARRIER (`_shared/eve-inference-core.ts`,
//      `commitOrFail`) — DEBIT BEFORE THE RELEASE. It exists because
//      `inference.chat` is the one `provider_reported` lane: its exact charge is
//      only knowable from the usage the provider returns, so a pre-call receipt
//      would have to bind an unbounded token count. So the barrier inverts the
//      order instead of guessing: the WHOLE answer is buffered (streaming and
//      non-streaming alike), the exact debit is committed, and not one byte is
//      released unless the commit returned `committed: true` — a gateway that
//      throws, returns void, or returns a malformed shape counts as NOT
//      committed. The price of that inversion is stated rather than hidden: the
//      provider is already paid when the commit fails, so we can lose the
//      revenue. What we never do is hand over the artifact as well.
//
// Both orderings satisfy the same property from opposite sides; neither is a
// weaker version of the other, and a THIRD route is a bypass by definition.
// `enforcedBy` on each entry names which of the two covers it, and
// cloud-lane-metering-gate.test.mjs holds the set comparisons that make a third
// route red.
//
// Run the tests with node's native TypeScript type-stripping:
//   node --test supabase/functions/_shared/billable-operations.test.mjs

import { retailCostEurCents } from './credits-core.ts';

// ──────────────────────────────────────────────────────────────────────────
// (1) HOSTS — the positive set
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hosts that BILL US. This is the whole set. A host absent from here is
 * unreachable through `billedFetch`, and the structural gate reds if a deployed
 * file so much as names one that is not declared.
 */
export const BILLABLE_PROVIDER_HOSTS: readonly string[] = Object.freeze(['openrouter.ai', 'api.x.ai']);

/**
 * Hosts a deployed function may name that do NOT bill us: our own infrastructure
 * and documentation/attribution URLs. Declared rather than assumed, so a new
 * outbound host cannot hide among them — anything not in this list and not a
 * registered provider host is a set mismatch.
 *
 * `*.supabase.co` is reached through `SUPABASE_URL` at runtime, never as a
 * literal, so it does not appear here.
 *
 * `docs.x.ai` and `www.ecb.europa.eu` are PRICE PROVENANCE, cited beside the
 * pricing they justify. They are never fetched — a price whose source is only in
 * a commit message is a price nobody can re-derive, and the host scanner cannot
 * tell a citation from a lane, so the citation is declared rather than hidden by
 * writing the URL without its scheme.
 */
export const DECLARED_NON_BILLABLE_HOSTS: readonly string[] = Object.freeze([
  'command-eve.com',
  'api.stripe.com',
  'schemas.command-eve.com',
  'docs.x.ai',
  'www.ecb.europa.eu',
  // xAI's Grok Video asset host. It BILLS NOTHING: finished video assets are
  // downloaded from it without a receipt (signed urls), which is why it is
  // here and not in BILLABLE_PROVIDER_HOSTS. It IS fetched — by
  // `fetchProviderAsset` only, and only for the operations whose registry
  // entry names it in `assetHosts`. Measured against a live, invoiced xAI
  // render on 2026-08-05 (MAT-1773/F6): Grok Video 1.5 serves finished assets
  // from https://vidgen.x.ai/... .
  'vidgen.x.ai',
]);

// ──────────────────────────────────────────────────────────────────────────
// (2) UNITS + the versioned pricing registry
// ──────────────────────────────────────────────────────────────────────────

/**
 * The unit a route is priced in. Every unit is measured on A FACT WE HOLD — never
 * on a number the client declared. For output-priced routes that fact is the
 * returned artifact. For a route the PROVIDER BILLS BY INPUT, it is the exact text
 * the gateway VALIDATED AND SUBMITTED: still not a client-declared count, because
 * the gateway measures the string it actually sent.
 */
export type BillableUnit =
  // measured on the VALIDATED INPUT TEXT, because that is what the provider bills
  | 'input_character'
  | 'image' // measured on the returned image count
  | 'video_second'; // measured on the resolved render plan (provider reports none)

/**
 * THE PROVIDER-BILLED QUANTITY FOR A TEXT-PRICED ROUTE.
 *
 * WHICH "CHARACTER"? UTF-16 CODE UNITS (JavaScript's String#length). Three
 * readings are defensible and they disagree on exactly the inputs that matter:
 *
 *   input                        UTF-16 units   code points   grapheme clusters
 *   "a"                                     1             1                   1
 *   "e" + U+0301 (combining)                2             2                   1
 *   U+1F600 (emoji)                         2             1                   1
 *   ZWJ emoji sequence                      5             3                   1
 *
 * For EVERY possible string: UTF-16 units >= code points >= grapheme clusters. So
 * counting code units CANNOT UNDER-COUNT against either other reading. xAI's
 * published pricing says "characters" without pinning which reading it means, and
 * under-counting is the direction that sells work below cost — so the largest of
 * the three defensible readings is the only safe one until a real invoice settles
 * it. Deliberately conservative, and deliberately documented as such.
 *
 * It is also the SAME number the gateway already validates the request against, so
 * what is BILLED is exactly what was ACCEPTED — not a second derivation that could
 * drift from the one the request was admitted on.
 */
export function billableInputCharacters(text: string): number {
  return text.length;
}

/**
 * THE VERSIONED USD -> EUR CONVERSION RECORD BEHIND THE TTS INPUT-CHARACTER RATE.
 *
 * A price is only reviewable if its INPUTS are in the code, not just its result.
 * Every term the rate is built from lives here with its date and its source, so a
 * reviewer can re-run the arithmetic instead of trusting the number — and so a
 * later repricing has to change a dated record rather than nudge a literal.
 *
 * EVIDENCE GRADE, STATED EXACTLY. This is OFFICIAL PUBLISHED PRICING plus an
 * OFFICIAL PUBLISHED FX REFERENCE. It is NOT invoice-validated: no billed xAI
 * invoice has been reconciled against it, and nothing here should be read as
 * claiming one has. The FX safety factor absorbs rate drift between repricings;
 * it does not turn a published list price into a measured one.
 *
 * WHY THIS IS NOT `USD_TO_EUR_SEED`. That seed converts a cost the PROVIDER
 * REPORTED, at settle time, for a call that already happened. This record
 * converts a PUBLISHED LIST PRICE at repricing time and carries a deliberate
 * safety factor on top. Different jobs, different dates, different directions of
 * error — so they are deliberately not the same constant. See the risk note on
 * USD_TO_EUR_SEED.
 */
export type UsdToEurPriceRecord = {
  /** Effective date of THIS repricing. */
  readonly version: string;
  readonly providerUsdPerMillionCharacters: number;
  readonly providerPriceSource: string;
  readonly providerEndpointSource: string;
  /**
   * ECB euro reference rates are published only on TARGET working days, so this
   * is the latest working-day record, NOT necessarily the repricing date.
   */
  readonly ecbReferenceDate: string;
  readonly ecbUsdPerEur: number;
  readonly ecbSource: string;
  /** Explicit, not folded into the rate: what absorbs FX drift between repricings. */
  readonly fxSafetyFactor: number;
  /**
   * "up" — always. Rounding a per-unit cost DOWN under-charges on every call and
   * the error grows with volume; rounding up costs a fraction of a cent.
   */
  readonly rounding: 'up';
  readonly evidenceGrade: string;
};

export const TTS_INPUT_CHARACTER_PRICE: UsdToEurPriceRecord = Object.freeze({
  version: '2026-08-02',
  providerUsdPerMillionCharacters: 15.0,
  providerEndpointSource: 'https://docs.x.ai/developers/models/text-to-speech',
  providerPriceSource: 'https://docs.x.ai/developers/pricing',
  ecbReferenceDate: '2026-07-31',
  ecbUsdPerEur: 1.1485,
  ecbSource: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  fxSafetyFactor: 1.1,
  rounding: 'up',
  evidenceGrade: 'official published pricing + official published FX reference; NOT invoice-validated',
});

/**
 * The rate the record IMPLIES, recomputed from its own terms.
 *
 * The registry row carries an independent literal, so a test can recompute this
 * and assert the literal is at or above it. That check is not a tautology: change
 * any input here and the derivation moves while the literal does not, which is
 * exactly the drift a repricing must not slip through.
 *
 *   USD 15.00 / 1,000,000 chars / 1.1485 USD-per-EUR * 100 c/EUR * 1.10
 *     = 0.00143665… EUR cents per character
 */
export function derivedEurCentsPerInputCharacter(record: UsdToEurPriceRecord): number {
  const eurPerCharacter = record.providerUsdPerMillionCharacters / 1_000_000 / record.ecbUsdPerEur;
  return eurPerCharacter * 100 * record.fxSafetyFactor;
}

/**
 * VERSIONED provider+model+unit pricing. The version is part of the record so a
 * repricing is a visible, reviewable change and an old ledger row can still be
 * explained by the pricing that produced it.
 *
 * `rawEurCentsPerUnit` is OUR COST, before any markup. `boundUnitsCeiling` is the
 * largest number of units the route can physically return (the gateway's own hard
 * cap), which is what makes the pre-call reserve an UPPER BOUND rather than a
 * guess: a route can never return more units than the gateway would accept.
 */
export type UnitPricing = {
  version: string;
  unit: BillableUnit;
  rawEurCentsPerUnit: number;
  boundUnitsCeiling: number;
};

/**
 * Where the money figure comes from after the call.
 *
 *   "provider_reported" — the provider CAN return a monetary cost (OpenRouter
 *                         `usage.cost`). When it does, that figure wins outright.
 *   "registry_priced"   — the provider never returns a cost, so the registry is
 *                         the only source.
 *
 * In BOTH cases, when no provider figure is available the only permitted
 * derivation is this registry's versioned per-unit price times the MEASURED
 * RETURNED UNITS. What is never permitted is falling back to the RESERVE
 * ESTIMATE — that is R7-iii-A, an "actual" that is really the guess, and it
 * over-charges every short call while hiding every dear one.
 */
export type CostAuthority = 'provider_reported' | 'registry_priced';

/**
 * THE ONE FX SEED. Providers quote USD; the ledger is in € cents. This constant
 * lived twice — once in eve-inference's cost estimator and once nowhere at all
 * (the multimodal lanes read `usage.cost` and threw it away). Two FX constants
 * are two prices for the same call, so there is one, here, beside the pricing it
 * converts. A founder recalibration changes this line and nothing else.
 *
 * OPEN RISK, NAMED RATHER THAN SMOOTHED OVER (2026-08-02). This seed says
 * 1 USD = 0.92 EUR. The ECB reference of 2026-07-31 says 1 USD = 0.8707 EUR
 * (1 EUR = 1.1485 USD), so this seed currently converts provider-reported costs
 * about 5.7% HIGH. High over-states our cost and therefore over-charges — the
 * safe direction — but it is still stale. It is deliberately NOT changed here:
 * it prices every provider_reported lane, so moving it is a repricing of those
 * lanes and not a side effect of fixing TTS. TTS carries its own dated, sourced
 * conversion in TTS_INPUT_CHARACTER_PRICE.
 */
export const USD_TO_EUR_SEED = 0.92;

/** USD (as providers report it) -> € cents. PRECISE: no ceil, ever. */
export function usdToEurCents(usd: number): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  return usd * USD_TO_EUR_SEED * 100;
}

// ──────────────────────────────────────────────────────────────────────────
// (3) THE OPERATIONS
// ──────────────────────────────────────────────────────────────────────────

export type BillableOperation = {
  /** Stable operation id. The ledger reason and the receipt bind to this. */
  readonly id: string;
  readonly host: string;
  /** Exact endpoint. `billedFetch` refuses a URL that is not this one. */
  readonly endpoint: string;
  readonly method: 'GET' | 'POST';
  readonly costAuthority: CostAuthority;
  /**
   * Markup tier applied to the raw cost. Every lane here is "standard" (10x) —
   * `retailCostEurCents` is the single chokepoint that applies it, and the SINGLE
   * ceil happens later at credit granularity in `canAfford`. Never ceil per step.
   */
  readonly markupTier: string;
  /**
   * Pricing for a route whose provider reports no cost. REQUIRED when
   * costAuthority is "registry_priced"; also present for provider_reported routes
   * because the PRE-CALL reserve still needs a bound (the provider's figure only
   * exists after the call).
   */
  readonly pricing: UnitPricing;
  /**
   * THE MEDIA TYPE OF THE FINISHED ARTIFACT, for an operation whose result is
   * downloaded from a url the PROVIDER chose rather than returned inline.
   *
   * Present ONLY on those operations, and REQUIRED by `fetchProviderAsset` —
   * an operation that declares none cannot download an asset at all. The type
   * that reaches the caller is THIS one; the response's own `content-type` is
   * never echoed onward. See (6b) for why a header the provider's host controls
   * is a claim and not a fact.
   */
  readonly assetMediaType?: string;
  /**
   * THE HOSTS a finished artifact may be downloaded from. Optional: absent
   * means the operation's own `host` only — the previous, derived behaviour.
   * Present means EXACTLY this set, matched as whole `host` strings (scheme
   * https, no port, no trailing dot, no suffix), re-judged on every redirect
   * hop by `fetchProviderAsset`.
   *
   * The set still lives HERE, in the registry — the operation declares it,
   * never the lane and never the client — and every entry must be a DECLARED
   * host (billable or non-billable), so the structural gate's "no undeclared
   * host literal" rule keeps covering it. xAI's video lanes need two entries
   * because the API is api.x.ai but finished assets are served from
   * vidgen.x.ai (measured against a live, invoiced render, 2026-08-05).
   */
  readonly assetHosts?: readonly string[];
  /**
   * A poll/status call against an already-debited job. It bills nothing itself,
   * so it needs no receipt — but it is REGISTERED, so it cannot be used as a
   * side door: its endpoint and method are pinned like any other.
   */
  readonly settlesAgainst?: string;
  /**
   * WHICH MECHANISM MAKES THIS OPERATION UNREACHABLE UNBILLED. Declared, not
   * assumed — an operation whose enforcement is nobody's job is exactly the shape
   * that shipped four unmetered lanes.
   *
   *   "chokepoint" — reached only through `billedFetch`, which refuses without a
   *                  receipt proving a durable debit already landed.
   *   "inference-debit-barrier" — eve-inference-core buffers the provider answer,
   *                  commits the debit, and releases no byte before the commit
   *                  succeeds (commitOrFail). Proven behaviourally, not cited:
   *                  cloud-lane-metering-gate.test.mjs DRIVES the barrier with a
   *                  gateway that refuses to commit and asserts the answer does
   *                  not come back.
   *
   * The structural gate checks that every "chokepoint" operation is ACTUALLY
   * routed through billedFetch in deployed source, AND that these two are the
   * only enforcement mechanisms any entry declares — so this field cannot be a
   * claim the code does not keep, and a THIRD mechanism cannot arrive as a
   * string.
   */
  readonly enforcedBy: 'chokepoint' | 'inference-debit-barrier';
  readonly why: string;
};

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * EVERY paid remote operation in the product. An operation that is not in this
 * map cannot be called: `billedFetch` looks its id up here and throws when it is
 * absent. Adding a provider or an operation without an entry therefore cannot
 * "ship green" — there is nothing to ship it through.
 *
 * The already-metered video lanes are listed too. Leaving them out would make the
 * registry a list of "the ones we fixed" rather than the set of paid operations,
 * and the next lane added beside them would inherit the omission.
 */
export const BILLABLE_OPERATIONS: ReadonlyMap<string, BillableOperation> = new Map<string, BillableOperation>([
  [
    'multimodal.tts',
    {
      id: 'multimodal.tts',
      host: 'api.x.ai',
      endpoint: 'https://api.x.ai/v1/tts',
      method: 'POST',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        // The DATE THIS REPRICING TOOK EFFECT. The calendar date collides with
        // the row it replaces, so what distinguishes an old ledger row from a
        // new one is the UNIT, which the pricing basis also carries:
        // `registry:2026-08-02:audio_byte:N` vs
        // `registry:2026-08-02:input_character:N`.
        version: '2026-08-02',
        unit: 'input_character',
        // ── PRICED ON THE UNIT THE PROVIDER ACTUALLY BILLS ──────────────────
        // This row used to price RETURNED AUDIO BYTES. That was the wrong unit,
        // not merely a mis-tuned rate: xAI bills TTS by INPUT CHARACTER, so no
        // value on an output-byte unit could have been correct — a short prompt
        // yielding long audio under-charged, a long prompt yielding short audio
        // over-charged. The audio-byte path is REMOVED rather than left dormant
        // beside this one: a retired pricing basis that still resolves is a
        // basis something can fall back onto after the next refactor.
        //
        // DERIVATION (verify it; do not take it on trust). Every term below is
        // in TTS_INPUT_CHARACTER_PRICE with its date and source, and
        // `derivedEurCentsPerInputCharacter` recomputes it:
        //   USD 15.00 / 1,000,000 input characters      (xAI published price)
        //     = EUR 13.0605 per 1,000,000 characters
        //       at the ECB euro reference rate of 2026-07-31,
        //       1 EUR = 1.1485 USD
        //   x 1.10 explicit FX safety factor
        //     = EUR 14.3665 per 1,000,000 characters
        //     = 0.00143665 EUR CENTS per character
        //   ROUNDED UP to 0.00145 EUR cents per character (this row).
        //
        // ROUNDING IS UP, DELIBERATELY. Rounding a per-unit price DOWN
        // under-charges on every single call and the shortfall grows with
        // volume; rounding up costs a fraction of a cent. This row is therefore
        // 0.93% ABOVE the derivation, and a test asserts it can never fall
        // below it.
        //
        // NOTE ON THE ECB DATE: euro reference rates are published only on
        // TARGET working days. 2026-07-31 is the latest working-day record;
        // 2026-08-02 is a Sunday and is NOT an ECB rate date. Citing a weekend
        // as an FX reference would be a false provenance claim in the money
        // path.
        //
        // WHAT THAT COSTS AT THE CEILING: a maximum 15,000-character call is
        // 15,000 x 0.00145 = 21.75 EUR cents RAW; the standard 10x markup is
        // applied exactly once, downstream, for 217.5 EUR cents = ~EUR 2.18
        // retail. The single final ceil happens at credit granularity in
        // canAfford, never here.
        //
        // EVIDENCE GRADE, STATED HONESTLY: this is OFFICIAL PUBLISHED PRICING
        // plus an OFFICIAL PUBLISHED FX REFERENCE. It is NOT invoice-validated
        // — no billed xAI invoice has been reconciled against it, and nothing
        // here claims one has. The 10% FX factor absorbs rate drift between
        // repricings; it does not turn a published rate into a measured one.
        //
        // SOURCES (also machine-readable in TTS_INPUT_CHARACTER_PRICE):
        //   https://docs.x.ai/developers/models/text-to-speech  (endpoint, 15,000-char max)
        //   https://docs.x.ai/developers/pricing                (USD 15 / 1M input chars)
        //   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml  (EUR/USD)
        rawEurCentsPerUnit: 0.00145,
        // The endpoint's own maximum, and the same ceiling the gateway
        // validates every request against (EVE_MULTIMODAL_TTS_MAX_TEXT_CHARS).
        // A test pins these two together so they cannot drift apart.
        boundUnitsCeiling: 15_000,
      },
      enforcedBy: 'chokepoint',
      why: 'xAI text-to-speech. Reports no cost; priced from the validated input characters it is billed by.',
    },
  ],
  [
    'multimodal.vision',
    {
      id: 'multimodal.vision',
      host: 'openrouter.ai',
      endpoint: OPENROUTER_CHAT,
      method: 'POST',
      costAuthority: 'provider_reported',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'image',
        // Pre-call bound only. OpenRouter reports usage.cost after the call and
        // that figure settles the charge. 0.30 € cents raw per slide/image is
        // above the observed Flash vision cost per image, so the bound holds.
        rawEurCentsPerUnit: 0.3,
        boundUnitsCeiling: 200, // DEFAULT_VISION_TENANT_SLIDE_CAP
      },
      enforcedBy: 'chokepoint',
      why: 'OpenRouter vision over presentation slides / images; usage.cost is authoritative.',
    },
  ],
  [
    'multimodal.document_ocr',
    {
      id: 'multimodal.document_ocr',
      host: 'openrouter.ai',
      endpoint: OPENROUTER_CHAT,
      method: 'POST',
      costAuthority: 'provider_reported',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'image', // one unit per physical page
        rawEurCentsPerUnit: 0.3,
        boundUnitsCeiling: 500, // DEFAULT_PDF_OCR_TENANT_PAGE_CAP
      },
      enforcedBy: 'chokepoint',
      why: 'OpenRouter PDF OCR (mistral-ocr file parser); usage.cost is authoritative.',
    },
  ],
  [
    'multimodal.image_generation',
    {
      id: 'multimodal.image_generation',
      host: 'openrouter.ai',
      // NOT chat/completions. Image generation is its own endpoint, and the
      // first draft of the OLD metering gate discovered exactly this the hard
      // way — it listed only completions endpoints and failed against its own
      // allowlist. Pinning the real endpoint per operation is what stops that
      // from ever being a judgement call again.
      endpoint: 'https://openrouter.ai/api/v1/images',
      method: 'POST',
      costAuthority: 'provider_reported',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'image',
        // One image per request. The bound is above the observed per-image cost
        // of the pinned image model so the reserve cannot fall short.
        rawEurCentsPerUnit: 16,
        boundUnitsCeiling: 1,
      },
      enforcedBy: 'chokepoint',
      why: 'OpenRouter image generation; usage.cost is authoritative when present.',
    },
  ],
  [
    'multimodal.video_generation',
    {
      id: 'multimodal.video_generation',
      host: 'api.x.ai',
      endpoint: 'https://api.x.ai/v1/videos/generations',
      method: 'POST',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'video_second',
        // The video lane prices from its OWN resolved render plan
        // (plan.estimatedCredits), which is already tier/duration/model aware
        // and already unit-tested. This row exists so the operation is
        // REGISTERED and reachable, not to re-derive that price: the lane passes
        // its plan cost in as the bound and the settle is exact-equals-bound.
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 15,
      },
      // MP4, because that is what this product's video lanes are: the edit
      // lane accepts an MP4 source and nothing else (xaiVideoDataUrlFromBase64
      // refuses anything that is not one), so an MP4 is the only artifact the
      // pair can round-trip. Pinned here, not read off the wire.
      assetMediaType: 'video/mp4',
      // Grok Video serves finished assets from vidgen.x.ai, NOT from the API
      // host — measured against a live, invoiced Grok Video 1.5 render on
      // 2026-08-05 (MAT-1773/F6): the generation succeeded and was billed by
      // xAI, and the delivery failed here because this set used to be
      // api.x.ai only. Exact host strings, https only; the asset download
      // carries no bearer (see fetchProviderAsset).
      assetHosts: ['api.x.ai', 'vidgen.x.ai'],
      enforcedBy: 'chokepoint',
      why: 'xAI video generation. Already atomically debited before the call via commitVideoDebit.',
    },
  ],
  [
    'multimodal.video_edit',
    {
      id: 'multimodal.video_edit',
      host: 'api.x.ai',
      endpoint: 'https://api.x.ai/v1/videos/edits',
      method: 'POST',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'video_second',
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 15,
      },
      assetMediaType: 'video/mp4',
      // Same asset host set as video_generation: an edit's finished asset is
      // served by the same xAI video backend, so it comes from vidgen.x.ai
      // too. Exact host strings, https only.
      assetHosts: ['api.x.ai', 'vidgen.x.ai'],
      enforcedBy: 'chokepoint',
      why: 'xAI video edit. Already atomically debited before the call via commitVideoDebit.',
    },
  ],
  [
    'multimodal.video_status',
    {
      id: 'multimodal.video_status',
      host: 'api.x.ai',
      endpoint: 'https://api.x.ai/v1/videos',
      method: 'GET',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'video_second',
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 0,
      },
      settlesAgainst: 'multimodal.video_generation',
      enforcedBy: 'chokepoint',
      why: 'Status poll of an already-debited render job. Bills nothing; registered so it cannot be a side door.',
    },
  ],
  [
    'multimodal.openrouter_video_generation',
    {
      id: 'multimodal.openrouter_video_generation',
      host: 'openrouter.ai',
      // The ASYNC video contract (official guide, verified 2026-08-05):
      // submit POST /api/v1/videos -> 202 {id, polling_url, status};
      // poll GET /api/v1/videos/{id} until completed; download
      // GET /api/v1/videos/{id}/content?index=0 WITH the bearer — unlike
      // the xAI asset host, OpenRouter's content endpoint requires the
      // credential, and fetchProviderAsset presents it only to op.host.
      endpoint: 'https://openrouter.ai/api/v1/videos',
      method: 'POST',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-05',
        unit: 'video_second',
        // Like the xAI video rows: the lane prices from its own catalog
        // snapshot (openrouter-video-catalog.ts, dated 2026-08-05), which is
        // per-model/resolution/mode aware and unit-tested. This row exists
        // so the operation is REGISTERED and reachable; the lane passes its
        // estimate in as the bound and the settle is exact-equals-bound.
        // The ceiling is the catalog's maximum duration (20s, flux-3-video
        // and sora-2-pro).
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 20,
      },
      assetMediaType: 'video/mp4',
      // The finished asset is served by openrouter.ai itself
      // (/api/v1/videos/{id}/content). Exact host string, https only.
      assetHosts: ['openrouter.ai'],
      enforcedBy: 'chokepoint',
      why: 'OpenRouter video generation (F8 default gateway). Already atomically debited before the call via the shared reserve.',
    },
  ],
  [
    'multimodal.openrouter_video_status',
    {
      id: 'multimodal.openrouter_video_status',
      host: 'openrouter.ai',
      endpoint: 'https://openrouter.ai/api/v1/videos',
      method: 'GET',
      costAuthority: 'registry_priced',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-05',
        unit: 'video_second',
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 0,
      },
      settlesAgainst: 'multimodal.openrouter_video_generation',
      enforcedBy: 'chokepoint',
      why: 'Status poll of an already-debited OpenRouter render job. Bills nothing; registered so it cannot be a side door.',
    },
  ],
  [
    'inference.chat',
    {
      id: 'inference.chat',
      host: 'openrouter.ai',
      endpoint: OPENROUTER_CHAT,
      method: 'POST',
      costAuthority: 'provider_reported',
      markupTier: 'standard',
      pricing: {
        version: '2026-08-02',
        unit: 'image', // unused: the inference lane prices per token upstream
        rawEurCentsPerUnit: 0,
        boundUnitsCeiling: 0,
      },
      enforcedBy: 'inference-debit-barrier',
      why: "The metered Standard/MAX text lane. Reserve/commit is enforced by eve-inference-core's debit barrier (commitOrFail); registered here so the host set is complete.",
    },
  ],
]);

/** A poll-only operation bills nothing of its own. */
export function isSettlementPoll(op: BillableOperation): boolean {
  return typeof op.settlesAgainst === 'string';
}

/**
 * WHAT A SETTLEMENT-POLL REQUEST ID IS ALLOWED TO LOOK LIKE.
 *
 * The poll is the ONE registered operation that bills nothing, so it is the one
 * `billedFetch` lets through WITHOUT A RECEIPT — which makes its path the most
 * dangerous string in this file. It used to match by PREFIX
 * (`pathname.startsWith("/v1/videos/")`), and a prefix match on the FREE
 * operation is a free ride for every other path under it. MEASURED on this tree
 * before this rule existed: `GET /v1/videos/edits`, `GET /v1/videos/generations`
 * and `GET /v1/videos/not-a-request-id/extra` all reached `fetch` with no
 * receipt — the first two being the paths of the two operations that DO bill.
 *
 * THE RULE, DECIDED AND WRITTEN DOWN rather than left as "any non-empty string":
 * exactly ONE path segment after the registered poll endpoint, matching
 *
 *     ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$
 *
 * — ASCII alphanumerics plus `-` and `_`, first character alphanumeric, 1 to 128
 * characters — and not a segment that belongs to another registered operation.
 *
 * WHY THIS CLASS AND NOT A LOOSER ONE. It is exactly the set of segments that
 * BOTH `encodeURIComponent` AND the WHATWG URL parser leave untouched, so the
 * string validated here is byte-for-byte the string that goes on the wire: no
 * later normalisation can turn a checked value into a different path. Each
 * exclusion kills a smuggling class at the character level instead of relying on
 * a parser having already collapsed it — no `.` means `.` and `..` cannot be
 * spelled at all, no `%` means `%2F` and `%2e%2e` cannot, no `/` or `\` means a
 * second segment cannot. The 128 ceiling is a BOUND, not a measurement: xAI
 * publishes no length for `request_id` and the ids observed on this tree are
 * short opaque tokens, so the ceiling sits far above anything seen and exists so
 * an unbounded provider string cannot be pasted into a URL.
 *
 * FAIL-CLOSED, AND THE COST IS STATED. If xAI ever mints a request id outside
 * this class the poll THROWS and names the URL, so a video fails LOUDLY. That is
 * the deliberate direction: the alternative — accept anything so polling never
 * breaks — is the defect this replaces.
 */
const SETTLEMENT_POLL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The first path segments under a poll's own endpoint that belong to a DIFFERENT
 * registered operation. DERIVED from the registry, never hand-listed: registering
 * a new `/v1/videos/<verb>` operation reserves `<verb>` in the same edit, so this
 * cannot go stale the way a written-out denylist of `edits`/`generations` would.
 */
function siblingOperationSegments(op: BillableOperation): Set<string> {
  const base = new URL(op.endpoint);
  const reserved = new Set<string>();
  for (const other of BILLABLE_OPERATIONS.values()) {
    if (other.id === op.id) continue;
    const sibling = new URL(other.endpoint);
    if (sibling.origin !== base.origin) continue;
    if (!sibling.pathname.startsWith(`${base.pathname}/`)) continue;
    reserved.add(sibling.pathname.slice(base.pathname.length + 1).split('/')[0]);
  }
  return reserved;
}

type EndpointVerdict = { ok: true } | { ok: false; code: string; detail: string };

/**
 * Is this URL the operation's registered endpoint — EXACTLY?
 *
 * Separated from `billedFetch` so the poll rule is one readable thing rather than
 * a condition inside a boolean, and so every refusal carries a code that says
 * WHICH rule refused rather than a single catch-all.
 */
function endpointVerdict(op: BillableOperation, parsed: URL): EndpointVerdict {
  const registered = new URL(op.endpoint);
  const notRegistered: EndpointVerdict = {
    ok: false,
    code: 'endpoint-not-registered',
    detail: `${op.id} is registered for ${op.endpoint}`,
  };
  if (parsed.origin !== registered.origin) return notRegistered;

  // NO registered endpoint carries a query or a fragment, and no call site adds
  // one. Refusing both outright deletes the whole "the path is clean, the extra
  // is in the query" class instead of reasoning about which parts of a URL a
  // provider might route on.
  if (parsed.search !== '' || parsed.hash !== '') {
    return {
      ok: false,
      code: 'endpoint-carries-query',
      detail: 'no registered endpoint takes a query string or a fragment',
    };
  }

  if (!isSettlementPoll(op)) {
    return parsed.pathname === registered.pathname ? { ok: true } : notRegistered;
  }

  // A poll is `<endpoint>/{requestId}` and NOTHING else.
  const base = registered.pathname;
  const notARequestId = (detail: string): EndpointVerdict => ({
    ok: false,
    code: 'poll-target-not-a-request-id',
    detail: `a poll is ${op.endpoint}/{requestId}; ${detail}`,
  });
  if (!parsed.pathname.startsWith(`${base}/`)) {
    return notARequestId(`"${parsed.pathname}" is not one segment under that path`);
  }
  const segment = parsed.pathname.slice(base.length + 1);
  if (!SETTLEMENT_POLL_REQUEST_ID.test(segment)) {
    return notARequestId(`"${segment}" is not a request id matching ${SETTLEMENT_POLL_REQUEST_ID.source}`);
  }
  if (siblingOperationSegments(op).has(segment)) {
    return {
      ok: false,
      code: 'poll-target-is-a-billing-operation',
      detail:
        `"${segment}" is another registered operation's path, not a request id. ` +
        'The poll bills nothing and needs no receipt; it may not be aimed at an operation that bills.',
    };
  }
  return { ok: true };
}

export function billableOperation(id: string): BillableOperation | null {
  return BILLABLE_OPERATIONS.get(id) ?? null;
}

export function isRegisteredProviderHost(host: string): boolean {
  return BILLABLE_PROVIDER_HOSTS.includes(host);
}

/** Every host any registered operation actually points at. */
export function registeredOperationHosts(): string[] {
  const hosts = new Set<string>();
  for (const op of BILLABLE_OPERATIONS.values()) hosts.add(op.host);
  return [...hosts].sort();
}

// ──────────────────────────────────────────────────────────────────────────
// (4) FAIL-CLOSED PRICING
// ──────────────────────────────────────────────────────────────────────────

export type PricedAmount =
  | { ok: true; rawEurCents: number; retailEurCents: number; basis: string }
  | { ok: false; reason: string };

/**
 * The PRE-CALL bound. `units` is what the route could at most return; it is
 * clamped to the registry ceiling so a caller cannot inflate (or deflate) the
 * bound by passing a number the route could never produce.
 *
 * FAIL CLOSED: a non-finite, negative or unpriceable input yields ok:false, and
 * the caller must then serve NOTHING. There is no "assume zero and continue".
 */
export function boundEurCentsFor(op: BillableOperation, units: number): PricedAmount {
  if (!Number.isFinite(units) || units < 0) {
    return { ok: false, reason: 'bound-units-not-measurable' };
  }
  const pricing = op.pricing;
  if (!pricing || !Number.isFinite(pricing.rawEurCentsPerUnit)) {
    return { ok: false, reason: 'route-not-priced' };
  }
  const bounded = Math.min(units, pricing.boundUnitsCeiling);
  const rawEurCents = bounded * pricing.rawEurCentsPerUnit;
  if (!Number.isFinite(rawEurCents) || rawEurCents < 0) {
    return { ok: false, reason: 'route-not-priced' };
  }
  // ONE markup application. NO ceil here — the single rounding happens at credit
  // granularity inside canAfford. A ceil here would be a per-step ceil (R7-ii).
  return {
    ok: true,
    rawEurCents,
    retailEurCents: retailCostEurCents(rawEurCents, op.markupTier),
    basis: `registry:${pricing.version}:${pricing.unit}:${bounded}`,
  };
}

/**
 * The POST-CALL exact cost.
 *
 * THE RULE (fail-closed pricing, MAT-1749 remediation C):
 *   * If the provider returned an AUTHORITATIVE monetary cost, that is the raw
 *     cost. Nothing else may override it.
 *   * Otherwise the ONLY permitted derivation is this registry's versioned
 *     per-unit price times the MEASURED RETURNED UNITS.
 *   * If neither is available, the route CANNOT BE PRICED. The caller must
 *     return no artifact and no 200, and must refund the reservation.
 *
 * A `providerReportedRawEurCents` that is not a finite, non-negative number is
 * NOT a zero — it is an absent fact, and on a provider_reported route an absent
 * fact fails closed rather than silently pricing at the registry bound. That is
 * I11d's lesson applied to money: validate a gate's input at its source instead
 * of trusting it because a downstream check looks strict.
 */
export function actualEurCentsFor(
  op: BillableOperation,
  input: {
    providerReportedRawEurCents?: number | null;
    measuredUnits?: number | null;
  }
): PricedAmount {
  const reported = input.providerReportedRawEurCents;
  if (
    op.costAuthority === 'provider_reported' &&
    typeof reported === 'number' &&
    Number.isFinite(reported) &&
    reported >= 0
  ) {
    return {
      ok: true,
      rawEurCents: reported,
      retailEurCents: retailCostEurCents(reported, op.markupTier),
      basis: 'provider-reported',
    };
  }

  // No usable provider figure. The ONLY permitted derivation is the versioned
  // registry price times the units the call ACTUALLY RETURNED — never the
  // reserve estimate, and never a unit count the client asked for.
  const units = input.measuredUnits;
  if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
    return { ok: false, reason: 'route-not-priceable' };
  }
  const priced = boundEurCentsFor(op, units);
  if (!priced.ok) return priced;
  return { ...priced, basis: `${priced.basis}:measured` };
}

// ──────────────────────────────────────────────────────────────────────────
// (5) THE RECEIPT — proof a durable debit already landed
// ──────────────────────────────────────────────────────────────────────────

export type ReserveReceipt = {
  readonly operationId: string;
  readonly entitlementId: string;
  readonly tenantId: string;
  readonly externalRef: string;
  readonly boundEurCents: number;
  readonly pricingVersion: string;
};

/**
 * Module-private. A receipt is RECOGNISED, not merely SHAPED: `billedFetch`
 * checks membership here, so an object literal with the right fields is refused.
 * This is what makes the gate survive a rename — there is no name to imitate.
 */
const MINTED_RECEIPTS = new WeakSet<object>();

export function isMintedReceipt(value: unknown): value is ReserveReceipt {
  return typeof value === 'object' && value !== null && MINTED_RECEIPTS.has(value as object);
}

/**
 * The ledger port. Injectable so every refusal path is drivable in a test
 * without a database — a refusal nobody has ever seen run is not a refusal.
 */
export type BillingLedgerPort = {
  commit(input: {
    tenantId: string;
    costEurCents: number;
    externalRef: string;
    model: string;
    reason: string;
    expectedEntitlementId?: string;
  }): Promise<
    | { status: 'applied'; entitlementId: string; externalRef?: string }
    | { status: 'already'; entitlementId: string; externalRef?: string }
    | { status: 'insufficient'; reason: 'insufficient_credits' | 'spend_cap_exceeded' }
    | { status: 'unavailable' }
  >;
  reverse(input: {
    entitlementId: string;
    tenantId: string;
    externalRef: string;
    /** Ledger reason for the reversal; the lane's default applies when absent. */
    reason?: string;
  }): Promise<{ ok: boolean; reason?: string }>;
};

export type ReserveOutcome =
  | { status: 'reserved'; receipt: ReserveReceipt }
  | { status: 'replayed' }
  | { status: 'insufficient'; reason: 'insufficient_credits' | 'spend_cap_exceeded' }
  | { status: 'unpriceable'; reason: string }
  | { status: 'unavailable' };

/**
 * DURABLE RESERVE. Prices the bound, then MOVES MONEY through the same atomic
 * `command_eve_commit_debit` substrate every other lane uses, and only then mints
 * the receipt that `billedFetch` demands.
 *
 * Nothing here is advisory. A `canAfford` read was the original video defect
 * (e45379a5): two concurrent requests both passed and the balance never moved.
 */
export async function reserveBillableOperation(args: {
  port: BillingLedgerPort;
  operationId: string;
  tenantId: string;
  externalRef: string;
  model: string;
  /** Bind a route-time quality decision to the exact wallet row it inspected. */
  expectedEntitlementId?: string;
  /** Upper bound on units the route can return. Clamped to the registry ceiling. */
  boundUnits: number;
  /**
   * For lanes that carry their own already-tested price (video), the bound in €
   * cents RETAIL. When present it REPLACES the registry derivation — and the
   * registry row for those operations is priced at zero precisely so it cannot
   * silently under-charge if this is ever dropped.
   */
  explicitBoundRetailEurCents?: number;
}): Promise<ReserveOutcome> {
  const op = billableOperation(args.operationId);
  if (!op) return { status: 'unpriceable', reason: 'operation-not-registered' };
  if (isSettlementPoll(op)) {
    return { status: 'unpriceable', reason: 'operation-bills-nothing' };
  }

  let boundRetail: number;
  let pricingVersion: string;
  if (typeof args.explicitBoundRetailEurCents === 'number') {
    if (!Number.isFinite(args.explicitBoundRetailEurCents) || args.explicitBoundRetailEurCents < 0) {
      return { status: 'unpriceable', reason: 'explicit-bound-not-measurable' };
    }
    boundRetail = args.explicitBoundRetailEurCents;
    pricingVersion = `lane:${op.pricing.version}`;
  } else {
    const priced = boundEurCentsFor(op, args.boundUnits);
    if (!priced.ok) return { status: 'unpriceable', reason: priced.reason };
    boundRetail = priced.retailEurCents;
    pricingVersion = op.pricing.version;
  }

  const commit = await args.port.commit({
    tenantId: args.tenantId,
    costEurCents: boundRetail,
    externalRef: args.externalRef,
    model: args.model,
    reason: `${op.id} reserve`,
    expectedEntitlementId: args.expectedEntitlementId,
  });

  if (commit.status === 'unavailable') return { status: 'unavailable' };
  if (commit.status === 'insufficient') {
    return { status: 'insufficient', reason: commit.reason };
  }
  if (commit.status === 'already') return { status: 'replayed' };

  const receipt: ReserveReceipt = Object.freeze({
    operationId: op.id,
    entitlementId: commit.entitlementId,
    tenantId: args.tenantId,
    // THE REF THE LEDGER REPORTED, not the one we asked for. A reversal must
    // target the row that actually exists; asking for one ref and reversing a
    // different one is how a refund silently misses.
    externalRef: commit.externalRef ?? args.externalRef,
    boundEurCents: boundRetail,
    pricingVersion,
  });
  MINTED_RECEIPTS.add(receipt);
  return { status: 'reserved', receipt };
}

// ──────────────────────────────────────────────────────────────────────────
// (6) THE CHOKEPOINT
// ──────────────────────────────────────────────────────────────────────────

export class UnbilledCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnbilledCallError';
    this.code = code;
  }
}

/**
 * CHOKEPOINT 1 OF 2: DEBIT BEFORE THE REQUEST.
 *
 * Every lane whose price is knowable BEFORE the call reaches its provider here
 * and nowhere else. (Chokepoint 2 is eve-inference-core's debit barrier, for the
 * one lane whose price is not — see the two-chokepoint contract at the head of
 * this file. There is no third.)
 *
 * Refuses, by THROWING (never by returning a falsy value a caller can ignore —
 * ignoring the verdict is precisely how I11a/b/d shipped green):
 *   * an operation id that is not registered,
 *   * a host that is not a registered billable provider,
 *   * a URL whose origin+path is not that operation's registered endpoint,
 *   * a method the operation does not declare,
 *   * a missing receipt, a forged receipt, or a receipt minted for a DIFFERENT
 *     operation.
 *
 * A settlement poll (`settlesAgainst`) needs no receipt of its own — the job it
 * polls was already debited — but it is still registered, so its endpoint and
 * method are pinned exactly like a billing call. "Pinned" means EXACT: the poll
 * accepts `<endpoint>/{requestId}` for ONE request id and nothing else. It used
 * to accept any path under its endpoint, and because it is the operation that
 * needs no receipt, that prefix let `/v1/videos/edits` and
 * `/v1/videos/generations` — the two operations that DO bill — be called
 * unmetered. See SETTLEMENT_POLL_REQUEST_ID for the rule and why it is that one.
 */
export async function billedFetch(args: {
  operationId: string;
  url: string;
  init: RequestInit;
  fetchFn: typeof fetch;
  receipt?: unknown;
}): Promise<Response> {
  const op = billableOperation(args.operationId);
  if (!op) {
    throw new UnbilledCallError(
      'operation-not-registered',
      `${args.operationId} is not a registered billable operation. Add a registry entry; a provider call with no entry cannot be made.`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new UnbilledCallError('endpoint-unparseable', `${args.operationId}: malformed URL`);
  }
  if (!isRegisteredProviderHost(parsed.host)) {
    throw new UnbilledCallError('host-not-registered', `${parsed.host} is not a registered billable provider host.`);
  }
  const verdict = endpointVerdict(op, parsed);
  if (!verdict.ok) {
    // The URL is quoted VERBATIM, not normalised: a refusal that reports the
    // parser's tidied-up path leaves the reader guessing what was actually asked
    // for, and the probe that found this defect is the one that must be readable
    // in the failure.
    throw new UnbilledCallError(verdict.code, `${args.operationId} refused ${args.url} — ${verdict.detail}.`);
  }
  const method = (args.init.method ?? 'GET').toUpperCase();
  if (method !== op.method) {
    throw new UnbilledCallError(
      'method-not-registered',
      `${args.operationId} is registered for ${op.method}, not ${method}.`
    );
  }

  if (!isSettlementPoll(op)) {
    if (!isMintedReceipt(args.receipt)) {
      throw new UnbilledCallError(
        'no-reserve-receipt',
        `${args.operationId} was called without a minted reserve receipt. No paid provider call may be made before a durable debit has landed.`
      );
    }
    if (args.receipt.operationId !== op.id) {
      throw new UnbilledCallError(
        'receipt-operation-mismatch',
        `${args.operationId} was called with a receipt minted for ${args.receipt.operationId}.`
      );
    }
  }

  return await args.fetchFn(args.url, args.init);
}

// ──────────────────────────────────────────────────────────────────────────
// (6b) THE FINISHED-ARTIFACT DOWNLOAD — A URL THE PROVIDER CHOSE
// ──────────────────────────────────────────────────────────────────────────
//
// THIS IS NOT A THIRD BILLING CHOKEPOINT, and it must not be read as one. No
// money moves here: the render was debited before the submit, and this GET only
// collects the artifact that debit already paid for. What it is instead is the
// one outbound call in the product whose URL is chosen by SOMEBODY ELSE —
// `video.url`, verbatim out of an xAI response body — and that is a different
// class of defect with a different fix.
//
// WHAT WAS THERE BEFORE. `await fetchFn(assetUrl, { method: "GET" })`, with no
// constraint on host, scheme or address anywhere. Anyone able to influence that
// one response field — a compromised provider account, a spoofed or MITM'd
// response, a provider bug — picked a URL this function fetched from inside our
// network. The classic target is a cloud link-local metadata endpoint
// (169.254.169.254), and the response's own `content-type` then rode onward onto
// the artifact, so whatever came back was labelled and served as the customer's
// video.
//
// TWO PROPERTIES, ENFORCED HERE RATHER THAN ASSUMED:
//
//   1. EVERY URL THAT REACHES THE NETWORK IS THE PROVIDER'S OWN HOST OVER HTTPS.
//      Every url — not just the first. Redirects are followed BY HAND so each
//      hop is re-judged before it is requested; see `fetchProviderAsset`.
//   2. THE MEDIA TYPE IS THE REGISTRY'S, NOT THE RESPONSE'S. See
//      `assetMediaType`.
//
// THE HOST AUTHORITY LIVES IN THE REGISTRY, NEVER IN THE LANE. The permitted
// set is the operation's declared `assetHosts`, or `op.host` alone when the
// operation declares none. A lane that could spell its own asset host is the
// same shape as a lane that could spell its own endpoint, and rules (1) and
// (2) of the metering gate exist to forbid exactly that shape — so the set is
// a field on the registry entry, next to the endpoint it belongs with.
//
// EVIDENCE GRADE, STATED RATHER THAN IMPLIED. That the finished asset is
// served from the SAME host as the API was INFERRED from the registry and was
// WRONG for xAI video: on 2026-08-05 a live, invoiced Grok Video 1.5 render
// succeeded at the provider and the delivery REFUSED here, because xAI serves
// finished assets from vidgen.x.ai. That is the fail-closed direction this
// guard was designed to take (loud refusal, url in the message, money
// reversed by the caller) — and the correction was exactly the one registry
// line the note below predicted: the operation now declares the host its
// assets actually come from. Any FURTHER asset host still refuses the same
// way until it is declared here.

/** The hosts a finished artifact may be downloaded from, from the registry. */
function permittedAssetHosts(op: BillableOperation): readonly string[] {
  return op.assetHosts ?? [op.host];
}

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

type AddressClass = { literal: false } | { literal: true; unroutable: string | null };

/**
 * IS THIS HOSTNAME A LITERAL ADDRESS, AND IS IT ONE THAT NEVER LEAVES THE HOST
 * OR THE PRIVATE NETWORK?
 *
 * DONE IN CODE BECAUSE THE RUNTIME DOES NOT DO IT. That the sandbox might block
 * link-local was a HYPOTHESIS, so it was measured rather than believed: on deno
 * 2.6.10, `fetch("http://169.254.169.254/latest/meta-data/")` is not refused by
 * the runtime at all — it opens a TCP connection and fails only because the
 * machine it ran on has no metadata service to answer. A guarantee that holds
 * only where there is nothing to steal is not a guarantee, and the deployed Edge
 * runtime is a different build besides.
 *
 * MATCHING THE NORMAL FORM MATCHES EVERY SPELLING. The WHATWG parser has already
 * canonicalised the input by the time this runs — measured: `2130706433`,
 * `0x7f000001` and `010.0.0.1` all arrive as dotted quads, and every IPv6
 * literal arrives bracketed, including `::ffff:127.0.0.1` as `[::ffff:7f00:1]`.
 * So there is no encoding to un-pick here.
 *
 * ANY literal address is refused by the host rule below regardless of range —
 * `api.x.ai` is a name, so no literal can ever equal it. This classification
 * exists to make the refusal SAY WHICH unroutable range was aimed at, because a
 * refusal that reads "host not permitted" teaches the next reader nothing about
 * what was attempted.
 */
function addressClass(hostname: string): AddressClass {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const v6 = hostname.slice(1, -1).toLowerCase();
    if (v6 === '::1') return { literal: true, unroutable: '::1 (IPv6 loopback)' };
    if (v6 === '::') return { literal: true, unroutable: ':: (IPv6 unspecified)' };
    if (/^f[cd][0-9a-f]*:/.test(v6)) {
      return { literal: true, unroutable: 'fc00::/7 (IPv6 unique-local)' };
    }
    if (/^fe[89ab][0-9a-f]*:/.test(v6)) {
      return { literal: true, unroutable: 'fe80::/10 (IPv6 link-local)' };
    }
    if (v6.startsWith('::ffff:')) {
      return { literal: true, unroutable: '::ffff:0:0/96 (IPv4-mapped IPv6)' };
    }
    return { literal: true, unroutable: null };
  }
  const octets = IPV4_LITERAL.exec(hostname);
  if (!octets) return { literal: false };
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  if (a > 255 || b > 255 || Number(octets[3]) > 255 || Number(octets[4]) > 255) {
    return { literal: false };
  }
  if (a === 169 && b === 254) {
    return { literal: true, unroutable: '169.254.0.0/16 (link-local, cloud metadata)' };
  }
  if (a === 127) return { literal: true, unroutable: '127.0.0.0/8 (loopback)' };
  if (a === 10) return { literal: true, unroutable: '10.0.0.0/8 (private)' };
  if (a === 172 && b >= 16 && b <= 31) {
    return { literal: true, unroutable: '172.16.0.0/12 (private)' };
  }
  if (a === 192 && b === 168) {
    return { literal: true, unroutable: '192.168.0.0/16 (private)' };
  }
  if (a === 0) return { literal: true, unroutable: '0.0.0.0/8 (this network)' };
  if (a === 100 && b >= 64 && b <= 127) {
    return { literal: true, unroutable: '100.64.0.0/10 (carrier-grade NAT)' };
  }
  return { literal: true, unroutable: null };
}

type AssetUrlVerdict = { ok: true; parsed: URL } | { ok: false; code: string; message: string };

/**
 * MAY THIS URL BE REQUESTED AT ALL?
 *
 * Separated from the fetch so it can be applied to EVERY hop of a redirect chain
 * — checking only the first url is the bypass, not the fix — and so each refusal
 * carries a code naming WHICH rule refused instead of one catch-all.
 *
 * DELIBERATELY NOT EXPORTED. A verdict a caller can obtain separately is a
 * verdict a caller can obtain and then ignore, which is the I11a/b/d shape this
 * file was written to remove: the gate stays in the diff, the call goes out
 * anyway. The only way to reach this judgement is to ask for the download, and
 * asking for the download is what performs it.
 *
 * The url is quoted VERBATIM in every message. A refusal that reports the
 * parser's tidied-up form leaves the reader guessing what was actually asked
 * for, and what was asked for is the whole evidence.
 */
function assetUrlVerdict(op: BillableOperation, url: string): AssetUrlVerdict {
  const refuse = (code: string, why: string): AssetUrlVerdict => ({
    ok: false,
    code,
    message: `${op.id} refused the asset url ${url} — ${why}.`,
  });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('asset-url-unparseable', 'it is not a url');
  }

  // SCHEME FIRST, AND ON `protocol` — NOT ON `origin`. Measured: the WHATWG
  // parser gives `blob:https://api.x.ai/abc` the origin `https://api.x.ai`, so a
  // guard written against the origin would wave a blob url through on the
  // strength of a host it never contacts. `data:` and `file:` parse fine too.
  if (parsed.protocol !== 'https:') {
    return refuse('asset-url-scheme-not-https', `its scheme is ${parsed.protocol} and only https: may be fetched`);
  }

  // Userinfo BEFORE the host, so the smuggle is named as a smuggle. Measured:
  // `https://api.x.ai@attacker.com/` parses to host `attacker.com` with the
  // provider host demoted to a username, so the host rule alone would refuse it
  // — but it would refuse it as "attacker.com is not the provider", which hides
  // the trick that was played.
  if (parsed.username !== '' || parsed.password !== '') {
    return refuse(
      'asset-url-carries-userinfo',
      `it carries credentials before the host, so its real host is ${parsed.host}`
    );
  }

  const address = addressClass(parsed.hostname);
  if (address.literal) {
    return address.unroutable === null
      ? refuse(
          'asset-url-host-is-a-literal-ip',
          `its host is the literal address ${parsed.hostname}, and a provider host is a name`
        )
      : refuse('asset-url-host-is-unroutable', `its host is in ${address.unroutable}, which never leaves this network`);
  }
  const lowered = parsed.hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    return refuse('asset-url-host-is-unroutable', 'its host resolves to this machine');
  }

  // EXACT host equality against the DECLARED SET, and `host` rather than
  // `hostname` so a port is part of the comparison. Exact is the point: a
  // suffix test is what lets `evil-vidgen.x.ai.attacker.com` through, and a
  // trailing dot (`vidgen.x.ai.`) is a different host string that a sloppier
  // comparison would also accept.
  const permitted = permittedAssetHosts(op);
  if (!permitted.includes(parsed.host)) {
    return refuse(
      'asset-url-host-not-the-registered-provider',
      `its host is ${parsed.host} and ${op.id} serves assets from ${permitted.join(', ')}`
    );
  }

  // An asset download carries no receipt, so it may never be aimed at a path
  // that BILLS. Derived from the registry rather than listed, exactly like
  // siblingOperationSegments: registering a new operation on this host closes
  // this door for it in the same edit.
  for (const other of BILLABLE_OPERATIONS.values()) {
    const registered = new URL(other.endpoint);
    if (registered.origin === parsed.origin && registered.pathname === parsed.pathname) {
      return refuse(
        'asset-url-is-a-registered-operation',
        `it is ${other.id}'s registered endpoint, and an asset download proves no debit`
      );
    }
  }

  return { ok: true, parsed };
}

export type ProviderAssetOutcome =
  | { ok: true; response: Response; mediaType: string }
  | { ok: false; code: string; message: string };

/**
 * How many redirects an asset download will follow. Small on purpose: signed
 * object-store urls redirect once, if at all, and every extra hop is another url
 * somebody else chose.
 */
const MAX_ASSET_REDIRECTS = 3;

/**
 * DOWNLOAD A FINISHED ARTIFACT FROM A URL THE PROVIDER CHOSE.
 *
 * REDIRECTS ARE FOLLOWED BY HAND. `fetch` follows them itself by default, and a
 * followed redirect is a request to a url nobody judged — validating only the
 * first url would leave the entire hole open behind a 302. So the request goes
 * out with `redirect: "manual"` and each `Location` is resolved against the url
 * it came from and put back through `assetUrlVerdict` BEFORE it is requested.
 *
 * MEASURED, NOT ASSUMED, on deno 2.6.10: `redirect: "manual"` returns the real
 * 3xx response with a readable `Location` header (`type: "basic"`), so the hop
 * can actually be inspected. Where a runtime hides it instead, `location` reads
 * back null and this refuses — loudly, and without following anything.
 *
 * NO AUTHORIZATION HEADER BY DEFAULT, DELIBERATELY. The asset url is the one
 * url here that an attacker may choose, so it is the one request that must
 * never carry a credential UNLESS the provider contract requires one:
 * OpenRouter's content endpoint authenticates the download. A caller may pass
 * `authorization`, and it is attached ONLY while the hop's host is the
 * operation's own registered `host` — the host the credential belongs to.
 * Every other hop (an allowed sibling asset host, any redirect target) gets
 * no header, so the credential can never leak to a host that merely looks
 * trusted. Do not widen that rule "for consistency".
 */
export async function fetchProviderAsset(args: {
  operationId: string;
  url: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  /**
   * OPTIONAL credential for providers whose content endpoint requires one
   * (OpenRouter). Attached only to requests aimed at `op.host` itself.
   */
  authorization?: string;
}): Promise<ProviderAssetOutcome> {
  const op = billableOperation(args.operationId);
  if (!op) {
    return {
      ok: false,
      code: 'operation-not-registered',
      message: `${args.operationId} is not a registered operation, so it has no asset host to trust.`,
    };
  }
  const declared = op.assetMediaType;
  if (typeof declared !== 'string' || declared === '') {
    return {
      ok: false,
      code: 'operation-declares-no-asset-media-type',
      message:
        `${op.id} declares no assetMediaType, so an artifact fetched for it could only be ` +
        'labelled from the response, which is the thing this refuses to do.',
    };
  }

  let target = args.url;
  for (let hop = 0; hop <= MAX_ASSET_REDIRECTS; hop++) {
    const verdict = assetUrlVerdict(op, target);
    if (!verdict.ok) return verdict;

    const response = await args.fetchFn(verdict.parsed.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: args.signal,
      // The credential rides ONLY to the host it belongs to. A hop to any
      // other host — even one the operation also permits for assets — goes
      // out bare.
      ...(args.authorization !== undefined && verdict.parsed.host === op.host
        ? { headers: { Authorization: args.authorization } }
        : {}),
    });

    if (response.status < 300 || response.status > 399) {
      // The type the caller gets is the REGISTRY'S. The header is not a fact
      // about the bytes — it is a claim by whoever answered — so it is used only
      // to detect a DISAGREEMENT, and a disagreement is a refusal: bytes the
      // provider itself says are not the artifact we bought must not be relabelled
      // into it. An ABSENT header contradicts nothing and the declared type stands.
      const header = response.headers.get('content-type');
      const essence = (header ?? '').split(';')[0].trim().toLowerCase();
      if (essence !== '' && essence !== declared) {
        await response.body?.cancel().catch(() => {});
        return {
          ok: false,
          code: 'asset-media-type-mismatch',
          message: `${op.id} expected ${declared} from ${target} and the response declared ${essence}.`,
        };
      }
      return { ok: true, response, mediaType: declared };
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (location === null || location === '') {
      return {
        ok: false,
        code: 'asset-redirect-without-location',
        message:
          `${op.id} was redirected from ${target} with HTTP ${response.status} to a location ` +
          'this runtime would not show, so the next url could not be judged before requesting it.',
      };
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return {
        ok: false,
        code: 'asset-redirect-location-unparseable',
        message: `${op.id} was redirected from ${target} to ${location}, which is not a url.`,
      };
    }
    target = next.toString();
  }

  return {
    ok: false,
    code: 'asset-redirect-limit',
    message: `${op.id} was redirected more than ${MAX_ASSET_REDIRECTS} times, ending at ${target}.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// (7) SETTLEMENT — one exact charge, or a full reversal
// ──────────────────────────────────────────────────────────────────────────

export type SettleOutcome =
  | { status: 'settled'; chargedEurCents: number; basis: string; adjusted: boolean }
  | { status: 'reversed'; reason: string }
  | { status: 'reversal-failed'; reason: string }
  | { status: 'unsettled'; reason: string };

/**
 * The ledger reason written with a reversal, per operation. Scoped and
 * explicit rather than derived: only the image lane was demonstrably
 * mislabeled ("video generation not produced" on an image refund), every
 * other operation keeps the lane default (`undefined` => the debit function's
 * own wording, unchanged). Billing semantics are NOT touched — this is the
 * recorded reason string only.
 */
function reversalReasonFor(operationId: string): string | undefined {
  if (operationId === 'multimodal.image_generation') return 'image generation not produced';
  if (operationId === 'multimodal.vision') return 'vision analysis not produced';
  if (operationId === 'multimodal.document_ocr') return 'document OCR not produced';
  if (operationId === 'multimodal.tts') return 'speech synthesis not produced';
  return undefined;
}

/**
 * Turns the held BOUND into the EXACT charge.
 *
 *   * exact >= bound  -> the reservation IS the charge. One ledger movement, no
 *     second write. (The exact is capped at the bound: we never charge more than
 *     was reserved and proven affordable.)
 *   * exact <  bound  -> reverse the reservation, then commit the exact under its
 *     own external ref. Two movements, one net charge.
 *   * unpriceable     -> reverse the reservation and report. The caller must then
 *     return NO artifact and NO 200.
 *
 * ORDERING AND ITS RESIDUAL RISK, STATED. `command_eve_commit_debit` is
 * idempotent per external_ref and `command_eve_reverse_debit` reverses a whole
 * ref, so a partial refund is not expressible: the down-adjustment must reverse
 * then re-commit. Between those two calls a concurrent request could drain the
 * balance the reversal just returned, and the exact commit would come back
 * insufficient. That path yields `unsettled` — and an `unsettled` settlement MUST
 * cost the caller its artifact. The failure mode is therefore a revenue leak we
 * ate the provider cost for, NEVER a paid artifact leaving unbilled.
 */
export async function settleBillableOperation(args: {
  port: BillingLedgerPort;
  receipt: ReserveReceipt;
  actual: PricedAmount;
  model: string;
}): Promise<SettleOutcome> {
  const op = billableOperation(args.receipt.operationId);
  if (!op) return { status: 'unsettled', reason: 'operation-not-registered' };

  if (!args.actual.ok) {
    const reversal = await args.port.reverse({
      entitlementId: args.receipt.entitlementId,
      tenantId: args.receipt.tenantId,
      externalRef: args.receipt.externalRef,
      reason: reversalReasonFor(args.receipt.operationId),
    });
    return reversal.ok
      ? { status: 'reversed', reason: args.actual.reason }
      : {
          status: 'reversal-failed',
          reason: `${args.actual.reason}/${reversal.reason ?? 'unknown'}`,
        };
  }

  if (args.actual.retailEurCents > args.receipt.boundEurCents) {
    const reversal = await args.port.reverse({
      entitlementId: args.receipt.entitlementId,
      tenantId: args.receipt.tenantId,
      externalRef: args.receipt.externalRef,
      reason: reversalReasonFor(args.receipt.operationId),
    });
    return reversal.ok
      ? { status: 'reversed', reason: 'actual-exceeds-reserved-bound' }
      : {
          status: 'reversal-failed',
          reason: `actual-exceeds-reserved-bound/${reversal.reason ?? 'unknown'}`,
        };
  }

  const exact = args.actual.retailEurCents;
  // Credits are the finest billable unit; a difference below one credit cannot be
  // expressed in the ledger, so adjusting for it would write two rows to change
  // nothing. Keep the reservation.
  const ONE_CREDIT_EUR_CENTS = 0.1;
  if (args.receipt.boundEurCents - exact < ONE_CREDIT_EUR_CENTS) {
    return {
      status: 'settled',
      chargedEurCents: args.receipt.boundEurCents,
      basis: args.actual.basis,
      adjusted: false,
    };
  }

  const reversal = await args.port.reverse({
    entitlementId: args.receipt.entitlementId,
    tenantId: args.receipt.tenantId,
    externalRef: args.receipt.externalRef,
    reason: reversalReasonFor(args.receipt.operationId),
  });
  if (!reversal.ok) {
    // The bound stays charged. The customer is over-charged relative to actual
    // cost, but the artifact IS paid for, so it may be released. Reported, never
    // silent — a human reconciles it.
    return {
      status: 'settled',
      chargedEurCents: args.receipt.boundEurCents,
      basis: `${args.actual.basis}/down-adjust-unavailable`,
      adjusted: false,
    };
  }

  const commit = await args.port.commit({
    tenantId: args.receipt.tenantId,
    costEurCents: exact,
    externalRef: `${args.receipt.externalRef}:actual`,
    model: args.model,
    reason: `${op.id} actual`,
    expectedEntitlementId: args.receipt.entitlementId,
  });
  if (commit.status === 'applied' || commit.status === 'already') {
    return {
      status: 'settled',
      chargedEurCents: exact,
      basis: args.actual.basis,
      adjusted: true,
    };
  }
  return { status: 'unsettled', reason: `exact-commit-${commit.status}` };
}
