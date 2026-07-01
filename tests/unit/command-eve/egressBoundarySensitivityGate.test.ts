import { describe, expect, it } from 'vitest';

import {
  evaluateCommandEveEgressBoundary,
  S3_HARD_FLOOR,
} from '@/process/commandEve/egressBoundaryCore';

const CLOUD_PROVIDER = {
  kind: 'cloud' as const,
  name: 'EVE Inference',
  model: 'standard',
  baseUrl: 'https://eve-inference.example',
};

// Sample payloads keyed by the S-class they should classify to.
const EMAIL_S1 = 'Schreib an mathias@example.com bitte.';
const PHONE_S1 = 'Ruf den Kunden unter 0151 23456789 an.';
const ADDRESS_S2 = 'Liefere an Hauptstraße 12 in Berlin.';
const INTL_S2 = 'Ship to 1600 Pennsylvania Avenue, Washington.';
const SECRET_S3 = 'Mein API key: sk-abcdefghijklmnopqrstuvwxyz123456';
const IBAN_S3 = 'Überweise auf IBAN DE89 3704 0044 0532 0130 00 heute.';
const HEALTH_S3 = 'Versichertennummer: A123456789 — bitte vormerken.';

describe('Sensitivity-Gate (S12) — S0/S1/S2 with the operator toggle', () => {
  it('S0 (clean text) → allow in BOTH toggle modes', async () => {
    const clean = 'Bitte erstelle einen Plan fuer die naechsten drei Schritte.';
    for (const toggleMode of ['on', 'off'] as const) {
      const result = await evaluateCommandEveEgressBoundary({
        text: clean,
        provider: CLOUD_PROVIDER,
        toggleMode,
      });
      expect(result.decision).toBe('allow');
      expect(result.receipt.sensitivity_class).toBe('S0');
      expect(result.allowedText).toBe(clean);
    }
  });

  it('S1 (email) + toggle ON → redact', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: EMAIL_S1,
      provider: CLOUD_PROVIDER,
      toggleMode: 'on',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S1');
    expect(result.allowedText).toContain('[REDACTED_EMAIL]');
    expect(result.allowedText).not.toContain('mathias@example.com');
  });

  it('S1 (email) + toggle OFF → passes through + receipt operator_waived_s1', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: EMAIL_S1,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('allow');
    expect(result.receipt.sensitivity_class).toBe('S1');
    expect(result.receipt.operator_waived_s1).toBe(true);
    expect(result.allowedText).toContain('mathias@example.com'); // waived, not redacted
    expect(result.receipt.s3_hard_floor_enforced).toBeUndefined();
  });

  it('S1 (phone-only german_pii) classifies to S1 and is waivable when off', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: PHONE_S1,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.receipt.sensitivity_class).toBe('S1');
    expect(result.decision).toBe('allow');
    expect(result.receipt.operator_waived_s1).toBe(true);
    expect(result.allowedText).toContain('23456789');
  });

  it('S2 (german address) + toggle ON → redact', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: ADDRESS_S2,
      provider: CLOUD_PROVIDER,
      toggleMode: 'on',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S2');
    expect(result.allowedText).toContain('[REDACTED_ADDRESS]');
  });

  it('S2 (german address) + toggle OFF → passes through + operator_waived_s2', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: ADDRESS_S2,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('allow');
    expect(result.receipt.sensitivity_class).toBe('S2');
    expect(result.receipt.operator_waived_s2).toBe(true);
    expect(result.allowedText).toContain('Hauptstraße 12');
  });

  it('S2 (intl address) + toggle OFF → waived S2', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: INTL_S2,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('allow');
    expect(result.receipt.sensitivity_class).toBe('S2');
    expect(result.receipt.operator_waived_s2).toBe(true);
  });
});

