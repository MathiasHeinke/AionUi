/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE guided onboarding (SLICE S2) — the pure greeting builder.
 *
 * Turns the read-only setup-completeness model from the S0 aggregator
 * (`command-eve.onboarding-status`) into a ONE-TIME German readiness-checklist
 * greeting view-model. The renderer paints this into the existing chat
 * `emptySlot` seam (shown only when a conversation has zero messages) — no new
 * message type, no persistence, no behaviour change anywhere else.
 *
 * THE GATE (mirrors S0): a cloud-ready user — licensed + a usable cloud bearer
 * — is "startklar". `first_value_ready` is the single truth; local stages NEVER
 * hold back first value. So:
 *   - first_value_ready  → a warm "du bist startklar" greeting, no gap list.
 *   - !first_value_ready → list ONLY the items that genuinely block first value
 *     (the real gaps), each with a plain-German line + a "klick hier" target.
 *
 * HONESTY (carried from S0/S1): this builder claims no capability it does not
 * surface here. It never asks for an API key/secret, never references a learned-
 * from-seed memory or a connector (S5/S6, out of this lane). `skipped` items
 * (e.g. the optional local lane for a cloud user) are NEVER shown as gaps.
 *
 * This module is PURE (no IO, no React) so it is unit-testable in isolation and
 * shared between the renderer component and the test suite.
 */

import type {
  ICommandEveOnboardingItem,
  ICommandEveOnboardingItemId,
  ICommandEveOnboardingStatusModel,
} from '@/common/adapter/ipcBridge';

export const COMMAND_EVE_ONBOARDING_GREETING_VERSION = 'command-eve-onboarding-greeting/v0';

/**
 * Where a "klick hier" link in the greeting should take the operator. These are
 * stable, app-internal hash-route hints the renderer maps to navigation; the
 * pure core stays free of any router dependency.
 *   - `registration` → the registration / license gate (account setup).
 *   - `runtime`      → the read-only /runtime page (S4 RemediationCard lives there).
 *   - `none`         → no navigation target (informational only).
 */
export type CommandEveGreetingLinkTarget = 'registration' | 'runtime' | 'none';

export interface CommandEveGreetingGap {
  /** Which onboarding item this gap came from (stable key for React + tests). */
  id: ICommandEveOnboardingItemId;
  /** Localized one-liner describing the gap, in the operator's selected language. */
  text: string;
  /** The label for the inline "klick hier" link, or undefined when none. */
  link_label?: string;
  /** Where the link points. `none` ⇒ no link is rendered. */
  link_target: CommandEveGreetingLinkTarget;
  /** The machine reason code behind the gap, when one exists (diagnostics). */
  reason_code?: string;
}

export interface CommandEveGreetingModel {
  schema_version: typeof COMMAND_EVE_ONBOARDING_GREETING_VERSION;
  /** True ⇒ render the "du bist startklar" state; false ⇒ render the gap list. */
  ready: boolean;
  /** The headline line (greets by name when we have a confirmed one). */
  headline: string;
  /** A short supporting line under the headline. */
  subline: string;
  /**
   * The real remaining gaps, in display order. EMPTY when `ready` is true.
   * Only `blocked` items that actually hold back first value appear here —
   * `skipped` and `ok` items are filtered out (a cloud user never sees the
   * optional local lane as a gap).
   */
  gaps: CommandEveGreetingGap[];
  /**
   * True ONLY on the claim-free fallback greeting (`buildFallbackGreeting`):
   * the status read failed, so this model asserts NOTHING about readiness —
   * never `ready`, never a name, never a gap list.
   */
  degraded?: true;
}

/**
 * Map an onboarding item's id + remediation kind to the greeting's navigation
 * target + link label. The link is a gentle "klick hier"; the destination is an
 * existing in-app page (never an external command, never a secret prompt).
 */
export type CommandEveGreetingLocale = 'de' | 'en';

/**
 * EVE speaks DE or EN. Explicit German locale -> 'de'; any other explicit locale
 * (en, tr, …) -> 'en'. Empty/unknown -> 'de', the product's DACH-first default
 * (the renderer always passes the live i18n locale, so this only guards the rare
 * unset case and keeps the prior German-default behavior).
 */
export function normalizeGreetingLocale(input?: string): CommandEveGreetingLocale {
  const code = (input || '').trim().toLowerCase();
  if (!code) return 'de';
  return code.startsWith('de') ? 'de' : 'en';
}

