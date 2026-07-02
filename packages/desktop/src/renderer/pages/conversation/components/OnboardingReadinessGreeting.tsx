/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE guided onboarding (SLICE S2) — the one-time readiness greeting.
 *
 * Rendered into the chat `emptySlot` seam, which the MessageList shows ONLY when
 * a conversation has zero messages. So this greeting is inherently one-shot and
 * non-persistent: the moment the operator sends a first message it disappears,
 * and it never writes a message or any state. No new message type, no storage.
 *
 * It reads the S0 onboarding-status model via `useOnboardingStatus`, derives the
 * German checklist via the pure `onboardingGreetingCore`, and:
 *   - ready  → renders the warm "du bist startklar" state.
 *   - !ready → renders ONLY the real remaining gaps, each with a "klick hier"
 *     link to the existing in-app page that closes it.
 *
 * Safety (v1.6 "nie wieder leer"): while loading or on non-desktop it renders
 * NOTHING; a FAILED desktop read renders the claim-free fallback greeting from
 * the pure core instead of a silently bare chat (churn hole #4) — the fallback
 * never claims readiness, never a name, never invents gaps.
 * HONESTY: no secret/API-key prompt, no learned-from-seed or connector claim.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useOnboardingStatus } from '@renderer/hooks/useOnboardingStatus';
import { useStartscreenNote } from '@renderer/hooks/useStartscreenNote';
import { buildFallbackGreeting } from '@/common/config/onboardingGreetingCore';
import { buildNoteFrame } from '@/common/config/startscreenNoteCore';
import type {
  CommandEveGreetingGap,
  CommandEveGreetingLinkTarget,
} from '@/common/config/onboardingGreetingCore';

/**
 * Map a pure-core link target onto an existing app hash-route. Exported for the
 * persistent waiting banner, which renders the same gap links outside the
 * one-shot emptySlot — one mapping, two surfaces.
 */
export function targetToRoute(target: CommandEveGreetingLinkTarget): string | null {
  switch (target) {
    case 'registration':
      // License / cloud-bearer re-activation lives at the billing settings
      // surface. (A truly UNregistered user never reaches the chat — the
      // registration gate is structural and replaces the layout — so this link
      // serves the licensed-but-no-bearer re-activation case.)
      return '/settings/billing';
    case 'runtime':
      // The read-only local-runtime page (S4 RemediationCard renders here).
      return '/runtime';
    case 'none':
    default:
      return null;
  }
}

