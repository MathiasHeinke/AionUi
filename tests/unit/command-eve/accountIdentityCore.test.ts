/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  deriveEmailFallbackName,
  isConfirmedCommandEveProfileName,
  resolveCommandEveDisplayIdentity,
} from '@/process/commandEve/accountIdentityCore';

describe('accountIdentityCore', () => {
  it('never treats an email-local-part guess as a confirmed personal name', () => {
    expect(deriveEmailFallbackName('jane.doe@acme-corp.com')).toBe('Jane Doe');
    expect(
      isConfirmedCommandEveProfileName({
        name: 'Jane Doe',
        email: 'jane.doe@acme-corp.com',
        source: 'email_fallback',
      })
    ).toBe(false);
    expect(
      isConfirmedCommandEveProfileName({
        name: 'Jane Doe',
        email: 'jane.doe@acme-corp.com',
      })
    ).toBe(false);
  });

  it('accepts explicit registration names and profile edits', () => {
    expect(
      isConfirmedCommandEveProfileName({
        name: 'Mathias Heinke',
        email: 'mathias@example.com',
        source: 'explicit',
      })
    ).toBe(true);
  });

  it('prefers confirmed registration over session metadata and omits email guesses', () => {
    expect(
      resolveCommandEveDisplayIdentity({
        registrationName: 'Mathias Heinke',
        registrationNameSource: 'explicit',
        sessionName: 'Other Name',
        email: 'mathias@example.com',
      })
    ).toEqual({ name: 'Mathias Heinke', nameConfirmed: true, source: 'explicit' });

    expect(
      resolveCommandEveDisplayIdentity({
        registrationName: 'Jane Doe',
        registrationNameSource: 'email_fallback',
        sessionName: undefined,
        email: 'jane.doe@acme-corp.com',
      })
    ).toEqual({ nameConfirmed: false });

    expect(
      resolveCommandEveDisplayIdentity({
        registrationName: undefined,
        sessionName: 'From Account Metadata',
        email: 'jane.doe@acme-corp.com',
      })
    ).toEqual({ name: 'From Account Metadata', nameConfirmed: true, source: 'account_metadata' });
  });
});