// The greeting's own display copy in the operator's selected language. The
// reason-code-SPECIFIC local-lane fix lives on the already-localized /runtime
// RemediationCard, so the greeting stays high-level (per-item, not per-code).
const GREETING_COPY: Record<
  CommandEveGreetingLocale,
  {
    clickHere: string;
    headlineReady: string;
    headlineAlmost: string;
    sublineReady: string;
    sublineGaps: string;
    sublineAlmost: string;
    headlineDegraded: string;
    sublineDegraded: string;
    bannerTitle: string;
    gap: Record<
      'registration' | 'license' | 'licenseExpired' | 'cloud-lane' | 'local-lane' | 'identity' | 'fallback',
      string
    >;
  }
> = {
  de: {
    clickHere: 'klick hier',
    headlineReady: 'du bist startklar.',
    headlineAlmost: 'fast geschafft.',
    // v1.6 Slice 4 (Day-Zero-Soft-Fold): the chat is the brief collector — the
    // ready state actively asks for the brief (EVE mirrors it, Beat 1). Shows
    // only until EVE's first handover note exists (the note then owns the surface).
    sublineReady:
      'Erzähl mir in 2–3 Sätzen, was dein Geschäft ist und woran du gerade arbeitest — ich merke es mir und spiele es dir kurz zurück.',
    sublineGaps: 'Nur noch das hier, dann können wir loslegen:',
    sublineAlmost: 'Gleich geht es los.',
    headlineDegraded: 'Hi.',
    sublineDegraded: 'Ich konnte deinen Einrichtungs-Status gerade nicht lesen — im Chat geht es trotzdem weiter.',
    bannerTitle: 'Bevor es weitergeht:',
    gap: {
      registration: 'Lege kurz dein Konto an, damit ich dich kenne.',
      license: 'Füge deinen Lizenz-Code ein, dann bist du startklar.',
      licenseExpired: 'Deine Lizenz ist abgelaufen — kurz verlängern, dann geht es weiter.',
      'cloud-lane': 'Kurz neu aktivieren, dann läuft die Cloud-KI wieder.',
      'local-lane': 'Die lokale KI braucht noch einen Schritt — ich zeig ihn dir.',
      identity: 'Sag mir kurz, wie ich dich nennen darf.',
      fallback: 'Eine Kleinigkeit fehlt noch — ich helfe dir dabei.',
    },
  },
  en: {
    clickHere: 'click here',
    headlineReady: "you're all set.",
    headlineAlmost: 'almost there.',
    sublineReady:
      'Tell me in 2–3 sentences what your business is and what you’re working on — I’ll remember it and play it back to you.',
    sublineGaps: 'Just this, then we’re good to go:',
    sublineAlmost: 'Almost ready.',
    headlineDegraded: 'Hi.',
    sublineDegraded: 'I couldn’t read your setup status just now — the chat still works.',
    bannerTitle: 'Before we continue:',
    gap: {
      registration: 'Set up your account so I know who you are.',
      license: 'Add your license code and you’re all set.',
      licenseExpired: 'Your license has expired — renew it briefly and we’re back.',
      'cloud-lane': 'Re-activate briefly and the cloud AI is back.',
      'local-lane': 'Your local AI needs one more step — I’ll show you.',
      identity: 'Tell me what I should call you.',
      fallback: 'One small thing is missing — I’ll help you with it.',
    },
  },
};

function resolveLink(item: ICommandEveOnboardingItem): {
  has_link: boolean;
  link_target: CommandEveGreetingLinkTarget;
} {
  switch (item.id) {
    case 'registration':
    case 'license':
    case 'cloud-lane':
      // Account / license / cloud-bearer gaps are all closed at the
      // registration + activation gate.
      return { has_link: true, link_target: 'registration' };
    case 'local-lane':
      // The optional local lane is repaired on the read-only /runtime page,
      // where the S4 RemediationCard renders the reason-code-specific fix.
      return { has_link: true, link_target: 'runtime' };
    case 'identity':
    default:
      // Identity confirmation is a soft conversational nicety — no link; EVE
      // simply asks in chat. (It is never a first-value blocker anyway.)
      return { has_link: false, link_target: 'none' };
  }
}

