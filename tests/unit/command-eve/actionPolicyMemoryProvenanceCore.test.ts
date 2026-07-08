/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  decideLocalActionPolicy,
  explainMemoryProvenance,
  resolveMemoryFact,
  type MemoryFact,
} from '@/process/commandEve/actionPolicyMemoryProvenanceCore';

describe('Command EVE action policy and memory provenance core', () => {
  it('blocks local actions until the local tool smoke is active', () => {
    expect(
      decideLocalActionPolicy({
        action: 'browser.open',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: false,
        targetUrl: 'https://example.com',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.smoke-not-active',
      humanGate: 'HG-1',
    });
  });

  it('allows browser reads only after smoke, consent, and host allowlist pass', () => {
    expect(
      decideLocalActionPolicy({
        action: 'browser.read',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://sub.example.com/page',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
      receipt: { host: 'sub.example.com' },
    });

    expect(
      decideLocalActionPolicy({
        action: 'browser.read',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: false,
        smokeActive: true,
        targetUrl: 'https://example.com/page',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.consent-required',
      humanGate: 'HG-2',
    });

    expect(
      decideLocalActionPolicy({
        action: 'browser.read',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://evil.test/page',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.host-blocked',
      humanGate: 'HG-2',
    });
  });

  it('applies the host allowlist to browser open and browser-rendered computer actions', () => {
    expect(
      decideLocalActionPolicy({
        action: 'browser.open',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://example.com/start',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
    });

    expect(
      decideLocalActionPolicy({
        action: 'computer.click',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetSurface: 'browser',
        targetUrl: 'https://evil.test/button',
        allowedHosts: ['example.com'],
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.host-blocked',
      humanGate: 'HG-2',
    });

    expect(
      decideLocalActionPolicy({
        action: 'computer.click',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetSurface: 'desktop',
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
    });
  });

  it('blocks browser credential fill unless a scoped credential mode is confirmed', () => {
    expect(
      decideLocalActionPolicy({
        action: 'browser.form_fill',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S2-confidential',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://login.example.com',
        allowedHosts: ['example.com'],
        credentialMode: 'forbidden',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.credential-blocked',
      humanGate: 'HG-3',
    });

    expect(
      decideLocalActionPolicy({
        action: 'browser.form_fill',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S2-confidential',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://login.example.com',
        allowedHosts: ['example.com'],
        credentialMode: 'vault_scoped',
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
      receipt: { credentialMode: 'vault_scoped' },
    });
  });

  it('blocks computer clicks that touch credential fields without scoped credential consent', () => {
    expect(
      decideLocalActionPolicy({
        action: 'computer.click',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S2-confidential',
        userConsent: true,
        smokeActive: true,
        targetSurface: 'browser',
        targetUrl: 'https://login.example.com',
        allowedHosts: ['example.com'],
        touchesCredentialField: true,
        credentialMode: 'forbidden',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.credential-blocked',
      humanGate: 'HG-3',
    });

    expect(
      decideLocalActionPolicy({
        action: 'computer.click',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S2-confidential',
        userConsent: true,
        smokeActive: true,
        targetSurface: 'browser',
        targetUrl: 'https://login.example.com',
        allowedHosts: ['example.com'],
        touchesCredentialField: true,
        credentialMode: 'user_confirmed',
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
    });
  });

  it('keeps downloads inside approved directories', () => {
    expect(
      decideLocalActionPolicy({
        action: 'download.write',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://files.example.com/report.pdf',
        allowedHosts: ['files.example.com'],
        downloadPath: '/Users/mathias/Downloads/eve/report.pdf',
        allowedDownloadDirs: ['/Users/mathias/Downloads/eve'],
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'local-action.pass',
    });

    expect(
      decideLocalActionPolicy({
        action: 'download.write',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S1-internal-low',
        userConsent: true,
        smokeActive: true,
        targetUrl: 'https://files.example.com/report.pdf',
        allowedHosts: ['files.example.com'],
        downloadPath: '/Users/mathias/.ssh/id_rsa',
        allowedDownloadDirs: ['/Users/mathias/Downloads/eve'],
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.download-path-blocked',
      humanGate: 'HG-2',
    });
  });

  it('blocks restricted screenshots through an explicit human gate', () => {
    expect(
      decideLocalActionPolicy({
        action: 'computer.screenshot',
        privacyMode: 'cloud_balanced',
        sensitivity: 'S3-restricted',
        userConsent: true,
        smokeActive: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'local-action.screenshot-restricted',
      humanGate: 'HG-3',
    });
  });

  it('resolves memory fact conflicts by source precedence before recency', () => {
    const facts: MemoryFact[] = [
      {
        key: 'offer',
        value: 'old chat offer',
        source: 'chat',
        sourceRef: 'conv-1',
        observedAt: '2026-07-08T10:00:00.000Z',
        confidence: 1,
      },
      {
        key: 'offer',
        value: 'company brain offer',
        source: 'company_brain',
        sourceRef: 'company-brain:offer',
        observedAt: '2026-07-07T10:00:00.000Z',
        confidence: 0.8,
      },
      {
        key: 'offer',
        value: 'newer connector offer',
        source: 'connector',
        sourceRef: 'crm:deal-1',
        observedAt: '2026-07-08T12:00:00.000Z',
        confidence: 1,
      },
    ];

    const resolution = resolveMemoryFact(facts, 'offer');

    expect(resolution).toMatchObject({
      conflictCount: 2,
      reasonCode: 'memory.fact-selected',
      fact: { value: 'company brain offer', source: 'company_brain' },
      provenance: { source: 'company_brain', sourceRef: 'company-brain:offer' },
    });
    expect(explainMemoryProvenance(resolution)).toBe(
      'offer comes from company_brain (company-brain:offer), observed at 2026-07-07T10:00:00.000Z.'
    );
  });

  it('returns an explicit missing provenance response when no fact matches', () => {
    expect(resolveMemoryFact([], 'target')).toEqual({
      conflictCount: 0,
      reasonCode: 'memory.fact-missing',
    });
    expect(explainMemoryProvenance(resolveMemoryFact([], 'target'))).toBe(
      'No memory source is available for this fact.'
    );
  });
});
