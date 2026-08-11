/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type BrowserNeedsUserReason = 'password' | 'mfa' | 'passkey' | 'captcha' | 'risk-challenge';

export interface BrowserAuthSurfaceSnapshot {
  active_type?: string;
  active_autocomplete?: string;
  active_name?: string;
  has_mfa_signal?: boolean;
  has_passkey_signal?: boolean;
  has_captcha_signal?: boolean;
  has_risk_signal?: boolean;
}

export interface BrowserNeedsUserDecision {
  needs_user: true;
  reason: BrowserNeedsUserReason;
}

const PASSWORD_AUTOCOMPLETE = /(?:current-password|new-password)/i;
const MFA_AUTOCOMPLETE = /(?:one-time-code|otp|totp)/i;
const PASSWORD_FIELD = /(?:password|passwd|passcode)/i;
const MFA_FIELD = /(?:otp|totp|2fa|mfa|verification.?code|recovery.?code)/i;

/** Only classifications cross from the guest page; input values never do. */
export function classifyBrowserAuthSurface(snapshot: BrowserAuthSurfaceSnapshot): BrowserNeedsUserDecision | null {
  const type = String(snapshot.active_type ?? '');
  const autocomplete = String(snapshot.active_autocomplete ?? '');
  const name = String(snapshot.active_name ?? '');
  if (snapshot.has_captcha_signal) return { needs_user: true, reason: 'captcha' };
  if (snapshot.has_passkey_signal) return { needs_user: true, reason: 'passkey' };
  if (snapshot.has_risk_signal) return { needs_user: true, reason: 'risk-challenge' };
  if (snapshot.has_mfa_signal || MFA_AUTOCOMPLETE.test(autocomplete) || MFA_FIELD.test(name)) {
    return { needs_user: true, reason: 'mfa' };
  }
  if (type.toLowerCase() === 'password' || PASSWORD_AUTOCOMPLETE.test(autocomplete) || PASSWORD_FIELD.test(name)) {
    return { needs_user: true, reason: 'password' };
  }
  return null;
}

/** Fail closed when an agent script explicitly reaches for credential surfaces. */
export function classifyCredentialScript(value: unknown): BrowserNeedsUserDecision | null {
  if (typeof value !== 'string') return null;
  if (/(?:navigator\.credentials|webauthn|passkey)/i.test(value)) {
    return { needs_user: true, reason: 'passkey' };
  }
  if (/(?:captcha|recaptcha|hcaptcha|turnstile)/i.test(value)) {
    return { needs_user: true, reason: 'captcha' };
  }
  if (/(?:one-time-code|recovery.?code|totp|\botp\b|\b2fa\b|\bmfa\b)/i.test(value)) {
    return { needs_user: true, reason: 'mfa' };
  }
  if (/(?:type\s*=\s*["']password|current-password|new-password|\.password\b)/i.test(value)) {
    return { needs_user: true, reason: 'password' };
  }
  return null;
}

/** Raw browser profile stores may contain login credentials and never leave CDP. */
export function accessesRawBrowserCredentials(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /(?:document\s*\.\s*cookie|\b(?:localStorage|sessionStorage|indexedDB|caches)\b)/i.test(value);
}
