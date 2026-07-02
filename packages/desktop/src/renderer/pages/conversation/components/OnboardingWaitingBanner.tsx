/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE v1.6 (Slice 1, "nie wieder leer") — the persistent in-conversation
 * waiting banner.
 *
 * The one-shot readiness greeting lives in the chat `emptySlot` and disappears
 * with the first visible message — after that, a genuine first-value blocker
 * (expired license, dropped cloud bearer, …) was only visible as a transient
 * send-time toast or on the buried /settings/runtime page. This banner keeps
 * those blockers visible INSIDE a conversation that already has messages.
 *
 * Division of labour with the greeting (no double surface):
 *   - zero visible messages → greeting owns the surface, banner renders null;
 *   - messages exist + genuine blockers → banner shows the same localized gap
 *     rows ("klick hier" links included) above the message list;
 *   - ready, unknown/failed status, or non-desktop → null. A FAILED read is
 *     handled claim-free by the greeting's fallback; the banner never nags a
 *     working conversation about a status it cannot know.
 *
 * Liveness: opts into refresh-on-focus so a gap the operator just closed (e.g.
 * re-activated in the browser) clears when they come back to the app.
 */

import React, { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useOnboardingStatus } from '@renderer/hooks/useOnboardingStatus';
import { getGreetingBannerTitle } from '@/common/config/onboardingGreetingCore';
import { useMessageList } from '../Messages/hooks';
import { targetToRoute } from './OnboardingReadinessGreeting';

const OnboardingWaitingBanner: React.FC = () => {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const list = useMessageList();
  const { loading, greeting } = useOnboardingStatus({ refreshOnFocus: true });

  // Mirror the MessageList visibility rule: hidden + available_commands never
  // count, so the banner and the emptySlot greeting can never show together.
  const hasVisibleMessages = useMemo(
    () => list.some((message) => !message.hidden && message.type !== 'available_commands'),
    [list]
  );

  const onNavigate = useCallback(
    (route: string) => {
      void Promise.resolve(navigate(route)).catch((error) => {
        console.error('Onboarding waiting banner navigation failed:', error);
      });
    },
    [navigate]
  );

  if (loading || !hasVisibleMessages || !greeting || greeting.ready || greeting.gaps.length === 0) {
    return null;
  }

  return (
    <div
      data-testid='eve-onboarding-waiting-banner'
      className='w-full max-w-full md:max-w-780px mx-auto m-t-8px px-14px py-10px rd-10px bg-fill-2 text-left'
    >
      <span className='text-12px font-medium text-t-primary'>{getGreetingBannerTitle(i18n.language)}</span>
      <div className='flex flex-col gap-4px m-t-4px'>
        {greeting.gaps.map((gap) => {
          const route = targetToRoute(gap.link_target);
          return (
            <span
              key={gap.id}
              data-testid={`eve-onboarding-waiting-gap-${gap.id}`}
              className='text-13px text-t-secondary leading-20px'
            >
              • {gap.text}
              {route && gap.link_label ? (
                <>
                  {' '}
                  <a
                    data-testid={`eve-onboarding-waiting-link-${gap.id}`}
                    className='text-primary hover:underline cursor-pointer'
                    onClick={() => onNavigate(route)}
                  >
                    {gap.link_label}
                  </a>
                </>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default OnboardingWaitingBanner;
