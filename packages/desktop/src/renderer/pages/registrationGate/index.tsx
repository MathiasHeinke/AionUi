/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE registration + license gate (renderer half, W12).
 *
 * Founder-facing first-run gate that BLOCKS all main surfaces until the user
 * has (1) registered locally (S2 PII, stored only on this machine) and
 * (2) entered a valid CEVE.v1 license code. The block is structural: the gate
 * is rendered in place of the protected layout by the route guard in
 * `components/layout/Router.tsx`, so no route/deep-link/window-reopen can reach
 * a main surface while the gate is required and not entitled.
 *
 * The backend (W11) lives in the main process (`commandEve.entitlement*`
 * bridges). This component only drives the UI flow and reflects the
 * main-process truth — it never decides entitlement on its own.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Input } from '@arco-design/web-react';
import { changeLanguage } from '@renderer/services/i18n';
import { openAccountWeb } from '@renderer/utils/platform';
import {
  commandEve,
  type ICommandEveEntitlementStatusResult,
  type ICommandEveRegistrationRecord,
} from '@/common/adapter/ipcBridge';
import { refreshCommandEveProfile } from '@/renderer/components/account/useCommandEveProfile';
import './RegistrationGatePage.css';
// Bundled (Vite-hashed) cinematic background. A STATIC image = one GPU texture,
// zero animation → zero repaint cost (the prior drifting aurora was the source of
// the jank); the glass panel's backdrop-blur is computed once over a still frame
// and cached. Swap to './assets/gate-bg-alt.jpg' for the liquid-ribbon variant.
import gateBackground from './assets/gate-bg.jpg';
// Seamless FLF morph-loop (A->B->D->A, 12s, OpenRouter Seedance 2.0 Fast). webm
// (vp9, 717K) is preferred; mp4 (h264) is the fallback. The static jpg above stays
// as the deepest poster/fallback if video can't play. Continuous gentle motion.
import gateLoopWebm from './assets/gate-loop.webm';
import gateLoopMp4 from './assets/gate-loop.mp4';
import gateLoopPoster from './assets/gate-loop-poster.jpg';

// 'auth' is the PRIMARY first-run path (web login/register). 'registration' +
// 'license' remain as the SECONDARY manual code-paste fallback flow, reached via
// the "Ich habe einen Code" link or when the web login is not yet available.
type GateStep = 'auth' | 'registration' | 'license';

/**
 * The trial-conversion curtain destination (reached ONLY by a legacy trial
 * license). Gen-B: the operator's OWN seat is 0 € for ever, so the curtain no
 * longer sells a plan — it routes OUT to the web `/account` surface where the
 * user signs in for their free own seat (and can add paid client seats from
 * 99 €). The desktop never holds a card or a checkout form.
 */
// RELATIVE path: openAccountWeb pins the command-eve.com origin AND carries the
// desktop session (refresh token, attached in MAIN) so the operator lands LOGGED
// IN on /account and the checkout can start — not on a logged-out redirect.
const CURTAIN_CHECKOUT_PATH = '/account';

// OAUTH-2 browser web-login: the web /auth/desktop page (the loopback target) is now
// LIVE (command-eve.com/auth/desktop → 200) and the desktop-auth-broker is deployed +
// audited, so the button works end-to-end. SAFETY NET: if the round-trip ever fails,
// handleWebLogin's catch stays on THIS auth step with an inline error (B-6) — it never
// dumps the user into the old register->paste fallback. The in-app email/password
// login on the same screen remains an equal primary path.
const BROWSER_LOGIN_ENABLED = true;

/**
 * True only for the day-14 TRIAL-EXPIRED state: the gate reports `expired` AND
 * the (now-mirrored) CEVE.v2 `trial_ends_at` field is a non-null string, which
 * the main-process core sets ONLY for a trial entitlement. A paid-license expiry
 * (or any v1 code) leaves `trial_ends_at` null/absent and stays on the normal
 * license path — the curtain is a warm "continue", NOT the generic-expired error.
 *
 * This is a pure read of the main-process status; the renderer makes no
 * entitlement decision and cannot unlock anything (the structural route guard in
 * Router.tsx keeps every main surface blocked while `state !== 'entitled'`).
 */
function isTrialExpired(status: ICommandEveEntitlementStatusResult | null): boolean {
  return status?.state === 'expired' && typeof status.trial_ends_at === 'string' && status.trial_ends_at.length > 0;
}

const SUPPORTED_LANGUAGES: Array<{ code: string; short: string; flag: string; label: string }> = [
  { code: 'de-DE', short: 'DE', flag: '🇩🇪', label: 'Deutsch' },
  { code: 'en-US', short: 'EN', flag: '🇬🇧', label: 'English' },
];

