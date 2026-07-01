/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sensitivity-Gate S0–S3 (S12, v2 brick) — PURE, injectable, no network.
 *
 * Maps egress finding-KINDS to a four-level sensitivity ladder and returns the
 * MAX class present in a request. This is the classification half of the gate;
 * the CONSEQUENCE half (who may waive which class, hard S3 floor) lives in
 * `egressBoundaryCore.evaluateCommandEveEgressBoundary`.
 *
 * Architecture: docs/strategy/command-eve-sensitivity-gate-architecture-2026-07-02.md
 *
 * The ladder (architecture §"Die Lücke"):
 *   secret     → S3  (HARD FLOOR — raw credentials never leave, toggle can't waive)
 *   financial  → S3  (IBAN / card / BIC, GDPR + PSD2)
 *   health     → S3  (GDPR Art. 9 special category)
 *   intl_pii   → S2  (non-DACH address / phone / national id)
 *   german_pii → S2, but S1 when the finding is PHONE-ONLY (a bare number is
 *                lower-stakes than a full postal address). We CAN distinguish:
 *                german_pii carries two rule_ids — `german-phone-number` (S1)
 *                and `german-street-address` (S2). Any non-phone german_pii
 *                finding (address, or any future german_pii rule) maps S2
 *                conservatively (unsure → HIGHER).
 *   email      → S1  (contactable identifier, lowest PII stake)
 *   (none)     → S0
 */

import type {
  CommandEveEgressFinding,
  CommandEveEgressFindingKind,
  CommandEveSensitivityClass,
} from './egressBoundaryCore';

// Re-export so callers can import the class type from either module.
export type { CommandEveSensitivityClass } from './egressBoundaryCore';

const CLASS_RANK: Record<CommandEveSensitivityClass, number> = {
  S0: 0,
  S1: 1,
  S2: 2,
  S3: 3,
};

/** Numeric rank of a class — for `>=` comparisons in the shouldRedact rule. */
export function sensitivityRank(sClass: CommandEveSensitivityClass): number {
  return CLASS_RANK[sClass];
}

/**
 * Base kind → class map. `german_pii` is intentionally the conservative S2 here;
 * the phone-only S1 refinement is applied per-finding in `classifyFinding` using
 * the rule_id (only when we can PROVE it's phone-only). Unknown/future kinds fall
 * through to S3 in `classifyFinding` (unsure → HIGHER/safer, never leniency).
 */
const KIND_CLASS: Record<CommandEveEgressFindingKind, CommandEveSensitivityClass> = {
  secret: 'S3',
  financial: 'S3',
  health: 'S3',
  intl_pii: 'S2',
  german_pii: 'S2',
  email: 'S1',
};

/** The rule_id a german_pii finding carries when it is a bare phone number (→ S1). */
const GERMAN_PII_PHONE_RULE_ID = 'german-phone-number';

/**
 * Classify a SINGLE finding to its S-class. Phone-only german_pii (rule_id
 * `german-phone-number`) is S1; every other german_pii (address, etc.) stays S2.
 * A finding whose kind is not in the map (shouldn't happen — the type union is
 * exhaustive, but defends against a future kind added without a map entry) is
 * classified S3 (fail-safe HIGHER).
 */
export function classifyFinding(finding: CommandEveEgressFinding): CommandEveSensitivityClass {
  if (finding.kind === 'german_pii') {
    return finding.rule_id === GERMAN_PII_PHONE_RULE_ID ? 'S1' : 'S2';
  }
  const mapped = KIND_CLASS[finding.kind];
  // Defensive: an unmapped kind (future addition) classifies to the hard floor.
  return mapped ?? 'S3';
}

/**
 * Return the MAX sensitivity class across all findings. Empty / no findings → S0.
 * Pure; no network, no I/O.
 */
export function classifyMaxSensitivity(findings: CommandEveEgressFinding[]): CommandEveSensitivityClass {
  let max: CommandEveSensitivityClass = 'S0';
  for (const finding of findings) {
    const sClass = classifyFinding(finding);
    if (CLASS_RANK[sClass] > CLASS_RANK[max]) {
      max = sClass;
    }
  }
  return max;
}
