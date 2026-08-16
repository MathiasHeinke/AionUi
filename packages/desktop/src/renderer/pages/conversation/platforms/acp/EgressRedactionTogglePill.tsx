/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useConfig } from '@/renderer/hooks/config/useConfig';
import { Shield } from '@renderer/components/icons';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * EgressRedactionTogglePill — the DSGVO PII/data-boundary control, surfaced in the
 * chat header's top-right action area as a direct on/off toggle.
 *
 * Founder 2026-07-05: the old "* Datenschutz aus" footnote floated at the edge of
 * the TEXT FIELD (ugly, wrong anchor). This keeps the control in the session
 * header AND makes it a one-click pill so the operator can flip PII protection
 * right in the session — no settings detour.
 *
 * Honesty rules kept: this is a CONTROL-STATE label (the filter is on/off), NOT an
 * "all data is safe" claim (founder 2026-06-26 — we never assert a negative). The
 * OFF state is PROMINENT (a real DSGVO control-waiver must never be invisible); the
 * ON state is DELIBERATELY MUTED (a quiet affordance, not a reassuring banner).
 * Turning it OFF asks a one-tap confirm — disabling client-data redaction is a
 * deliberate act; turning it back ON is a safe instant flip.
 */
const EgressRedactionTogglePill: React.FC = () => {
  const { t } = useTranslation();
  const [egressRedactionMode, setEgressRedactionMode] = useConfig('commandEve.egressRedactionMode');
  // Absent/unknown ⇒ ON (fail-safe: privacy needs no last-known-good).
  const redactionDisabled = egressRedactionMode === 'off';
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const [confirmationStyle, setConfirmationStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
    zIndex: 1200,
  });

  const positionConfirmation = useCallback(() => {
    const anchor = rootRef.current;
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 6;
    const width = Math.min(260, Math.max(220, window.innerWidth - viewportPadding * 2));
    const measuredHeight = confirmationRef.current?.offsetHeight ?? 0;
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.right - width, window.innerWidth - width - viewportPadding)
    );
    const below = anchorRect.bottom + gap;
    const top =
      measuredHeight > 0 && below + measuredHeight > window.innerHeight - viewportPadding
        ? Math.max(viewportPadding, anchorRect.top - measuredHeight - gap)
        : below;

    setConfirmationStyle({
      boxSizing: 'border-box',
      position: 'fixed',
      top,
      left,
      width,
      visibility: 'visible',
      zIndex: 1200,
    });
  }, []);

  useLayoutEffect(() => {
    if (!confirming) return;
    positionConfirmation();
    const frame = window.requestAnimationFrame(positionConfirmation);
    return () => window.cancelAnimationFrame(frame);
  }, [confirming, positionConfirmation]);

  useEffect(() => {
    if (!confirming) return;
    window.addEventListener('resize', positionConfirmation);
    window.addEventListener('scroll', positionConfirmation, true);
    return () => {
      window.removeEventListener('resize', positionConfirmation);
      window.removeEventListener('scroll', positionConfirmation, true);
    };
  }, [confirming, positionConfirmation]);

  // Dismiss the confirm popover on outside-click / Escape (founder 2026-07-05:
  // it previously stayed open when clicking elsewhere).
  useEffect(() => {
    if (!confirming) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !confirmationRef.current?.contains(target)) setConfirming(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirming(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [confirming]);

  const turnOn = () => {
    setConfirming(false);
    void setEgressRedactionMode('on');
  };
  const turnOff = () => {
    setConfirming(false);
    void setEgressRedactionMode('off');
  };

  if (redactionDisabled) {
    // OFF — prominent amber warning; one click turns protection back ON (safe).
    return (
      <button
        type='button'
        onClick={turnOn}
        title={t('conversation.runtimeStatus.egress.pillOffHint', {
          defaultValue:
            'Datenschutz-Filter ist AUS — sensible Daten gehen unredigiert ans Modell. Klicken zum Anschalten.',
        })}
        className='inline-flex items-center gap-4px rd-999px border-none bg-transparent px-6px py-3px text-11px text-warning-6 outline-none cursor-pointer hover:bg-warning-1'
      >
        <Shield theme='outline' size='12' />
        <span>{t('conversation.runtimeStatus.egress.pillOff', { defaultValue: 'Datenschutz aus' })}</span>
      </button>
    );
  }

  // ON — muted, unobtrusive affordance. Clicking asks a one-tap confirm before it
  // disables redaction (a deliberate DSGVO control-waiver).
  return (
    <span ref={rootRef} className='relative inline-flex'>
      <button
        type='button'
        onClick={() => setConfirming((v) => !v)}
        title={t('conversation.runtimeStatus.egress.pillOnHint', {
          defaultValue: 'Datenschutz-Filter ist an. Klicken, um ihn für diesen Seat auszuschalten.',
        })}
        className='inline-flex items-center gap-4px rd-999px border-none bg-transparent px-6px py-3px text-11px text-t-tertiary opacity-70 outline-none cursor-pointer hover:bg-fill-2 hover:opacity-100'
      >
        <Shield theme='outline' size='12' />
        <span>{t('conversation.runtimeStatus.egress.pillOn', { defaultValue: 'Datenschutz an' })}</span>
      </button>
      {confirming && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={confirmationRef}
              data-testid='egress-redaction-confirmation'
              className='rd-12px border border-solid p-12px text-12px'
              style={{
                ...confirmationStyle,
                boxSizing: 'border-box',
                background: 'var(--glass-overlay-bg)',
                borderColor: 'var(--glass-overlay-border)',
                boxShadow: 'var(--glass-shadow-soft)',
                WebkitBackdropFilter: 'var(--glass-overlay-filter)',
                backdropFilter: 'var(--glass-overlay-filter)',
              }}
            >
              <div className='mb-8px text-t-secondary'>
                {t('conversation.runtimeStatus.egress.pillConfirm', {
                  defaultValue:
                    'PII-Schutz für diesen Seat ausschalten? Sensible Daten (Adresse, IBAN, Gesundheit, Finanzen) gehen dann unredigiert ans Modell.',
                })}
              </div>
              <div className='flex justify-end gap-8px'>
                <button
                  type='button'
                  onClick={() => setConfirming(false)}
                  className='rd-8px border border-solid border-border-2 bg-transparent px-10px py-4px text-t-secondary cursor-pointer hover:bg-fill-2'
                >
                  {t('common.cancel', { defaultValue: 'Abbrechen' })}
                </button>
                <button
                  type='button'
                  onClick={turnOff}
                  className='rd-8px border-none bg-warning-6 px-10px py-4px text-white cursor-pointer hover:bg-warning-5'
                >
                  {t('conversation.runtimeStatus.egress.pillConfirmOff', { defaultValue: 'Ausschalten' })}
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </span>
  );
};

export default EgressRedactionTogglePill;
