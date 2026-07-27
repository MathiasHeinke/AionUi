/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Honest PLAN / ACTUAL team meter.
 *
 * PLAN is the existing roster salary-band budget, not a billing statement.
 * ACTUAL is rendered only from a complete, current SG-1 envelope whose rows are
 * bound to an agent id, period and recorded route. Missing proof remains visibly
 * unavailable; no zero, local route or cost is inferred.
 */

import { type TeamPlanActualMeter } from '@/common/config/eveTeamBudgetCore';
import { type AgentUsageRoute } from '@/common/config/seatUsageCore';
import { Progress, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface ProjectedSpendMeterProps {
  meter: TeamPlanActualMeter;
}

/** Format a EUR figure as a whole-euro string (no cents — these are salary bands). */
function eur(n: number): string {
  return `${Math.round(n)}€`;
}

const ProjectedSpendMeter: React.FC<ProjectedSpendMeterProps> = ({ meter }) => {
  const { t } = useTranslation();
  const { plan: projection, actual } = meter;
  const { totalEur, hullEur, fitsHull, remainingEur, overageEur, lines } = projection;
  const percent = hullEur > 0 ? Math.min(100, Math.round((totalEur / hullEur) * 100)) : 0;
  const activePaid = lines.filter((l) => l.active && l.salaryEur > 0);
  const routeLabel = (route: AgentUsageRoute): string => t(`deinTeam.budget.routes.${route}`);
  const actualRoutes =
    actual.status === 'available' ? [...new Set(actual.rows.map((row) => row.route))].map(routeLabel) : [];

  const tooltip = (
    <div>
      <div>{t('deinTeam.budget.planTooltip', { count: activePaid.length })}</div>
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
      {actual.status === 'available' ? (
        <div style={{ marginTop: 8 }} data-testid='actual-usage-provenance'>
          <div>{t('deinTeam.budget.actualProofTitle', { period: actual.period })}</div>
          {actual.rows.map((row) => (
            <div
              key={row.ledger_event_id}
              data-agent-id={row.agent_id}
              data-period={row.period}
              data-route={row.route}
              data-ledger-event-id={row.ledger_event_id}
              data-routing-receipt-id={row.routing_receipt_id}
            >
              {t(`deinTeam.roles.${row.agent_id}.name`, {
                defaultValue: row.agent_id === 'eve' ? 'EVE' : row.agent_id,
              })}
              {' · '}
              {t('deinTeam.budget.actualCalls', { count: row.calls })}
              {' · '}
              {routeLabel(row.route)}
              {' · '}
              {t('deinTeam.budget.receipt', { id: row.routing_receipt_id })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <Tooltip content={tooltip} position='bottom'>
      <div
        className='box-border w-full mb-3 p-2 rounded'
        data-testid='projected-spend-meter'
        data-fits-hull={fitsHull ? 'true' : 'false'}
        data-actual-status={actual.status}
        style={{ background: 'var(--color-fill-1)' }}
      >
        <div className='flex items-start justify-between gap-12px mb-1'>
          <span className='min-w-0 text-sm font-medium text-t-primary'>{t('deinTeam.budget.title')}</span>
          <span
            className='shrink-0 whitespace-nowrap text-sm font-medium'
            data-testid='projected-spend-total'
            style={{ color: fitsHull ? 'var(--color-text-1)' : 'rgb(var(--danger-6))' }}
          >
            {t('deinTeam.budget.planValue', { plan: eur(totalEur), hull: eur(hullEur) })}
          </span>
        </div>
        <Progress percent={percent} showText={false} size='small' status={fitsHull ? 'normal' : 'error'} />
        <div className='text-xs text-t-secondary mt-1' data-testid='projected-spend-hint'>
          {fitsHull
            ? t('deinTeam.budget.withinBudget', { amount: eur(remainingEur) })
            : t('deinTeam.budget.overBudget', { amount: eur(overageEur) })}
        </div>
        <div className='text-xs text-t-primary mt-2' data-testid='actual-spend-value'>
          {actual.status === 'available'
            ? t('deinTeam.budget.actualAvailable', {
                count: actual.total_calls,
                period: actual.period,
                routes: actualRoutes.join(' · '),
              })
            : t('deinTeam.budget.actualUnavailable')}
        </div>
      </div>
    </Tooltip>
  );
};

export default ProjectedSpendMeter;
