import { describe, expect, it } from 'vitest';

import {
  accessesRawBrowserCredentials,
  classifyBrowserAuthSurface,
  classifyCredentialScript,
  hasBrowserMfaTextSignal,
} from '@/common/config/browserAuthChallengeCore';

describe('browserAuthChallengeCore', () => {
  it.each([
    [{ active_type: 'password' }, 'password'],
    [{ has_password_signal: true }, 'password'],
    [{ active_autocomplete: 'one-time-code' }, 'mfa'],
    [{ has_passkey_signal: true }, 'passkey'],
    [{ has_captcha_signal: true }, 'captcha'],
    [{ has_risk_signal: true }, 'risk-challenge'],
  ] as const)('classifies user-presence surfaces without reading values', (snapshot, reason) => {
    expect(classifyBrowserAuthSurface(snapshot)).toEqual({ needs_user: true, reason });
  });

  it('allows an ordinary text field', () => {
    expect(classifyBrowserAuthSurface({ active_type: 'text', active_name: 'search' })).toBeNull();
    expect(classifyBrowserAuthSurface({ active_type: 'text', active_name: 'hotpot-search' })).toBeNull();
  });

  it('uses token-bounded MFA abbreviations without blocking benign copy', () => {
    expect(hasBrowserMfaTextSignal('Browse the hotpot menu and compare formats.')).toBe(false);
    expect(hasBrowserMfaTextSignal('Enter your OTP to continue.')).toBe(true);
    expect(hasBrowserMfaTextSignal('MFA verification is required.')).toBe(true);
    expect(hasBrowserMfaTextSignal('Use the recovery code.')).toBe(true);
  });

  it.each([
    [`document.querySelector('input[type="password"]').value`, 'password'],
    [`navigator.credentials.get({publicKey: options})`, 'passkey'],
    [`document.querySelector('[autocomplete="one-time-code"]')`, 'mfa'],
    [`document.querySelector('.g-recaptcha')`, 'captcha'],
  ])('fails closed for explicit credential scripts', (script, reason) => {
    expect(classifyCredentialScript(script)).toEqual({ needs_user: true, reason });
  });

  it('recognizes raw browser-profile stores without reading their contents', () => {
    for (const script of [
      'document.cookie',
      'localStorage.getItem("token")',
      'sessionStorage.clear()',
      'indexedDB.databases()',
      'caches.keys()',
    ]) {
      expect(accessesRawBrowserCredentials(script)).toBe(true);
    }
    expect(accessesRawBrowserCredentials('document.querySelector("#profile-status").textContent')).toBe(false);
  });
});
