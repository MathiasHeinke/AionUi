/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-visible PROJECTED-SPEND meter (P0 #1) — the live month-end budget bar for
 * "Dein Team".
 *
 * It sums the expected EUR/mo "salary" of every ACTIVE worker via the PURE
 * {@link projectMonthlySpend} and shows the running projected month-end total
 * against the included ~60€ base hull, so the user always SEES what the team
 * will cost BEFORE the bill — never a surprise. When the projection exceeds the
 * hull the bar turns to a warning and shows the overage.
 *
 * Pure data in → presentation out. The activate-time cap-and-ask confirm lives
 * in {@link DeinTeamPanel} (it uses {@link evaluateBudgetGate}); this component
 * is just the always-visible meter.
 */

import { type ProjectedSpend } from '@/common/config/eveTeamBudgetCore';
import { Progress, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface ProjectedSpendMeterProps {
  /** The pre-computed projection (from `projectMonthlySpend`). */
  projection: ProjectedSpend;
}

/** Format a EUR figure as a whole-euro string (no cents — these are salary bands). */
function eur(n: number): string {
  return `${Math.round(n)}€`;
}

const ProjectedSpendMeter: React.FC<ProjectedSpendMeterProps> = ({ projection }) => {
  const { t } = useTranslation();
  const { totalEur, hullEur, fitsHull, remainingEur, overageEur, lines } = projection;
  const percent = hullEur > 0 ? Math.min(100, Math.round((totalEur / hullEur) * 100)) : 0;
  const activePaid = lines.filter((l) => l.active && l.salaryEur > 0);

  const tooltip = (
    <div>
      <div>{t('deinTeam.budget.activePaid', { count: activePaid.length })}</div>
      {activePaid.map((l) => (
        <div key={l.role.agent_id}>
          {t(`deinTeam.roles.${l.role.agent_id}.name`, { defaultValue: l.role.displayName })} · {eur(l.salaryEur)}/
          {t('deinTeam.budget.monthShort')}
        </div>
      ))}
      <div style={{ marginTop: 4 }}>
        {fitsHull
          ? t('deinTeam.budget.tooltipRemaining', { amount: eur(remainingEur) })
          : t('deinTeam.budget.tooltipOverage', { amount: eur(overageEur) })}
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltip} position='bottom'>
      <div
        className='box-border w-full mb-3 p-2 rounded'
        data-testid='projected-spend-meter'
        data-fits-hull={fitsHull ? 'true' : 'false'}
        style={{ background: 'var(--color-fill-1)' }}
      >
        <div className='flex items-start justify-between gap-12px mb-1'>
          <span className='min-w-0 text-sm font-medium text-t-primary'>{t('deinTeam.budget.title')}</span>
          <span
            className='shrink-0 whitespace-nowrap text-sm font-medium'
            data-testid='projected-spend-total'
            style={{ color: fitsHull ? 'var(--color-text-1)' : 'rgb(var(--danger-6))' }}
          >
            {eur(totalEur)} / {eur(hullEur)}
          </span>
        </div>
        <Progress percent={percent} showText={false} size='small' status={fitsHull ? 'normal' : 'error'} />
        <div className='text-xs text-t-secondary mt-1' data-testid='projected-spend-hint'>
          {fitsHull
            ? t('deinTeam.budget.withinBudget', { amount: eur(remainingEur) })
            : t('deinTeam.budget.overBudget', { amount: eur(overageEur) })}
        </div>
      </div>
    </Tooltip>
  );
};

export default ProjectedSpendMeter;