describe('Sensitivity-Gate (S12) — the S3 HARD FLOOR (core of the brick)', () => {
  it('S3 (secret) + toggle OFF → STILL redacted + s3_hard_floor_enforced (THE core test)', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: SECRET_S3,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('redact'); // NOT allowed — the floor survives the toggle
    expect(result.receipt.sensitivity_class).toBe('S3');
    expect(result.receipt.s3_hard_floor_enforced).toBe(true);
    expect(result.allowedText).toContain('[REDACTED_SECRET]');
    expect(result.allowedText).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(result.receipt)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('S3 (financial IBAN) + toggle OFF → STILL redacted + hard floor', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: IBAN_S3,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S3');
    expect(result.receipt.s3_hard_floor_enforced).toBe(true);
    expect(result.allowedText).toContain('[REDACTED_IBAN]');
    expect(result.allowedText).not.toContain('0532');
  });

  it('S3 (health) + toggle OFF → STILL redacted + hard floor', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: HEALTH_S3,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S3');
    expect(result.receipt.s3_hard_floor_enforced).toBe(true);
    expect(result.allowedText).toContain('[REDACTED_HEALTH_ID]');
    expect(result.allowedText).not.toContain('A123456789');
  });

  it('S3 + toggle OFF: S3 redacted but co-occurring S1/S2 are WAIVED (selective redaction)', async () => {
    const mixed = `${SECRET_S3} — und ${EMAIL_S1} und ${ADDRESS_S2}`;
    const result = await evaluateCommandEveEgressBoundary({
      text: mixed,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S3');
    // S3 stripped:
    expect(result.allowedText).toContain('[REDACTED_SECRET]');
    expect(result.allowedText).not.toContain('abcdefghijklmnopqrstuvwxyz');
    // S1/S2 waived (present, unredacted) — the operator's responsibility:
    expect(result.allowedText).toContain('mathias@example.com');
    expect(result.allowedText).toContain('Hauptstraße 12');
    expect(result.receipt.s3_hard_floor_enforced).toBe(true);
    expect(result.receipt.operator_waived_s1).toBe(true);
    expect(result.receipt.operator_waived_s2).toBe(true);
  });

  it('S3 + toggle ON → redacted (no hard-floor flag: the toggle already redacts)', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: SECRET_S3,
      provider: CLOUD_PROVIDER,
      toggleMode: 'on',
    });
    expect(result.decision).toBe('redact');
    expect(result.receipt.sensitivity_class).toBe('S3');
    // The flag is specifically "protected DESPITE the operator turning it off".
    expect(result.receipt.s3_hard_floor_enforced).toBeUndefined();
    expect(result.allowedText).toContain('[REDACTED_SECRET]');
  });

  it('S3 unredactable (strict policyAction:block) → block + blocked_s3', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: SECRET_S3,
      provider: CLOUD_PROVIDER,
      toggleMode: 'off',
      policyAction: 'block',
    });
    expect(result.decision).toBe('block');
    expect(result.receipt.sensitivity_class).toBe('S3');
    expect(result.receipt.blocked_s3).toBe(true);
    expect(result.receipt.s3_hard_floor_enforced).toBe(true);
  });

  it('S3_HARD_FLOOR ships true (the DSGVO-safe default)', () => {
    expect(S3_HARD_FLOOR).toBe(true);
  });
});

describe('Sensitivity-Gate (S12) — receipt carries sensitivity_class', () => {
  it('stamps the max class on every class-aware receipt', async () => {
    const cases: Array<[string, string]> = [
      [EMAIL_S1, 'S1'],
      [ADDRESS_S2, 'S2'],
      [SECRET_S3, 'S3'],
    ];
    for (const [text, expected] of cases) {
      const result = await evaluateCommandEveEgressBoundary({
        text,
        provider: CLOUD_PROVIDER,
        toggleMode: 'on',
      });
      expect(result.receipt.sensitivity_class).toBe(expected);
    }
  });
});

describe('Sensitivity-Gate (S12) — BACKWARD COMPAT regression guard', () => {
  it('NO toggle context → byte-identical to legacy (redact all, no class fields)', async () => {
    // With a secret + email + address and NO toggleMode, the legacy path must
    // redact EVERYTHING and emit NONE of the S12 receipt fields.
    const mixed = `${SECRET_S3} — und ${EMAIL_S1} und ${ADDRESS_S2}`;
    const result = await evaluateCommandEveEgressBoundary({
      text: mixed,
      provider: CLOUD_PROVIDER,
      // no toggleMode
    });
    expect(result.decision).toBe('redact');
    // Everything redacted (legacy behaviour):
    expect(result.allowedText).toContain('[REDACTED_SECRET]');
    expect(result.allowedText).toContain('[REDACTED_EMAIL]');
    expect(result.allowedText).toContain('[REDACTED_ADDRESS]');
    expect(result.allowedText).not.toContain('mathias@example.com');
    expect(result.allowedText).not.toContain('Hauptstraße 12');
    // NONE of the S12 receipt fields present on the legacy path:
    expect(result.receipt.sensitivity_class).toBeUndefined();
    expect(result.receipt.s3_hard_floor_enforced).toBeUndefined();
    expect(result.receipt.operator_waived_s1).toBeUndefined();
    expect(result.receipt.operator_waived_s2).toBeUndefined();
    expect(result.receipt.blocked_s3).toBeUndefined();
    // Legacy reason string preserved:
    expect(result.receipt.reason).toBe('sensitive-egress-redact');
  });

  it('NO toggle context + clean text → allow, legacy reason, no class fields', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: 'Bitte erstelle einen Plan.',
      provider: CLOUD_PROVIDER,
    });
    expect(result.decision).toBe('allow');
    expect(result.receipt.reason).toBe('no-sensitive-egress-detected');
    expect(result.receipt.sensitivity_class).toBeUndefined();
  });

  it('NO toggle context + policyAction:block → legacy hard block, no blocked_s3 flag', async () => {
    const result = await evaluateCommandEveEgressBoundary({
      text: SECRET_S3,
      provider: CLOUD_PROVIDER,
      policyAction: 'block',
    });
    expect(result.decision).toBe('block');
    expect(result.receipt.blocked_s3).toBeUndefined();
    expect(result.receipt.sensitivity_class).toBeUndefined();
  });
});
