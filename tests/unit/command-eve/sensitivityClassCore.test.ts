import { describe, expect, it } from 'vitest';

import {
  classifyFinding,
  classifyMaxSensitivity,
  sensitivityRank,
  type CommandEveSensitivityClass,
} from '@/common/api/sensitivityClassCore';
import type { CommandEveEgressFinding } from '@/common/api/egressBoundaryCore';

const finding = (kind: CommandEveEgressFinding['kind'], rule_id: string, count = 1): CommandEveEgressFinding => ({
  kind,
  rule_id,
  count,
});

describe('sensitivityClassCore — classifyFinding (kind→class map)', () => {
  it('maps secret → S3 (hard floor)', () => {
    expect(classifyFinding(finding('secret', 'provider-api-key-token'))).toBe('S3');
    expect(classifyFinding(finding('secret', 'secret-assignment'))).toBe('S3');
  });

  it('maps financial → S3 (IBAN / card / BIC)', () => {
    expect(classifyFinding(finding('financial', 'iban'))).toBe('S3');
    expect(classifyFinding(finding('financial', 'payment-card-number'))).toBe('S3');
    expect(classifyFinding(finding('financial', 'bic-swift'))).toBe('S3');
  });

  it('maps health → S3 (GDPR Art. 9)', () => {
    expect(classifyFinding(finding('health', 'health-identifier'))).toBe('S3');
    expect(classifyFinding(finding('health', 'health-insurance-number'))).toBe('S3');
  });

  it('maps intl_pii → S2', () => {
    expect(classifyFinding(finding('intl_pii', 'intl-phone-number'))).toBe('S2');
    expect(classifyFinding(finding('intl_pii', 'intl-street-address'))).toBe('S2');
    expect(classifyFinding(finding('intl_pii', 'us-ssn'))).toBe('S2');
    expect(classifyFinding(finding('intl_pii', 'north-american-phone'))).toBe('S2');
  });

  it('maps german_pii address → S2, phone-only → S1 (the phone-only refinement)', () => {
    expect(classifyFinding(finding('german_pii', 'german-street-address'))).toBe('S2');
    expect(classifyFinding(finding('german_pii', 'german-phone-number'))).toBe('S1');
  });

  it('maps email → S1', () => {
    expect(classifyFinding(finding('email', 'email-address'))).toBe('S1');
  });
});

describe('sensitivityClassCore — classifyMaxSensitivity (max across findings)', () => {
  it('empty findings → S0', () => {
    expect(classifyMaxSensitivity([])).toBe('S0');
  });

  it('returns the MAX class present (S3 dominates)', () => {
    expect(
      classifyMaxSensitivity([
        finding('email', 'email-address'),
        finding('german_pii', 'german-phone-number'),
        finding('secret', 'provider-api-key-token'),
      ])
    ).toBe('S3');
  });

  it('returns S2 when the top finding is intl/address (no S3)', () => {
    expect(classifyMaxSensitivity([finding('email', 'email-address'), finding('intl_pii', 'intl-phone-number')])).toBe(
      'S2'
    );
  });

  it('returns S1 when only email + phone-only german_pii present', () => {
    expect(
      classifyMaxSensitivity([finding('email', 'email-address'), finding('german_pii', 'german-phone-number')])
    ).toBe('S1');
  });

  it('german_pii address bumps the max to S2 even alongside a phone-only finding', () => {
    expect(
      classifyMaxSensitivity([
        finding('german_pii', 'german-phone-number'),
        finding('german_pii', 'german-street-address'),
      ])
    ).toBe('S2');
  });
});

describe('sensitivityClassCore — sensitivityRank ordering', () => {
  it('ranks S0 < S1 < S2 < S3', () => {
    const order: CommandEveSensitivityClass[] = ['S0', 'S1', 'S2', 'S3'];
    for (let i = 1; i < order.length; i += 1) {
      expect(sensitivityRank(order[i])).toBeGreaterThan(sensitivityRank(order[i - 1]));
    }
  });
});
