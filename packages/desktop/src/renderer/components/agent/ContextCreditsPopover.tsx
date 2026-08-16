/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude-Code-style "context + credits" popover body (Lane 3, STEP 2).
 *
 * Two stacked sections, both PURE-data + read-only:
 *   (a) Kontextfenster — used / limit (pct) + a horizontal bar. The limit is
 *       MODEL-SENSITIVE: the LIVE per-model frame (`contextLimit > 0`, from
 *       Hermes' acp_context_usage) always wins; otherwise the model registry
 *       resolves it (GLM/DeepSeek = 1M, local Gemma = 64k). The bar turns
 *       warning > 70% and danger > 90%, matching the ring in ContextUsageIndicator.
 *   (b) Credits — total spendable credits remaining + a bar + a "Nachkaufen"
 *       button that opens the SAME Lane-2 checkout the 402 wall uses. A
 *       "Tank fast leer" warning surfaces when the meter crosses the wall
 *       threshold (the pure isNearAllowanceWall rule) so the operator is never
 *       surprised by a mid-job 402.
 *
 * The MATH lives in the pure `creditsCore` (unit-tested) + `modelContextLimits`;
 * this component is presentation + the buy wiring. German copy (operator UI).
 */

import React, { useMemo } from 'react';
import { Button } from '@arco-design/web-react';
import { Caution, Lightning } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';

import type { TokenUsageData } from '@/common/config/storage';
import { resolveEffectiveContextLimit } from '@/renderer/utils/model/modelContextLimits';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import { CREDIT_UNIT_EUR, isNearAllowanceWall, TIER_ALLOWANCE_CREDITS } from '@/common/config/creditsCore';
// openAccountWeb pins the command-eve.com origin AND carries the desktop session
// hand-off, so "Nachkaufen" lands on /account already logged in (H8).
import { openAccountWeb } from '@renderer/utils/platform';

import { formatTokenCount } from './ContextUsageIndicator';

export interface ContextCreditsPopoverProps {
  /** Live token usage for the active conversation (null before the first frame). */
  tokenUsage: TokenUsageData | null;
  /** The LIVE per-model frame size from Hermes' acp_context_usage (0 ⇒ unknown). */
  contextLimit?: number;
  /** Active model id — resolves the resting context window when no live limit yet. */
  modelId?: string;
}

/** Clamp a percentage into [0, 100] for a never-broken bar. */
function clampPct(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Pick the bar fill color from the same thresholds as the context ring. */
function barColor(pct: number): string {
  if (pct > 90) return 'rgb(var(--danger-6))';
  if (pct > 70) return 'rgb(var(--warning-6))';
  return 'rgb(var(--primary-6))';
}

/** Shared track style for the horizontal bars (no extra stylesheet needed). */
const BAR_TRACK_STYLE: React.CSSProperties = {
  height: 6,
  borderRadius: 3,
  overflow: 'hidden',
  backgroundColor: 'var(--color-fill-3)',
};

const ContextCreditsPopover: React.FC<ContextCreditsPopoverProps> = ({ tokenUsage, contextLimit, modelId }) => {
  const { t } = useTranslation();
  const { meter } = useCreditsStatus();

  // ── (a) Context window ──────────────────────────────────────────────────
  // Model-sensitive: CLOUD follows the model (floored at its registry window, so
  // the local-runtime 64k cap misreported on cloud turns can't shrink Max); LOCAL
  // uses the live frame size as the real window. See resolveEffectiveContextLimit.
  const effectiveLimit = resolveEffectiveContextLimit(modelId, contextLimit);
  const used = tokenUsage ? tokenUsage.total_tokens : 0;
  const ctxPct = clampPct(effectiveLimit > 0 ? (used / effectiveLimit) * 100 : 0);

  // ── (b) Credits ─────────────────────────────────────────────────────────
  // PAID: total spendable balance (allowance + purchased); the bar shows how much
  // of the tier's monthly grant is still in the tank, plus the honest € face
  // value (packs are face value since 1.820.1, so the pack price maps 1000:1).
  // ONE METER, FOR EVERY SEAT (1.820.1). There used to be a second branch here
  // that rendered "X / Y Gratis-Aktionen heute" plus a "morgen geht es kostenlos
  // weiter" reassurance for a credit-less seat. Both were promises the product
  // does not keep: every cloud turn is credit-metered and there is no free daily
  // quota to come back to. A seat with nothing in the tank now reads as an empty
  // tank, which is the true statement.
  const credits = useMemo(() => {
    if (!meter) return null;
    const remaining = meter.totalRemaining;
    const grant = TIER_ALLOWANCE_CREDITS[meter.tier] || TIER_ALLOWANCE_CREDITS.starter;
    const reference = grant > 0 ? grant : 1;
    const remainingPct = clampPct((remaining / reference) * 100);
    return {
      remaining,
      approxEur: remaining * CREDIT_UNIT_EUR,
      remainingPct,
      // "Tank fast leer": the pure wall rule (allowance crossed ~85% used) OR the
      // visible balance dropped under 20% of the reference grant.
      low: isNearAllowanceWall(meter) || remainingPct < 20,
    };
  }, [meter]);

  const handleTopUp = (): void => {
    // H8 (Codex): this CTA used to open the raw CREDIT_PACK_CHECKOUT_URL via
    // openExternalUrl — the browser landed on /account WITHOUT the desktop session,
    // so a logged-out top-up stalled exactly like before the 1.5.1 fix. Use
    // openAccountWeb, which pins the command-eve.com origin AND carries the desktop
    // session hand-off, matching every other Command EVE purchase CTA.
    void openAccountWeb('/account').catch((): undefined => undefined);
  };

  return (
    <div
      className='context-credits-popover p-12px min-w-240px flex flex-col gap-16px'
      data-testid='context-credits-popover'
    >
      {/* (a) Kontextfenster */}
      <section className='context-credits-popover__section'>
        <div className='flex items-center justify-between mb-6px'>
          <span className='text-13px font-medium text-t-primary'>
            {t('credits.context.title', { defaultValue: 'Kontextfenster' })}
          </span>
          <span className='text-12px text-t-secondary' data-testid='context-credits-ctx-readout'>
            {formatTokenCount(used)} / {formatTokenCount(effectiveLimit, true)} ({ctxPct.toFixed(0)}%)
          </span>
        </div>
        <div style={BAR_TRACK_STYLE}>
          <div
            style={{
              width: `${ctxPct}%`,
              height: '100%',
              backgroundColor: barColor(ctxPct),
              transition: 'width 0.3s ease, background-color 0.3s ease',
            }}
          />
        </div>
      </section>

      {/* (b) Credits */}
      <section className='context-credits-popover__section'>
        <div className='flex items-center justify-between mb-6px'>
          <span className='text-13px font-medium text-t-primary flex items-center gap-4px'>
            <Lightning theme='outline' size='13' fill='currentColor' />
            {t('credits.context.creditsTitle', { defaultValue: 'Credits' })}
          </span>
          {credits ? (
            <span className='text-12px text-t-secondary' data-testid='context-credits-credits-readout'>
              {t('credits.context.remainingEur', {
                defaultValue: '{{n}} verbleibend (≈ {{eur}} €)',
                n: credits.remaining.toLocaleString('de-DE'),
                eur: credits.approxEur.toLocaleString('de-DE', { maximumFractionDigits: 2 }),
              })}
            </span>
          ) : (
            <span className='text-12px text-t-secondary'>
              {t('credits.context.noStatus', { defaultValue: 'nach Anmeldung' })}
            </span>
          )}
        </div>

        {credits && (
          <div style={BAR_TRACK_STYLE}>
            <div
              style={{
                width: `${credits.remainingPct}%`,
                height: '100%',
                backgroundColor: credits.low ? 'rgb(var(--danger-6))' : 'rgb(var(--success-6))',
                transition: 'width 0.3s ease, background-color 0.3s ease',
              }}
            />
          </div>
        )}

        {/* Founder mandate 1.2.13: NO prominent "Nachkaufen" upsell in the context
            view. The buy affordance is SUBTLE and only appears when the tank is
            actually low — folded into the warning as a quiet text link, never a
            standing primary CTA pushing the user to spend. */}
        {credits?.low && (
          <div
            className='context-credits-popover__warning flex items-center gap-6px mt-8px'
            data-testid='context-credits-low'
          >
            <Caution theme='outline' size='14' fill='rgb(var(--warning-6))' />
            <span className='text-12px' style={{ color: 'rgb(var(--warning-6))' }}>
              {t('credits.context.tankLow', { defaultValue: 'Tank fast leer' })}
            </span>
            <Button
              type='text'
              size='mini'
              className='context-credits-popover__topup-link px-2px text-12px'
              onClick={handleTopUp}
              data-testid='context-credits-topup'
            >
              {t('credits.context.topUp', { defaultValue: 'Nachkaufen' })}
            </Button>
          </div>
        )}

        {/* "Was ist ein Credit?" — the one-line explainer. Every seat sees it now:
            there is no second, action-counting meter it could fail to apply to. */}
        {credits && (
          <div className='mt-6px text-11px text-t-tertiary' data-testid='context-credits-explainer'>
            {t('credits.context.explainer', { defaultValue: '1.000 Credits = 1 € (Pack-Preis)' })}
          </div>
        )}
      </section>
    </div>
  );
};

export default ContextCreditsPopover;
