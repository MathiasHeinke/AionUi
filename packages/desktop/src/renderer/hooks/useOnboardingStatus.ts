/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads the Command EVE onboarding-status from the main process (the S0
 * `command-eve.onboarding-status` read-only aggregator) and derives the S2
 * one-time readiness-greeting view-model via the pure `onboardingGreetingCore`.
 *
 * Mirrors `useCreditsStatus`/`useEntitlementGate`: the main process is the only
 * source of truth — this hook never re-decides any gate, it reads the model and
 * maps it. In non-desktop (WebUI) builds there is no bridge, so the hook reports
 * nothing and the greeting renders nothing (the chat just stays empty).
 *
 * It reads ONCE on mount (the greeting is a one-shot, not a live meter). A
 * `refresh` is exposed for callers that want to re-read after activation.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commandEve, type ICommandEveOnboardingStatusModel } from '@/common/adapter/ipcBridge';
import { isElectronDesktop } from '@renderer/utils/platform';
import { buildOnboardingGreeting, type CommandEveGreetingModel } from '@/common/config/onboardingGreetingCore';

export interface OnboardingStatusState {
  /** True until the first status read resolves. */
  loading: boolean;
  /** The raw setup-completeness model, or null before first read / non-desktop / on error. */
  model: ICommandEveOnboardingStatusModel | null;
  /** The derived one-time greeting view-model (null until a model is read). */
  greeting: CommandEveGreetingModel | null;
  /**
   * True when the last DESKTOP read failed (core ok:false, bridge failure, or
   * IPC rejection). Always false in non-desktop builds, so WebUI surfaces that
   * key on it stay quiet. Consumers may render a claim-free degraded state —
   * never a readiness claim (`buildFallbackGreeting` is the sanctioned shape).
   */
  error: boolean;
  /** The machine reason from a failed read, when the ok:false wrapper carried one. */
  errorReasonCode?: string;
  /** Re-read the onboarding status now (e.g. after activation completes). */
  refresh: () => Promise<void>;
}

export interface OnboardingStatusOptions {
  /**
   * Re-read on window focus. Default OFF: the emptySlot greeting stays a
   * one-shot. The persistent waiting banner opts in so a gap the operator just
   * closed (e.g. activated in the browser) clears without an app restart.
   */
  refreshOnFocus?: boolean;
}

export function useOnboardingStatus(options?: OnboardingStatusOptions): OnboardingStatusState {
  const { i18n } = useTranslation();
  const uiLanguage = i18n.language;
  const refreshOnFocus = options?.refreshOnFocus === true;
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState<ICommandEveOnboardingStatusModel | null>(null);
  const [greeting, setGreeting] = useState<CommandEveGreetingModel | null>(null);
  const [error, setError] = useState(false);
  const [errorReasonCode, setErrorReasonCode] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      setModel(null);
      setGreeting(null);
      setError(false);
      setErrorReasonCode(undefined);
      setLoading(false);
      return;
    }
    try {
      const response = await commandEve.onboardingStatus.invoke();
      const data = response.data ?? null;
      const nextModel = data && data.ok && data.model ? data.model : null;
      setModel(nextModel);
      // Greet in the operator's SELECTED interface language (re-derives when they
      // switch language, since uiLanguage is a dependency of this callback).
      setGreeting(nextModel ? buildOnboardingGreeting(nextModel, uiLanguage) : null);
      // ok:false (core/bridge catch) is a FAILED read, not an empty one — keep
      // it as state so the greeting can render the claim-free fallback instead
      // of a silently bare chat (churn hole #4).
      setError(!nextModel);
      setErrorReasonCode(nextModel ? undefined : (data?.reason_code ?? undefined));
    } catch (err) {
      // A read failure must NEVER crash the chat or block the operator — but it
      // must also never LOOK like success: retain it as `error` state.
      console.error('Onboarding status bridge call failed:', err);
      setModel(null);
      setGreeting(null);
      setError(true);
      setErrorReasonCode(undefined);
    } finally {
      setLoading(false);
    }
  }, [uiLanguage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!refreshOnFocus || !isElectronDesktop()) return;
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshOnFocus, refresh]);

  return { loading, model, greeting, error, errorReasonCode, refresh };
}