// License-verify reason codes that map to a specific, distinct error string.
const KNOWN_LICENSE_REASON_CODES = new Set([
  'LICENSE_MALFORMED',
  'LICENSE_VERSION_UNSUPPORTED',
  'LICENSE_SIGNATURE_INVALID',
  'LICENSE_EXPIRED',
  'LICENSE_NOT_YET_VALID',
  'LICENSE_KEY_UNCONFIGURED',
  'REGISTRATION_REQUIRED',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Unbiased crypto random in [0, maxExclusive) via rejection sampling (modulo alone
// skews toward the low glyphs since 2^32 is not a multiple of the set size).
function randomInt(maxExclusive: number): number {
  const cryptoObj = globalThis.crypto ?? (window as Window & { crypto: Crypto }).crypto;
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    cryptoObj.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % maxExclusive;
}

// Electron is Chromium, NOT WebKit, so the native macOS "Strong Password" suggestion
// (a Safari-only popover) never appears here regardless of markup. We still set the
// correct autocomplete semantics (new-password on register) so external managers can
// help, AND offer this deterministic in-app generator so a strong password is one click
// away with no dependency on any OS/manager. Excludes look-alike glyphs. GUARANTEES one
// char from each class (upper/lower/digit/special) then crypto-shuffles, so a server
// policy that requires a digit/symbol can NEVER reject the app's own one-click password.
function generateStrongPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%^&*-_=+';
  const all = upper + lower + digit + special;
  const length = 18;
  const chars: string[] = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digit[randomInt(digit.length)],
    special[randomInt(special.length)],
  ];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  // Fisher–Yates so the four guaranteed glyphs are not always the first four.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export interface RegistrationGatePageProps {
  /** Latest entitlement status from the main process (drives initial step). */
  status: ICommandEveEntitlementStatusResult | null;
  /** Re-read the main-process status (caller flips the gate off when entitled). */
  onEntitled: () => void | Promise<void>;
}

const RegistrationGatePage: React.FC<RegistrationGatePageProps> = ({ status, onEntitled }) => {
  const notifyEntitled = React.useCallback(async () => {
    // Shared chrome must learn the new identity in the same session (no restart).
    await refreshCommandEveProfile();
    await onEntitled();
  }, [onEntitled]);
  const { t, i18n } = useTranslation();

  // The day-14 trial curtain takes over the whole gate: it is NOT a step in the
  // registration→license flow but a distinct conversion screen (warm "continue",
  // not the generic-expired error). It only shows when the main process reports a
  // TRIAL that has expired (see `isTrialExpired`).
  const trialExpired = isTrialExpired(status);

  // When the user is already registered (e.g. relaunch with registration but no
  // license, or a now-expired PAID license) jump straight to the license step.
  // Otherwise the PRIMARY first-run path is the web-login 'auth' step. A trial
  // expiry is handled by the curtain above, not this step.
  // Login-first is the default landing. A merely-stale local registration with no
  // license (state 'registered_unlicensed' — e.g. a machine that ran a prior alpha
  // and still has ~/.command-eve/registration.json) must NOT skip the login screen
  // onto the old Lizenzcode paste box (the founder's bug). Only a genuinely EXPIRED
  // *paid* license starts on the manual license step; a trial expiry is taken over
  // by the curtain (trialExpired) and everyone else → 'auth'. A code-holder reaches
  // the paste box via the "Ich habe einen Lizenzcode" link.
  const initialStep: GateStep = !trialExpired && status?.state === 'expired' ? 'license' : 'auth';
  const [step, setStep] = useState<GateStep>(initialStep);

  // Auth state. authBusy/authError are shared by the in-app password flow and the
  // browser-loopback flow; pendingIntent tracks which password action is running so
  // only that button shows a spinner.
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [pendingIntent, setPendingIntent] = useState<'login' | 'register' | null>(null);
  // LOGIN vs REGISTER are now explicit modes, not two competing buttons on one screen.
  // The mode drives the primary button label/action AND the password field semantics
  // (current-password ⇒ fill an existing one; new-password ⇒ offer/generate a new one).
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  // Browser-mediated PKCE is the safe, effortless default. Direct credentials stay
  // available as an explicit fallback, but are no longer the first thing a new user
  // sees after already registering on command-eve.com.
  const [showPasswordFallback, setShowPasswordFallback] = useState(!BROWSER_LOGIN_ENABLED);
  const switchAuthMode = useCallback((next: 'login' | 'register') => {
    setAuthMode(next);
    setAuthError(null);
  }, []);
  const handleSuggestPassword = useCallback(() => {
    const generated = generateStrongPassword();
    setAuthPassword(generated);
    setPasswordRevealed(true);
  }, []);
  // Reveal toggle is OWNED here (not Arco-internal) so "suggest password" can force the
  // freshly generated value visible — the user must be able to see/save it.
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const handleWebLogin = useCallback(
    async (intent: 'login' | 'register') => {
      setAuthError(null);
      setPendingIntent(null);
      setAuthBusy(true);
      try {
        const response = await commandEve.authWebLogin.invoke({ intent });
        const data = response.data;
        if (data?.ok && data.entitled) {
          // Gate host re-reads the main-process status and unmounts the gate.
          await notifyEntitled();
          return;
        }
        // Login completed but no license yet (PENDING) OR the web page / broker
        // is not live yet ⇒ fall back to the manual code-paste flow. If we have a
        // local registration already, jump straight to the license step.
        if (data?.needs_paste) {
          // B-6: stay on the auth step (no forced registration/paste jump) — the
          // trial is being provisioned server-side; the user retries in place.
          const knownKey = `registrationGate.auth.errors.${data.reason_code}`;
          const translated = data.reason_code ? t(knownKey) : '';
          setAuthError(translated && translated !== knownKey ? translated : t('registrationGate.auth.licensePending'));
          return;
        }
        setAuthError(t('registrationGate.auth.errors.unknown'));
      } catch (error) {
        // B-6: a browser-login failure (e.g. OAUTH-2's web /auth/desktop page is not
        // live yet) must NOT dump the user into the manual register->paste fallback —
        // that looks like the old offline flow. Stay on the auth step with an inline
        // error; the in-app email/password login on this same screen still works.
        console.error('Web login bridge call failed:', error);
        setAuthError(t('registrationGate.auth.errors.unknown'));
      } finally {
        setAuthBusy(false);
      }
    },
    [notifyEntitled, t]
  );

  // Map a main-process reason_code to a localized, account-existence-safe message.
  // Works for any code (login/register GoTrue codes or the bridge's own), falling
  // back to the generic 'unknown' string when there is no specific translation.
  const resolveAuthError = useCallback(
    (reasonCode?: string): string => {
      if (reasonCode) {
        const key = `registrationGate.auth.errors.${reasonCode}`;
        const translated = t(key);
        if (translated && translated !== key) return translated;
      }
      return t('registrationGate.auth.errors.unknown');
    },
    [t]
  );

  // In-app email/password sign-in (founder HG-4). Credentials go to MAIN once via
  // the bridge; the renderer never holds tokens. A grant failure shows an inline
  // error and STAYS on the auth step (retry in place); a session-ok-but-license-
  // pending result routes to the code-paste step. NEVER logs the credentials.
  const handlePasswordAuth = useCallback(
    async (intent: 'login' | 'register') => {
      setAuthError(null);
      const email = authEmail.trim();
      const password = authPassword;
      if (!email || !password) {
        setAuthError(t('registrationGate.auth.errors.fieldsRequired'));
        return;
      }
      setPendingIntent(intent);
      setAuthBusy(true);
      try {
        const response = await commandEve.authPasswordLogin.invoke({ intent, email, password });
        const data = response.data;
        if (data?.ok && data.entitled) {
          await notifyEntitled();
          return;
        }
        if (data?.needs_paste) {
          // B-6: a fresh trial signup has NO code to paste — the account + trial
          // exist server-side but my-license hasn't surfaced the code yet (rare:
          // the orchestrator already backed off ~7.5s internally). STAY on the
          // auth step with a "being set up" hint so the user simply retries
          // "Anmelden" in place; do NOT dump them into a code-paste box they
          // cannot satisfy. The "Ich habe einen Code" link below remains for the
          // rare emailed-code case.
          setAuthError(t('registrationGate.auth.licensePending'));
          return;
        }
        // Funnel choice (Option A): "Confirm email" is OFF in Supabase Auth, so a
        // register normally returns a session and never lands here. If it ever does
        // (toggle re-enabled, or flipped after this build), the account now EXISTS —
        // flip the form to LOGIN so the user's next action ("Anmelden") just works.
        if (data?.reason_code === 'EMAIL_CONFIRMATION_REQUIRED') {
          setAuthMode('login');
        }
        setAuthError(resolveAuthError(data?.reason_code));
      } catch (error) {
        console.error('Password auth bridge call failed:', error);
        setAuthError(t('registrationGate.auth.errors.unknown'));
      } finally {
        setAuthBusy(false);
        setPendingIntent(null);
      }
    },
    [authEmail, authPassword, notifyEntitled, resolveAuthError, t]
  );

  // Opening the web checkout is a deliberate, low-risk action — it never touches
  // local data. Setup (memory, connections, SOPs) is preserved by definition:
  // the curtain does no reset/wipe, and the structural gate keeps the existing
  // local entitlement/registration records untouched on disk.
  const [curtainOpening, setCurtainOpening] = useState(false);
  const handleContinueToCheckout = useCallback(async () => {
    setCurtainOpening(true);
    try {
      await openAccountWeb(CURTAIN_CHECKOUT_PATH);
    } catch (error) {
      console.error('Failed to open conversion checkout:', error);
    } finally {
      setCurtainOpening(false);
    }
  }, []);

  // Registration form state.
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationSubmitting, setRegistrationSubmitting] = useState(false);
  const [registrationRecord, setRegistrationRecord] = useState<ICommandEveRegistrationRecord | null>(null);

  // License form state.
  const [code, setCode] = useState('');
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseSubmitting, setLicenseSubmitting] = useState(false);
  const [licenseSuccess, setLicenseSuccess] = useState(false);

  const isUnconfigured = status?.state === 'unconfigured';
  const hasLocalRegistration =
    registrationRecord !== null || status?.state === 'registered_unlicensed' || status?.state === 'expired';

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  const handleLanguageChange = useCallback((next: string) => {
    changeLanguage(next).catch((error: Error) => {
      console.error('Failed to change language:', error);
    });
  }, []);

  const resolveLicenseError = useCallback(
    (reasonCode?: string): string => {
      if (reasonCode && KNOWN_LICENSE_REASON_CODES.has(reasonCode)) {
        return t(`registrationGate.license.errors.${reasonCode}`);
      }
      return t('registrationGate.license.errors.unknown');
    },
    [t]
  );

  const handleRegister = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setRegistrationError(null);

      const trimmedName = name.trim();
      const trimmedCompany = company.trim();
      const trimmedEmail = email.trim();

      // Client-side validation mirrors the main-process reason codes so the user
      // gets an immediate, specific message; the main process re-validates.
      if (!consent) {
        setRegistrationError(t('registrationGate.registration.errors.consentRequired'));
        return;
      }
      if (!trimmedName || !trimmedCompany || !trimmedEmail) {
        setRegistrationError(t('registrationGate.registration.errors.fieldsRequired'));
        return;
      }
      if (!EMAIL_PATTERN.test(trimmedEmail)) {
        setRegistrationError(t('registrationGate.registration.errors.emailInvalid'));
        return;
      }

      setRegistrationSubmitting(true);
      try {
        const response = await commandEve.entitlementRegister.invoke({
          name: trimmedName,
          company: trimmedCompany,
          email: trimmedEmail,
          consent,
        });
        const data = response.data;
        if (data?.ok && data.record) {
          setRegistrationRecord(data.record);
          setStep('license');
          return;
        }
        switch (data?.reason_code) {
          case 'CONSENT_REQUIRED':
            setRegistrationError(t('registrationGate.registration.errors.consentRequired'));
            break;
          case 'REGISTRATION_EMAIL_INVALID':
            setRegistrationError(t('registrationGate.registration.errors.emailInvalid'));
            break;
          case 'REGISTRATION_FIELDS_REQUIRED':
            setRegistrationError(t('registrationGate.registration.errors.fieldsRequired'));
            break;
          default:
            setRegistrationError(t('registrationGate.registration.errors.unknown'));
        }
      } catch (error) {
        console.error('Registration bridge call failed:', error);
        setRegistrationError(t('registrationGate.registration.errors.unknown'));
      } finally {
        setRegistrationSubmitting(false);
      }
    },
    [company, consent, email, name, t]
  );

  const handleActivate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setLicenseError(null);

      // A CEVE.v1 license is bound to the local registration record by the main
      // process. Keep that security contract explicit: the rare code-only path
      // first asks for the existing local setup, then activates. Never submit a
      // request that is guaranteed to fail with REGISTRATION_REQUIRED.
      if (!hasLocalRegistration) {
        setLicenseError(t('registrationGate.license.errors.REGISTRATION_REQUIRED'));
        return;
      }

      const trimmedCode = code.trim();
      if (!trimmedCode) {
        setLicenseError(t('registrationGate.license.errors.empty'));
        return;
      }

      setLicenseSubmitting(true);
      try {
        const response = await commandEve.entitlementActivate.invoke({ code: trimmedCode });
        const data = response.data;
        if (data?.ok) {
          setLicenseSuccess(true);
          // Hand control back to the gate host, which re-reads the main-process
          // status and unmounts the gate once it reports 'entitled'.
          await notifyEntitled();
          return;
        }
        setLicenseError(resolveLicenseError(data?.reason_code));
      } catch (error) {
        console.error('Activation bridge call failed:', error);
        setLicenseError(t('registrationGate.license.errors.unknown'));
      } finally {
        setLicenseSubmitting(false);
      }
    },
    [code, hasLocalRegistration, notifyEntitled, resolveLicenseError, t]
  );

  const registeredAsLabel = useMemo(() => {
    const displayName = registrationRecord?.name || name.trim();
    const displayCompany = registrationRecord?.company || company.trim();
    if (!displayName && !displayCompany) return null;
    return t('registrationGate.license.registeredAs', { name: displayName, company: displayCompany });
  }, [company, name, registrationRecord, t]);

  // Static cinematic backdrop behind the frosted-glass card (set via a bundled,
  // hashed asset URL so it resolves under file:// in the packaged build). Rendered
  // in BOTH gate branches (normal + day-14 curtain) so the look never drops out.
  const backgroundLayer = (
    <div className='registration-gate__bg' style={{ backgroundImage: `url(${gateBackground})` }} aria-hidden='true'>
      <video
        className='registration-gate__bg-video'
        autoPlay
        muted
        loop
        playsInline
        preload='auto'
        poster={gateLoopPoster}
        tabIndex={-1}
      >
        <source src={gateLoopWebm} type='video/webm' />
        <source src={gateLoopMp4} type='video/mp4' />
      </video>
    </div>
  );

  const languageToggle = (
    <div className='registration-gate__lang-toggle' role='group' aria-label={t('registrationGate.languageToggle')}>
      {SUPPORTED_LANGUAGES.map((lang) => {
        const active = i18n.language === lang.code || i18n.resolvedLanguage === lang.code;
        return (
          <button
            key={lang.code}
            type='button'
            className={`registration-gate__lang-option ${active ? 'registration-gate__lang-option--active' : ''}`}
            onClick={() => handleLanguageChange(lang.code)}
            aria-pressed={active}
            aria-label={lang.label}
            data-testid={`registration-gate-lang-${lang.short.toLowerCase()}`}
          >
            <span aria-hidden='true'>{lang.flag}</span>
            <span>{lang.short}</span>
          </button>
        );
      })}
    </div>
  );

  // ---- Day-14 trial-conversion CURTAIN -----------------------------------
  // A warm "welcome back, continue" conversion screen that REPLACES the gate
  // flow when a trial has expired. It is intentionally distinct from the hard
  // license-error states: it leads with the value the user already built (their
  // Company OS, memory, connections, SOPs are PRESERVED and waiting) and offers a
  // single primary CTA out to the web /account (free own seat; client seats from
  // 99 €). It wipes nothing and
  // cannot itself unlock the app — the structural route guard keeps every main
  // surface blocked until the entitlement flips to `entitled` (after the user
  // converts on the web and re-activates / the gate re-reads).
  if (trialExpired) {
    return (
      <div className='registration-gate' data-testid='registration-gate'>
        {backgroundLayer}
        <div
          className='registration-gate__card registration-gate__card--curtain'
          data-testid='registration-gate-curtain'
        >
          {languageToggle}

          <div className='registration-gate__header'>
            <h1 className='registration-gate__title'>
              <span className='registration-gate__title-command' aria-hidden='true'>
                ⌘
              </span>
              <span>{t('registrationGate.brand')}</span>
            </h1>
            <p className='registration-gate__subtitle'>{t('registrationGate.curtain.title')}</p>
          </div>

          <div className='registration-gate__form'>
            <p className='registration-gate__curtain-lede'>{t('registrationGate.curtain.lede')}</p>

            <div className='registration-gate__curtain-preserved' data-testid='registration-gate-curtain-preserved'>
              <p className='registration-gate__curtain-preserved-title'>
                {t('registrationGate.curtain.preservedTitle')}
              </p>
              <p className='registration-gate__curtain-preserved-body'>{t('registrationGate.curtain.preservedBody')}</p>
            </div>

            <p className='registration-gate__curtain-price'>{t('registrationGate.curtain.price')}</p>

            <Button
              type='primary'
              long
              shape='round'
              loading={curtainOpening}
              onClick={handleContinueToCheckout}
              data-testid='registration-gate-curtain-continue'
            >
              {t('registrationGate.curtain.continue')}
            </Button>

            <span className='registration-gate__hint'>{t('registrationGate.curtain.hint')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='registration-gate' data-testid='registration-gate'>
      {backgroundLayer}
      <div className='registration-gate__card'>
        {languageToggle}

        <div className='registration-gate__header'>
          <h1 className='registration-gate__title'>
            <span className='registration-gate__title-command' aria-hidden='true'>
              ⌘
            </span>
            <span>{t('registrationGate.brand')}</span>
          </h1>
          <p className='registration-gate__subtitle'>
            {isUnconfigured
              ? t('registrationGate.unconfigured.title')
              : step === 'auth'
                ? t('registrationGate.auth.title')
                : step === 'registration'
                  ? t('registrationGate.registration.title')
                  : t('registrationGate.license.title')}
          </p>
        </div>

        {!isUnconfigured && step !== 'auth' ? (
          <div className='registration-gate__steps' aria-hidden='true'>
            <span
              className={`registration-gate__step ${step === 'registration' ? 'registration-gate__step--active' : ''}`}
            >
              <span className='registration-gate__step-dot'>1</span>
              {t('registrationGate.steps.registration')}
            </span>
            <span className='registration-gate__step-sep' />
            <span className={`registration-gate__step ${step === 'license' ? 'registration-gate__step--active' : ''}`}>
              <span className='registration-gate__step-dot'>2</span>
              {t('registrationGate.steps.license')}
            </span>
          </div>
        ) : null}

        {isUnconfigured ? (
          <div className='registration-gate__form' data-testid='registration-gate-unconfigured'>
            <p className='registration-gate__subtitle'>{t('registrationGate.unconfigured.description')}</p>
            <p className='registration-gate__hint'>{t('registrationGate.unconfigured.fallbackHint')}</p>
          </div>
        ) : step === 'auth' ? (
          <form
            className='registration-gate__form'
            data-testid='registration-gate-auth'
            onSubmit={(event) => {
              event.preventDefault();
              if (showPasswordFallback || !BROWSER_LOGIN_ENABLED) {
                void handlePasswordAuth(authMode);
                return;
              }
              // Enter on the browser-first screen follows the visible primary
              // action; it must never surface a phantom "email required" error
              // while those credential fields are intentionally collapsed.
              void handleWebLogin(authMode);
            }}
          >
            {/* Explicit LOGIN / REGISTER mode toggle. The single primary action below
                ALWAYS matches the selected mode — no more "Anmelden" button shown while
                the user is trying to register. */}
            <div
              className='registration-gate__authmode'
              role='tablist'
              aria-label={t('registrationGate.auth.modeToggle')}
            >
              <button
                type='button'
                role='tab'
                aria-selected={authMode === 'login'}
                className={`registration-gate__authmode-tab ${authMode === 'login' ? 'registration-gate__authmode-tab--active' : ''}`}
                onClick={() => switchAuthMode('login')}
                disabled={authBusy}
                data-testid='registration-gate-mode-login'
              >
                {t('registrationGate.auth.login')}
              </button>
              <button
                type='button'
                role='tab'
                aria-selected={authMode === 'register'}
                className={`registration-gate__authmode-tab ${authMode === 'register' ? 'registration-gate__authmode-tab--active' : ''}`}
                onClick={() => switchAuthMode('register')}
                disabled={authBusy}
                data-testid='registration-gate-mode-register'
              >
                {t('registrationGate.auth.register')}
              </button>
            </div>

            <p className='registration-gate__subtitle'>
              {authMode === 'login'
                ? t('registrationGate.auth.loginSubtitle')
                : t('registrationGate.auth.registerSubtitle')}
            </p>

            {BROWSER_LOGIN_ENABLED ? (
              <Button
                type='primary'
                htmlType='button'
                long
                shape='round'
                className='registration-gate__browser-primary'
                loading={authBusy && pendingIntent === null}
                disabled={authBusy}
                onClick={() => void handleWebLogin(authMode)}
                data-testid='registration-gate-browser-login'
              >
                {authBusy && pendingIntent === null
                  ? authMode === 'login'
                    ? t('registrationGate.auth.browserLoginOpening')
                    : t('registrationGate.auth.browserRegisterOpening')
                  : authMode === 'login'
                    ? t('registrationGate.auth.browserLogin')
                    : t('registrationGate.auth.browserRegister')}
              </Button>
            ) : null}

            {BROWSER_LOGIN_ENABLED ? (
              <p className='registration-gate__browser-hint'>{t('registrationGate.auth.browserSessionHint')}</p>
            ) : null}

            {authError ? (
              <span className='registration-gate__error' role='alert' data-testid='registration-gate-auth-error'>
                {authError}
              </span>
            ) : null}

            {BROWSER_LOGIN_ENABLED ? (
              <button
                type='button'
                className='registration-gate__password-fallback-toggle'
                aria-expanded={showPasswordFallback}
                aria-controls='registration-gate-password-fallback'
                onClick={() => setShowPasswordFallback((visible) => !visible)}
                disabled={authBusy}
                data-testid='registration-gate-password-fallback-toggle'
              >
                {authMode === 'login'
                  ? t('registrationGate.auth.passwordFallbackLogin')
                  : t('registrationGate.auth.passwordFallbackRegister')}
              </button>
            ) : null}

            {showPasswordFallback ? (
              <div
                id='registration-gate-password-fallback'
                className='registration-gate__password-fallback'
                data-testid='registration-gate-password-fallback'
              >
                <div className='registration-gate__field'>
                  <label className='registration-gate__label' htmlFor='registration-gate-email'>
                    {t('registrationGate.auth.emailLabel')}
                  </label>
                  <Input
                    id='registration-gate-email'
                    type='email'
                    name='username'
                    value={authEmail}
                    onChange={(value) => setAuthEmail(value)}
                    placeholder={t('registrationGate.auth.emailPlaceholder')}
                    data-testid='registration-gate-email'
                    disabled={authBusy}
                    autoComplete='username'
                    autoFocus
                  />
                </div>

                <div className='registration-gate__field'>
                  <label className='registration-gate__label' htmlFor='registration-gate-password'>
                    {t('registrationGate.auth.passwordLabel')}
                  </label>
                  {/* key=authMode ⇒ password managers distinguish filling an existing
                      credential from suggesting a new one. The native edit context menu
                      provides Cut/Copy/Paste without exposing clipboard contents to EVE. */}
                  <Input.Password
                    key={authMode}
                    id='registration-gate-password'
                    name={authMode === 'register' ? 'new-password' : 'current-password'}
                    value={authPassword}
                    onChange={(value) => setAuthPassword(value)}
                    placeholder={t('registrationGate.auth.passwordPlaceholder')}
                    data-testid='registration-gate-password'
                    disabled={authBusy}
                    autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                    visibility={passwordRevealed}
                    onVisibilityChange={setPasswordRevealed}
                  />
                  {authMode === 'register' ? (
                    <button
                      type='button'
                      className='registration-gate__suggest-pw'
                      onClick={handleSuggestPassword}
                      disabled={authBusy}
                      data-testid='registration-gate-suggest-password'
                    >
                      {t('registrationGate.auth.suggestPassword')}
                    </button>
                  ) : null}
                </div>

                <Button
                  type='secondary'
                  htmlType='submit'
                  long
                  shape='round'
                  loading={authBusy && pendingIntent === authMode}
                  disabled={authBusy}
                  data-testid={authMode === 'login' ? 'registration-gate-login' : 'registration-gate-register'}
                >
                  {authMode === 'login'
                    ? authBusy && pendingIntent === 'login'
                      ? t('registrationGate.auth.loggingIn')
                      : t('registrationGate.auth.login')
                    : authBusy && pendingIntent === 'register'
                      ? t('registrationGate.auth.registering')
                      : t('registrationGate.auth.register')}
                </Button>
              </div>
            ) : null}

            <button
              type='button'
              className='registration-gate__back'
              onClick={() => {
                setAuthError(null);
                // Keep browser-auth primary. A user who deliberately chooses the
                // optional code path sees the code first; if this Mac has no local
                // binding yet, that screen offers one explicit setup action.
                setStep('license');
              }}
              disabled={authBusy}
              data-testid='registration-gate-have-code'
            >
              {t('registrationGate.auth.haveCode')}
            </button>
          </form>
        ) : step === 'registration' ? (
          <form className='registration-gate__form' onSubmit={handleRegister} data-testid='registration-gate-form'>
            <p className='registration-gate__subtitle'>{t('registrationGate.registration.subtitle')}</p>

            <div className='registration-gate__field'>
              <label className='registration-gate__label' htmlFor='registration-gate-name'>
                {t('registrationGate.registration.nameLabel')}
              </label>
              <Input
                id='registration-gate-name'
                value={name}
                onChange={(value) => setName(value)}
                placeholder={t('registrationGate.registration.namePlaceholder')}
                data-testid='registration-gate-name'
                disabled={registrationSubmitting}
              />
            </div>

            <div className='registration-gate__field'>
              <label className='registration-gate__label' htmlFor='registration-gate-company'>
                {t('registrationGate.registration.companyLabel')}
              </label>
              <Input
                id='registration-gate-company'
                value={company}
                onChange={(value) => setCompany(value)}
                placeholder={t('registrationGate.registration.companyPlaceholder')}
                data-testid='registration-gate-company'
                disabled={registrationSubmitting}
              />
            </div>

            <div className='registration-gate__field'>
              <label className='registration-gate__label' htmlFor='registration-gate-email'>
                {t('registrationGate.registration.emailLabel')}
              </label>
              <Input
                id='registration-gate-email'
                value={email}
                onChange={(value) => setEmail(value)}
                placeholder={t('registrationGate.registration.emailPlaceholder')}
                data-testid='registration-gate-email'
                disabled={registrationSubmitting}
              />
            </div>

            <label className='registration-gate__consent'>
              <Checkbox
                checked={consent}
                onChange={(checked) => setConsent(checked)}
                data-testid='registration-gate-consent'
                disabled={registrationSubmitting}
              />
              <span className='registration-gate__consent-text'>{t('registrationGate.registration.consentLabel')}</span>
            </label>
            <span className='registration-gate__hint'>{t('registrationGate.registration.consentHint')}</span>

            {registrationError ? (
              <span className='registration-gate__error' role='alert' data-testid='registration-gate-error'>
                {registrationError}
              </span>
            ) : null}

            <Button
              type='primary'
              htmlType='submit'
              long
              shape='round'
              loading={registrationSubmitting}
              data-testid='registration-gate-submit'
            >
              {registrationSubmitting
                ? t('registrationGate.registration.submitting')
                : t('registrationGate.registration.submit')}
            </Button>

            <button
              type='button'
              className='registration-gate__back'
              onClick={() => {
                setRegistrationError(null);
                setStep('license');
              }}
              disabled={registrationSubmitting}
              data-testid='registration-gate-registration-back'
            >
              {t('registrationGate.registration.backToLicense')}
            </button>
          </form>
        ) : (
          <form
            className='registration-gate__form'
            onSubmit={handleActivate}
            data-testid='registration-gate-license-form'
          >
            <p className='registration-gate__subtitle'>{t('registrationGate.license.subtitle')}</p>
            {registeredAsLabel ? <p className='registration-gate__registered-as'>{registeredAsLabel}</p> : null}

            <div className='registration-gate__field'>
              <label className='registration-gate__label' htmlFor='registration-gate-code'>
                {t('registrationGate.license.codeLabel')}
              </label>
              <Input.TextArea
                id='registration-gate-code'
                value={code}
                onChange={(value) => setCode(value)}
                placeholder={t('registrationGate.license.codePlaceholder')}
                autoSize={{ minRows: 3, maxRows: 5 }}
                data-testid='registration-gate-code'
                disabled={licenseSubmitting || licenseSuccess}
              />
            </div>

            {licenseError ? (
              <span className='registration-gate__error' role='alert' data-testid='registration-gate-license-error'>
                {licenseError}
              </span>
            ) : null}
            {licenseSuccess ? (
              <span className='registration-gate__hint' data-testid='registration-gate-license-success'>
                {t('registrationGate.license.success')}
              </span>
            ) : null}

            {hasLocalRegistration ? (
              <Button
                type='primary'
                htmlType='submit'
                long
                shape='round'
                loading={licenseSubmitting}
                disabled={licenseSuccess}
                data-testid='registration-gate-license-submit'
              >
                {licenseSubmitting ? t('registrationGate.license.submitting') : t('registrationGate.license.submit')}
              </Button>
            ) : (
              <div className='registration-gate__license-setup' data-testid='registration-gate-license-setup'>
                <p className='registration-gate__license-setup-copy'>{t('registrationGate.license.localSetupHint')}</p>
                <Button
                  type='primary'
                  htmlType='button'
                  long
                  shape='round'
                  onClick={() => {
                    setLicenseError(null);
                    setStep('registration');
                  }}
                  data-testid='registration-gate-license-setup-button'
                >
                  {t('registrationGate.license.localSetup')}
                </Button>
              </div>
            )}

            <button
              type='button'
              className='registration-gate__back'
              onClick={() => {
                setLicenseError(null);
                // Browser-auth is the coherent primary entry. Returning from the
                // optional code path must not drop a user into the legacy local-PII
                // form that they never chose.
                setStep('auth');
              }}
              disabled={licenseSubmitting || licenseSuccess}
              data-testid='registration-gate-back'
            >
              {t('registrationGate.license.back')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default RegistrationGatePage;