const GapRow: React.FC<{ gap: CommandEveGreetingGap; onNavigate: (route: string) => void }> = ({
  gap,
  onNavigate,
}) => {
  const route = targetToRoute(gap.link_target);
  return (
    <div
      data-testid={`eve-onboarding-greeting-gap-${gap.id}`}
      className='flex items-start gap-10px px-14px py-10px rd-10px bg-fill-2 text-left'
    >
      <span className='text-15px leading-22px shrink-0' aria-hidden>
        •
      </span>
      <span className='text-13px text-t-secondary leading-20px'>
        {gap.text}
        {route && gap.link_label ? (
          <>
            {' '}
            <a
              data-testid={`eve-onboarding-greeting-link-${gap.id}`}
              className='text-primary hover:underline cursor-pointer'
              onClick={() => onNavigate(route)}
            >
              {gap.link_label}
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
};

/**
 * v1.6 Slice 2 ("Die Hinterlassene Hand") — EVE's handover note block. The
 * SYSTEM owns only the frame (title + honest age label from the file's mtime);
 * every word inside is hers, rendered VERBATIM (pre-wrap, no markdown pipeline —
 * her words, unedited). Her `next:` entries are the only tap-affordances on the
 * surface: a tap sends that suggestion as the operator's message into the
 * current conversation ("Chips aus ihrem Mund" — she authored them, the
 * renderer only makes them tappable).
 */
const HandoverNoteBlock: React.FC<{
  note: { body_md: string; next: string[]; mtimeMs: number };
}> = ({ note }) => {
  const { i18n } = useTranslation();
  const conversation = useConversationContextSafe();
  const [sending, setSending] = useState(false);
  const frame = useMemo(() => buildNoteFrame(note.mtimeMs, Date.now(), i18n.language), [note.mtimeMs, i18n.language]);

  const onTapNext = useCallback(
    async (text: string) => {
      const conversationId = conversation?.conversation_id;
      if (!conversationId || sending) return;
      setSending(true);
      try {
        // Sends HER suggestion as the operator's visible message — the reply is
        // a real agent turn; the emptySlot disappears when the message lands.
        await ipcBridge.acpConversation.sendMessage.invoke({
          input: text,
          conversation_id: conversationId,
        });
      } catch (error) {
        console.error('Handover-note suggestion send failed:', error);
        setSending(false);
      }
    },
    [conversation?.conversation_id, sending]
  );

  return (
    <div
      data-testid='eve-handover-note'
      data-age-class={frame.age_class}
      className='flex flex-col gap-8px w-full px-14px py-12px rd-10px bg-fill-2 text-left'
    >
      <div className='flex items-baseline justify-between gap-8px'>
        <span className='text-12px font-medium text-t-primary'>{frame.title}</span>
        <span data-testid='eve-handover-note-age' className='text-11px text-t-tertiary shrink-0'>
          {frame.age_label}
        </span>
      </div>
      <div data-testid='eve-handover-note-body' className='text-13px text-t-secondary leading-20px whitespace-pre-wrap'>
        {note.body_md}
      </div>
      {note.next.length > 0 && conversation?.conversation_id ? (
        <div className='flex flex-wrap gap-6px m-t-4px'>
          {note.next.map((entry, index) => (
            <button
              key={index}
              type='button'
              data-testid={`eve-handover-note-next-${index}`}
              disabled={sending}
              className='px-10px py-6px rd-8px bg-fill-3 text-12px text-t-primary cursor-pointer hover:bg-fill-4 disabled:opacity-50 border-none'
              onClick={() => void onTapNext(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const OnboardingReadinessGreeting: React.FC = () => {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const { loading, greeting, error } = useOnboardingStatus();
  const { loading: noteLoading, note } = useStartscreenNote();

  const onNavigate = useCallback(
    (route: string) => {
      void Promise.resolve(navigate(route)).catch((error) => {
        console.error('Onboarding greeting navigation failed:', error);
      });
    },
    [navigate]
  );

  // A FAILED desktop read gets the claim-free fallback card instead of a bare
  // chat. `error` is false on non-desktop and while a model exists, so this
  // never lights up the WebUI and never shadows a real greeting.
  const fallback = useMemo(
    () => (error && !greeting ? buildFallbackGreeting(i18n.language) : null),
    [error, greeting, i18n.language]
  );
  const view = greeting ?? fallback;

  // Quiet while loading and on non-desktop — the empty chat renders as before.
  if (loading || noteLoading || (!view && !note)) return null;

  // Authorization split (Turnier-Invariante): when EVE's note exists and the
  // system has nothing that MUST be said (no blockers, no unknown status), her
  // voice owns the surface — the generic system headline is suppressed. The
  // system card stays whenever it carries real information: gaps, degraded
  // status, or when no note exists (cold start).
  const showSystemCard = Boolean(view) && (!note || view!.degraded === true || !view!.ready || view!.gaps.length > 0);

  return (
    <div
      data-testid='eve-onboarding-greeting'
      data-ready={view?.ready ? 'true' : 'false'}
      data-degraded={view?.degraded ? 'true' : undefined}
      className='flex flex-col items-center gap-16px px-24px text-center max-w-480px w-full'
    >
      {note ? <HandoverNoteBlock note={note} /> : null}
      {showSystemCard && view ? (
        <>
          <div className='flex flex-col gap-6px'>
            <span className='text-18px font-semibold text-t-primary'>{view.headline}</span>
            <span className='text-13px text-t-secondary'>{view.subline}</span>
          </div>
          {!view.ready && view.gaps.length > 0 && (
            <div className='flex flex-col gap-8px w-full'>
              {view.gaps.map((gap) => (
                <GapRow key={gap.id} gap={gap} onNavigate={onNavigate} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};

export default OnboardingReadinessGreeting;
