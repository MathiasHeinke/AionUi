/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CommandEveEgressPolicyAction = 'block' | 'redact' | 'allow';
export type CommandEveEgressDecision = 'allow' | 'block' | 'redact';
export type CommandEveEgressProviderKind = 'local' | 'cloud' | 'unknown';
export type CommandEveEgressFindingKind = 'secret' | 'german_pii' | 'email' | 'financial' | 'intl_pii' | 'health';

/**
 * Sensitivity-Gate S0–S3 (S12, v2 brick).
 *
 * S3 = HARD FLOOR: secret / financial / health. The operator PII toggle (S11)
 * can NEVER waive an S3 redaction — raw credentials, health and finance data of
 * a reseller's CLIENTS must not leave for a third-party cloud model even with the
 * operator's protection switched off. That is Auftragsverarbeiter (processor)
 * liability, not operator convenience, and it is the DSGVO sales lever:
 * "even with the filter OFF, EVE never sends your clients' raw credentials,
 * health or finance data to the cloud."
 *
 * FLIP TO false ONLY behind a future founder-gated (HG-4) per-call override —
 * never a silent standing switch. Shipped `true` (recommended DSGVO-safe default).
 */
export const S3_HARD_FLOOR = true;

/**
 * The PII/DSGVO egress-redaction toggle mode (S11), threaded into the boundary so
 * the decision becomes sensitivity-class-aware (S12). `'on'` = redact S1+ (the
 * default); `'off'` = the operator waived redaction FOR WAIVABLE CLASSES ONLY
 * (S1/S2) — S3 is still redacted by the hard floor. When UNDEFINED the boundary
 * behaves exactly as before S12 (redact everything), so passing no toggle context
 * is byte-identical to legacy callers.
 */
export type CommandEveEgressToggleMode = 'on' | 'off';

/**
 * Sensitivity ladder (S12). Defined here — the lowest-level egress module — so
 * both this boundary and `sensitivityClassCore` share one source of truth without
 * a runtime import cycle. `sensitivityClassCore` re-exports it.
 */
export type CommandEveSensitivityClass = 'S0' | 'S1' | 'S2' | 'S3';

const SENSITIVITY_CLASS_RANK: Record<CommandEveSensitivityClass, number> = {
  S0: 0,
  S1: 1,
  S2: 2,
  S3: 3,
};

export type CommandEveEgressProvider = {
  kind: CommandEveEgressProviderKind;
  name?: string;
  model?: string;
  baseUrl?: string;
};

export type CommandEveEgressFinding = {
  kind: CommandEveEgressFindingKind;
  rule_id: string;
  count: number;
};

/**
 * Redaction-status evidence on the receipt (S11). Present ONLY when the shim
 * consciously DID NOT apply the redactor to an outbound turn because the operator
 * turned the PII/DSGVO egress filter OFF for the active seat. Absent on every
 * normal turn — its absence means "the standard boundary applied" (redact/block/
 * allow per `decision`), never "silently disabled". Evidence, not silence: a
 * DSGVO control-waiver must be visible in the audit trail.
 */
export type CommandEveEgressRedactionStatus = 'disabled_by_operator';

export type CommandEveEgressBoundaryReceipt = {
  version: 'command-eve-egress-boundary-receipt/v0';
  observed_at: string;
  provider: CommandEveEgressProvider;
  policy_action: CommandEveEgressPolicyAction;
  decision: CommandEveEgressDecision;
  finding_count: number;
  findings: CommandEveEgressFinding[];
  input_sha256: string;
  output_sha256?: string;
  raw_text_stored: false;
  reason: string;
  /**
   * S11 — only set to `'disabled_by_operator'` when the operator switched the
   * PII/DSGVO egress filter OFF for this seat and the shim therefore skipped
   * redaction. Omitted on every other turn.
   */
  redaction?: CommandEveEgressRedactionStatus;
  /**
   * S12 — the MAX sensitivity class present in this request (S0–S3). Present
   * whenever a toggle context was passed (i.e. the class-aware path ran). Omitted
   * on the pure-legacy path (no toggle context) to keep those receipts byte-stable.
   */
  sensitivity_class?: CommandEveSensitivityClass;
  /**
   * S12 — set `true` when the operator toggle was OFF but an S3 finding was STILL
   * redacted (or blocked) by the hard floor. Positive trust evidence: EVE
   * protected the client's credentials / health / finance data despite the
   * operator having switched the filter off. Absent when no S3 hard-floor
   * enforcement occurred.
   */
  s3_hard_floor_enforced?: true;
  /**
   * S12 — evidence of a deliberate DSGVO control-waiver: the operator toggle was
   * OFF and S1 (email / phone-only) findings were consciously passed through
   * UNREDACTED. Absent when no S1 finding was waived.
   */
  operator_waived_s1?: true;
  /**
   * S12 — as `operator_waived_s1` but for S2 findings (address / non-DACH PII).
   */
  operator_waived_s2?: true;
  /**
   * S12 — set `true` when an S3 finding could NOT be safely redacted and the
   * boundary therefore hard-BLOCKED the turn (decision `'block'`). Absent
   * otherwise.
   */
  blocked_s3?: true;
};

