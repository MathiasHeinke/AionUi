/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.2 — the "Erste Schritte" hub step list (pure core).
 *
 * The Erste-Schritte tab used to be a status MIRROR (the same readiness card the
 * chat greeting already shows). This turns it into a real Day-0 hub: below the
 * readiness block it lists the concrete first steps, each deep-linking to the
 * page (already existing) that does it.
 *
 * HONESTY (hard rule, founder 2026-07-06): a step is marked 'done' ONLY when a
 * real signal proves it — first-value readiness (cloud lane answers) and the
 * identity onboarding item. Everything we cannot cheaply prove is 'optional' — a
 * neutral "open it" affordance, NEVER a red "you failed to do this" and NEVER a
 * fake green check. Richer per-step done-detection (brain seeded, seat added,
 * connector connected) is a deliberate follow-up, not a fabricated claim here.
 *
 * This core is pure (no ipcBridge/React import) so the honest-status logic is
 * unit-testable in isolation.
 */

export type ErsteSchritteStepStatus =
  /** Proven complete / working right now (green check). */
  | 'done'
  /** A real open step needed for readiness (amber). */
  | 'attention'
  /** Reachable, not required, and not cheaply provable as done (neutral). */
  | 'optional';

/** The onboarding-item state as surfaced by the S0 status model. */
export type ErsteSchritteItemState = 'ok' | 'blocked' | 'skipped' | 'unknown';

export interface ErsteSchritteHubInput {
  /** The single readiness truth (cloud lane can answer). */
  firstValueReady: boolean;
  /** State of the `identity` onboarding item (has EVE been told the operator's name). */
  identityState: ErsteSchritteItemState;
}

export interface ErsteSchritteStep {
  /** Stable id — also the i18n key suffix (title/desc) and the data-testid suffix. */
  id: string;
  /** Existing in-app route to navigate to, or an explicitly declared web intent. */
  route: string;
  /** When true the route opens an external web money surface, not an in-app route. */
  isWebIntent?: boolean;
  status: ErsteSchritteStepStatus;
}

function identityStatus(state: ErsteSchritteItemState): ErsteSchritteStepStatus {
  if (state === 'ok') return 'done';
  if (state === 'blocked') return 'attention';
  // 'skipped' | 'unknown' → neutral (never a false 'done', never a red 'attention').
  return 'optional';
}

/**
 * Build the ordered Erste-Schritte step list. Order = first-value reachability.
 * The routes are all existing in-app routes; no new destination pages are
 * introduced by the hub.
 */
export function buildErsteSchritteHubSteps(input: ErsteSchritteHubInput): ErsteSchritteStep[] {
  return [
    // Cloud lane: 'done' only when first value is proven ready; otherwise NEUTRAL
    // ('optional'), never 'attention' — the readiness block above already alarms an
    // unready lane, and while the status is still loading we must not claim 'not ready'.
    { id: 'ki-spur', route: '/settings/model', status: input.firstValueReady ? 'done' : 'optional' },
    { id: 'company-brain', route: '/settings/company-brain', status: 'optional' },
    // Customer workspaces are free and managed directly in Account settings.
    { id: 'kunde', route: '/settings/account', status: 'optional' },
    { id: 'connectors', route: '/settings/connectors', status: 'optional' },
    { id: 'team', route: '/settings/eve-runtime', status: 'optional' },
    { id: 'skills', route: '/settings/capabilities?tab=skills', status: 'optional' },
    { id: 'privacy', route: '/settings/privacy', status: 'optional' },
    { id: 'budget', route: '/settings/billing', status: 'optional' },
    { id: 'name', route: '/settings/account', status: identityStatus(input.identityState) },
  ];
}