/** The localized one-liner for a blocked item (reason-code detail lives on /runtime). */
function gapText(item: ICommandEveOnboardingItem, locale: CommandEveGreetingLocale): string {
  const copy = GREETING_COPY[locale].gap;
  if (item.id === 'license' && item.reason_code === 'LICENSE_EXPIRED') return copy.licenseExpired;
  switch (item.id) {
    case 'registration':
      return copy.registration;
    case 'license':
      return copy.license;
    case 'cloud-lane':
      return copy['cloud-lane'];
    case 'local-lane':
      return copy['local-lane'];
    case 'identity':
      return copy.identity;
    default:
      return copy.fallback;
  }
}

/**
 * The greeting headline. We greet by a CONFIRMED name only (confidence
 * 'verified' and no pending confirmation); a guessed name is never asserted as
 * fact in the headline (honesty — that confirmation belongs in chat, not in a
 * one-shot greeting).
 */
function buildHeadline(
  model: ICommandEveOnboardingStatusModel,
  ready: boolean,
  locale: CommandEveGreetingLocale
): string {
  const name = model.identity.founder_name;
  const confirmed = Boolean(name) && model.identity.confidence === 'verified' && !model.identity.needs_confirmation;
  const greeting = confirmed ? `Hi ${name}` : 'Hi';
  const tail = ready ? GREETING_COPY[locale].headlineReady : GREETING_COPY[locale].headlineAlmost;
  return `${greeting} — ${tail}`;
}

/**
 * Build the one-time readiness-greeting view-model from the S0 status model.
 * Pure: same input ⇒ same output, no IO, no React.
 */
export function buildOnboardingGreeting(
  model: ICommandEveOnboardingStatusModel,
  uiLanguage?: string
): CommandEveGreetingModel {
  const locale = normalizeGreetingLocale(uiLanguage);
  const copy = GREETING_COPY[locale];
  const ready = model.first_value_ready === true;

  if (ready) {
    return {
      schema_version: COMMAND_EVE_ONBOARDING_GREETING_VERSION,
      ready: true,
      headline: buildHeadline(model, true, locale),
      subline: copy.sublineReady,
      gaps: [],
    };
  }

  // Not ready: surface ONLY the genuine first-value blockers. `skipped` (e.g.
  // the optional local lane) and `ok` items are filtered out so a cloud user is
  // never nagged about a lane they don't use. The gap text is the greeting's own
  // localized per-item copy (the reason-code-specific fix lives on /runtime).
  const blockers = (model.items || []).filter((item) => item.state === 'blocked');

  const gaps: CommandEveGreetingGap[] = blockers.map((item) => {
    const link = resolveLink(item);
    return {
      id: item.id,
      text: gapText(item, locale),
      link_label: link.has_link ? copy.clickHere : undefined,
      link_target: link.link_target,
      ...(item.reason_code ? { reason_code: item.reason_code } : {}),
    };
  });

  return {
    schema_version: COMMAND_EVE_ONBOARDING_GREETING_VERSION,
    ready: false,
    headline: buildHeadline(model, false, locale),
    subline: gaps.length > 0 ? copy.sublineGaps : copy.sublineAlmost,
    gaps,
  };
}

/**
 * The claim-free fallback greeting for a FAILED status read (core throw, bridge
 * throw, or IPC failure — the churn-hole-#4 class where the chat used to render
 * NOTHING). Honesty invariants: never the `ready` state, never a name (an
 * unknown status must not greet a client seat with a cached identity — ISO-6),
 * never invented gaps. Pure: same input ⇒ same output, no IO, no React.
 */
export function buildFallbackGreeting(uiLanguage?: string): CommandEveGreetingModel {
  const copy = GREETING_COPY[normalizeGreetingLocale(uiLanguage)];
  return {
    schema_version: COMMAND_EVE_ONBOARDING_GREETING_VERSION,
    ready: false,
    headline: copy.headlineDegraded,
    subline: copy.sublineDegraded,
    gaps: [],
    degraded: true,
  };
}

/**
 * Localized title line for the persistent in-conversation waiting banner (the
 * surface that keeps genuine first-value blockers visible once a conversation
 * has messages and the one-shot emptySlot greeting is gone).
 */
export function getGreetingBannerTitle(uiLanguage?: string): string {
  return GREETING_COPY[normalizeGreetingLocale(uiLanguage)].bannerTitle;
}