export type CommandEveEgressBoundaryInput = {
  text: string;
  provider: CommandEveEgressProvider;
  policyAction?: CommandEveEgressPolicyAction;
  now?: Date;
  /**
   * S12 — the operator PII/DSGVO toggle mode (S11) for this seat, threaded in so
   * the boundary can apply the sensitivity-class gate:
   *   - `'on'`  → redact every S1+ finding (the safe default behaviour).
   *   - `'off'` → WAIVE S1/S2 findings (operator responsibility) but STILL redact
   *               (or block) S3 — the hard floor the operator cannot switch off.
   *   - UNDEFINED → legacy behaviour: redact everything, no class-aware receipt
   *                 fields. Byte-identical to pre-S12 for every existing caller.
   */
  toggleMode?: CommandEveEgressToggleMode;
};

export type CommandEveEgressBoundaryResult = {
  decision: CommandEveEgressDecision;
  allowedText?: string;
  receipt: CommandEveEgressBoundaryReceipt;
};

type SensitiveRule = {
  kind: CommandEveEgressFindingKind;
  ruleId: string;
  pattern: RegExp;
  replacement: string;
};

// ORDER MATTERS: redactCommandEveSensitiveText applies these as a sequential
// reduce, so a high-value token (IBAN, card, health id) MUST be redacted BEFORE
// a broader numeric rule (phone) can fragment it. Financial + health therefore
// come BEFORE the phone rules; email (the most generic) stays last.
const SENSITIVE_RULES: SensitiveRule[] = [
  {
    kind: 'secret',
    ruleId: 'provider-api-key-token',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: '[REDACTED_SECRET]',
  },
  {
    kind: 'secret',
    ruleId: 'secret-assignment',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwort)\s*[:=]\s*["']?[^"'\s]{8,}["']?/gi,
    replacement: '[REDACTED_SECRET_ASSIGNMENT]',
  },
  // --- Financial PII (S3) — BEFORE phones (an IBAN's interior digit groups would
  // otherwise be eaten by the phone rule, leaking the country+bank prefix). ---
  {
    kind: 'financial',
    ruleId: 'iban',
    // {2,8} four-char groups covers the full 15–34 char IBAN length range (incl. the 15-char NO IBAN).
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,8}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
    replacement: '[REDACTED_IBAN]',
  },
  {
    kind: 'financial',
    ruleId: 'payment-card-number',
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g,
    replacement: '[REDACTED_CARD]',
  },
  {
    kind: 'financial',
    ruleId: 'bic-swift',
    pattern: /\b(?:BIC|SWIFT)\b\s*[:=]?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi,
    replacement: '[REDACTED_BIC]',
  },
  // --- Health / special-category PII (S3, GDPR Art. 9) — BEFORE phones. ---
  {
    kind: 'health',
    // Label-anchored, allowing a small filler window ("...nummer IST A123...") between label and value.
    ruleId: 'health-identifier',
    pattern: /\b(?:versichertennummer|insurance\s*(?:no\.?|number|id)|patient\s*(?:id|no\.?|number)|medical\s*record\s*(?:no\.?|number)|kranken(?:versicherung|kasse))\b(?:\s+\w+){0,3}\s*[:=#]?\s*[A-Z0-9][A-Z0-9-]{4,}\b/gi,
    replacement: '[REDACTED_HEALTH_ID]',
  },
  {
    kind: 'health',
    // Bare German health-insurance number (Versichertennummer): 1 letter + 9 digits.
    ruleId: 'health-insurance-number',
    pattern: /\b[A-Z]\d{9}\b/g,
    replacement: '[REDACTED_HEALTH_ID]',
  },
  // --- German PII ---
  {
    kind: 'german_pii',
    ruleId: 'german-street-address',
    pattern: /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:straße|strasse|weg|allee|platz|gasse|ring|damm)\s+\d+[a-z]?\b/gi,
    replacement: '[REDACTED_ADDRESS]',
  },
  {
    kind: 'german_pii',
    ruleId: 'german-phone-number',
    // Two anchored alternatives. The OLD pattern (`(?:\+49|0049|0)…[\d\s./-]{2,}`) had no
    // leading boundary, a bare `0` trunk, and a greedy digit/separator tail with no upper
    // bound — so it matched arbitrary numeric noise: 16-digit IDs, space-split number pairs,
    // and digits inside larger tokens. A real tool result carrying Electron/Chromium process
    // args (`--field-trial-handle=…12330025412369110397`, `--trace-process-track-uuid=…`)
    // produced 99 phantom "phone numbers" → a hard egress block (HTTP 451, non-retryable) →
    // the agent aborted silently and the UI hung on any longer tool session. (Verified against
    // the actual request-dump: 99 → 0 false positives, all real German numbers still caught.)
    // (A) +49/0049 international form: prefix + optional (0) + 6-12 more digits (single seps).
    // (B) national 0-trunk: leading 0 + an IMMEDIATE digit (excludes "0 435308800" process
    //     pairs) + 7-10 more digits, each optionally single-separated. The optional separator
    //     is the key fix: it matches BOTH the contiguous form `01701234567`/`03012345678` (the
    //     dominant way a German types a mobile — a v1.1.78-era tighten REGRESSED this to raw
    //     egress) AND the spaced `0170 1234567`. Total 9-12 digits with a trailing boundary, so
    //     16-digit process IDs (`0025412369110397`) and 2+-space number tables still don't match.
    // Both require word/number boundaries so they cannot start or end mid-token.
    pattern:
      /(?<![\w.+/])(?:\+49|0049)[ ./-]?\(?0?\)?[ ./-]?(?:\d[ ./-]?){6,12}\d\b|(?<![\w.+/\d-])0\d(?:[ ./-]?\d){7,10}(?![\d\w])/g,
    replacement: '[REDACTED_PHONE]',
  },
  // --- International PII (S2) — addresses, phones, national IDs outside DACH ---
  {
    kind: 'intl_pii',
    ruleId: 'intl-phone-number',
    pattern: /\+(?!49)\d{1,3}[\s.\-/()]?(?:\d[\s.\-/()]?){6,13}\d\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  {
    kind: 'intl_pii',
    // North-American format REQUIRES the (NNN) parenthesised area code (optionally +1-prefixed).
    // A bare NNN-NNN-NNNN run is indistinguishable from order/SKU/ref numbers, so it is NOT matched
    // (+1-prefixed bare numbers are caught by intl-phone above). The (?<![\w(]) anchors the parens form.
    ruleId: 'north-american-phone',
    pattern: /(?<![\w(])(?:\+?1[\s.\-]?)?\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  {
    kind: 'intl_pii',
    // Trailing lookahead requires the street suffix to end a clause (comma/period/newline/end) or be
    // followed by a Capitalised city token — kills "Top 10 Marketing Avenue strategies"-style FPs.
    ruleId: 'intl-street-address',
    pattern: /\b\d{1,5}\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}\s+(?:Street|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Drive|Court|Place|Square|Terrace|Parkway|Pkwy|Highway|Hwy|Crescent|Close)\b(?=[,.\n]|\s+[A-Z]|$)/g,
    replacement: '[REDACTED_ADDRESS]',
  },
  {
    kind: 'intl_pii',
    ruleId: 'us-ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_NATIONAL_ID]',
  },
  // --- Email (most generic) stays LAST ---
  {
    kind: 'email',
    ruleId: 'email-address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: '[REDACTED_EMAIL]',
  },
];

async function sha256(value: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.subtle) {
    const encoded = new TextEncoder().encode(value);
    const digest = await cryptoApi.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return `fallback-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function detectCommandEveSensitiveEgress(text: string): CommandEveEgressFinding[] {
  return SENSITIVE_RULES.map((rule) => ({
    kind: rule.kind,
    rule_id: rule.ruleId,
    count: countMatches(text, rule.pattern),
  })).filter((finding) => finding.count > 0);
}

export function redactCommandEveSensitiveText(text: string): string {
  return SENSITIVE_RULES.reduce((currentText, rule) => currentText.replace(rule.pattern, rule.replacement), text);
}

/**
 * S12 — the S-class of a single detector RULE. Mirrors the finding-kind→class map
 * in `sensitivityClassCore`, with the same german_pii phone-only refinement
 * (`german-phone-number` → S1, other german_pii → S2). Kept HERE so the
 * threshold redactor and the classifier can never drift apart. An unmapped kind
 * falls through to the hard floor (S3 — unsure → HIGHER/safer).
 */
export function sensitivityClassForRule(kind: CommandEveEgressFindingKind, ruleId: string): CommandEveSensitivityClass {
  switch (kind) {
    case 'secret':
    case 'financial':
    case 'health':
      return 'S3';
    case 'intl_pii':
      return 'S2';
    case 'german_pii':
      return ruleId === 'german-phone-number' ? 'S1' : 'S2';
    case 'email':
      return 'S1';
    default:
      return 'S3';
  }
}

/**
 * S12 — redact ONLY the rules whose S-class is at/above `minClass`, leaving
 * lower-class matches intact. This is what makes the operator toggle SELECTIVE:
 * with the toggle OFF and `minClass='S3'`, S1/S2 findings pass through unredacted
 * (operator's waivable responsibility) while S3 credentials/health/finance are
 * still stripped (the hard floor). `minClass='S1'` reproduces
 * `redactCommandEveSensitiveText` exactly (every rule is ≥ S1).
 */
export function redactCommandEveSensitiveTextAtOrAbove(text: string, minClass: CommandEveSensitivityClass): string {
  const threshold = SENSITIVITY_CLASS_RANK[minClass];
  return SENSITIVE_RULES.reduce((currentText, rule) => {
    const ruleClass = sensitivityClassForRule(rule.kind, rule.ruleId);
    if (SENSITIVITY_CLASS_RANK[ruleClass] < threshold) return currentText;
    return currentText.replace(rule.pattern, rule.replacement);
  }, text);
}

/**
 * S12 — MAX S-class across a set of findings (S0 when empty). Internal to the
 * boundary; the public, pure classifier is `classifyMaxSensitivity` in
 * `sensitivityClassCore` (which returns the identical result via the same rule
 * map). Kept here to avoid a value-level import cycle between the two modules.
 */
function maxSensitivityClass(findings: CommandEveEgressFinding[]): CommandEveSensitivityClass {
  let max: CommandEveSensitivityClass = 'S0';
  for (const finding of findings) {
    const sClass = sensitivityClassForRule(finding.kind, finding.rule_id);
    if (SENSITIVITY_CLASS_RANK[sClass] > SENSITIVITY_CLASS_RANK[max]) {
      max = sClass;
    }
  }
  return max;
}

export async function evaluateCommandEveEgressBoundary(
  input: CommandEveEgressBoundaryInput
): Promise<CommandEveEgressBoundaryResult> {
  const text = input.text || '';
  // DEFAULT = redact, NOT block. A hard block returns HTTP 451 (non-retryable) and the
  // agent aborts mid-turn — for a product that runs terminal/tool calls whose output is
  // full of numeric noise (and for a reseller legitimately processing client contact
  // data), that silently HANGS the whole session. Redaction preserves the DSGVO invariant
  // (sensitive values are replaced with placeholders and NEVER reach the cloud model) while
  // letting the turn proceed. `block` remains available as an explicit opt-in strict mode.
  const policyAction = input.policyAction || 'redact';
  const findings = detectCommandEveSensitiveEgress(text);
  const hasSensitiveFindings = findings.length > 0;
  const observedAt = (input.now || new Date()).toISOString();
  const findingCount = findings.reduce((sum, finding) => sum + finding.count, 0);
  const inputSha = await sha256(text);

  // ── LEGACY PATH (no toggle context) ─────────────────────────────────────────
  // Byte-identical to pre-S12. Every existing caller passes no `toggleMode`, so
  // this branch is the untouched behaviour: redact everything (or block/allow per
  // policyAction), with NO class-aware receipt fields. Regression-guarded by test.
  if (input.toggleMode === undefined) {
    const sanitizedText = hasSensitiveFindings ? redactCommandEveSensitiveText(text) : text;
    const decision: CommandEveEgressDecision = hasSensitiveFindings
      ? policyAction === 'allow'
        ? 'allow'
        : policyAction
      : 'allow';
    const receipt: CommandEveEgressBoundaryReceipt = {
      version: 'command-eve-egress-boundary-receipt/v0',
      observed_at: observedAt,
      provider: input.provider,
      policy_action: policyAction,
      decision,
      finding_count: findingCount,
      findings,
      input_sha256: inputSha,
      ...(decision === 'redact' ? { output_sha256: await sha256(sanitizedText) } : {}),
      raw_text_stored: false,
      reason: hasSensitiveFindings ? `sensitive-egress-${decision}` : 'no-sensitive-egress-detected',
    };
    return {
      decision,
      allowedText: decision === 'redact' ? sanitizedText : text,
      receipt,
    };
  }

  // ── SENSITIVITY-GATE PATH (S12, toggle context present) ─────────────────────
  const toggleMode = input.toggleMode;
  const maxSClass = maxSensitivityClass(findings);
  const maxRank = SENSITIVITY_CLASS_RANK[maxSClass];
  const hasS3 = maxRank >= SENSITIVITY_CLASS_RANK.S3;

  // The one rule (architecture §"Die Lücke"):
  //   shouldRedact = (maxSClass === 'S3' AND hard floor) OR (toggle 'on' AND ≥ S1)
  // Toggle OFF waives S1/S2 only; S3 is ALWAYS redacted (or blocked) by the floor.
  const s3Enforced = hasS3 && S3_HARD_FLOOR;
  const toggleWantsRedaction = toggleMode === 'on' && maxRank >= SENSITIVITY_CLASS_RANK.S1;
  const shouldRedact = s3Enforced || toggleWantsRedaction;

  // The redaction THRESHOLD is what makes the waiver selective:
  //   - toggle 'on'  → redact every S1+ finding.
  //   - toggle 'off' → redact ONLY S3 (waive S1/S2); lower matches pass through.
  const redactThreshold: CommandEveSensitivityClass = toggleMode === 'on' ? 'S1' : 'S3';

  // S3 that cannot be safely redacted → hard BLOCK (strict opt-in preserved). A
  // block is only possible when the caller explicitly asked for strict mode AND an
  // S3 finding is present; the default `policyAction` ('redact') never blocks.
  const blockS3 = hasS3 && policyAction === 'block';

  let decision: CommandEveEgressDecision;
  let outputText = text;
  if (blockS3) {
    decision = 'block';
  } else if (shouldRedact) {
    decision = 'redact';
    outputText = redactCommandEveSensitiveTextAtOrAbove(text, redactThreshold);
  } else {
    // Nothing to redact at this threshold (S0, or S1/S2 waived with toggle off).
    decision = 'allow';
  }

  // Per-class waiver evidence: with the toggle OFF, S1/S2 findings that were NOT
  // redacted are consciously waived by the operator — record the honest audit trail.
  const waivedS1 = toggleMode === 'off' && findings.some((f) => sensitivityClassForRule(f.kind, f.rule_id) === 'S1');
  const waivedS2 = toggleMode === 'off' && findings.some((f) => sensitivityClassForRule(f.kind, f.rule_id) === 'S2');
  // Hard-floor evidence: the toggle was off, yet an S3 finding was still redacted
  // or blocked. Positive trust signal — EVE protected the client despite the toggle.
  const s3HardFloorEnforced = toggleMode === 'off' && s3Enforced && (decision === 'redact' || decision === 'block');

  const reason = !hasSensitiveFindings
    ? 'no-sensitive-egress-detected'
    : decision === 'block'
      ? 'sensitive-egress-block-s3'
      : decision === 'redact'
        ? `sensitive-egress-redact-${redactThreshold.toLowerCase()}`
        : 'sensitive-egress-waived';

  const receipt: CommandEveEgressBoundaryReceipt = {
    version: 'command-eve-egress-boundary-receipt/v0',
    observed_at: observedAt,
    provider: input.provider,
    policy_action: policyAction,
    decision,
    finding_count: findingCount,
    findings,
    input_sha256: inputSha,
    ...(decision === 'redact' ? { output_sha256: await sha256(outputText) } : {}),
    raw_text_stored: false,
    reason,
    sensitivity_class: maxSClass,
    ...(s3HardFloorEnforced ? { s3_hard_floor_enforced: true as const } : {}),
    ...(waivedS1 ? { operator_waived_s1: true as const } : {}),
    ...(waivedS2 ? { operator_waived_s2: true as const } : {}),
    ...(decision === 'block' ? { blocked_s3: true as const } : {}),
  };

  return {
    decision,
    allowedText: decision === 'redact' ? outputText : text,
    receipt,
  };
}
