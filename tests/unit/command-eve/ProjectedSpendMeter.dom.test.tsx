/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildTeamPlanActualMeter, projectMonthlySpend } from '@/common/config/eveTeamBudgetCore';
import type { VerifiedAgentUsageSnapshot } from '@/common/config/seatUsageCore';

const COPY: Record<string, string> = {
  'deinTeam.budget.title': 'Plan vs. Ist',
  'deinTeam.budget.planValue': 'Plan {{plan}} / {{hull}}',
  'deinTeam.budget.planTooltip': 'Planwerte aktiver Rollen: {{count}}',
  'deinTeam.budget.monthShort': 'Mon.',
  'deinTeam.budget.tooltipRemaining': 'Noch {{amount}} im Planrahmen frei',
  'deinTeam.budget.tooltipOverage': '{{amount}} über dem Planrahmen',
  'deinTeam.budget.withinBudget': 'Planwert — noch {{amount}}. Keine Ist-Abrechnung.',
  'deinTeam.budget.overBudget': 'Planrahmen um {{amount}} überschritten. Keine Ist-Abrechnung.',
  'deinTeam.budget.actualAvailable': 'Ist · {{count}} bestätigte Einsätze · {{period}} · {{routes}}',
  'deinTeam.budget.actualUnavailable': 'Ist · nicht verfügbar — keine passende aktuelle Ledger-Provenienz.',
  'deinTeam.budget.actualProofTitle': 'SG-1-Ledgerbelege für {{period}}',
  'deinTeam.budget.actualCalls': '{{count}} Einsätze',
  'deinTeam.budget.receipt': 'Routing-Beleg {{id}}',
  'deinTeam.budget.routes.subscription': 'Abo-Lane',
  'deinTeam.budget.routes.byok': 'BYOK-Lane',
  'deinTeam.budget.routes.local': 'Lokale Lane',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = COPY[key] ?? (options?.defaultValue as string) ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== 'defaultValue') value = value.replaceAll(`{{${name}}}`, String(replacement));
      }
      return value;
    },
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Progress: ({ percent }: { percent: number }) => <div data-testid='plan-progress' data-percent={percent} />,
  Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid='meter-tooltip'>{content}</div>
    </>
  ),
}));

import ProjectedSpendMeter from '@/renderer/components/team/ProjectedSpendMeter';

afterEach(() => cleanup());

describe('ProjectedSpendMeter — honest Plan / Ist rendering', () => {
  it('renders missing actual as unavailable, never as zero or an inferred local route', () => {
    const unavailable: VerifiedAgentUsageSnapshot = {
      status: 'unavailable',
      period: '2026-07',
      reason: 'missing-or-malformed',
      rows: [],
      total_calls: null,
      as_of: null,
    };
    render(<ProjectedSpendMeter meter={buildTeamPlanActualMeter(projectMonthlySpend({}), unavailable)} />);

    expect(screen.getByTestId('projected-spend-meter').getAttribute('data-actual-status')).toBe('unavailable');
    expect(screen.getByTestId('projected-spend-total').textContent).toContain('Plan');
    expect(screen.getByTestId('actual-spend-value').textContent).toContain('nicht verfügbar');
    expect(screen.getByTestId('actual-spend-value').textContent).not.toContain('0');
    expect(screen.getByTestId('actual-spend-value').textContent).not.toContain('Lokale Lane');
  });

  it('renders the exact attested route and exposes ledger/routing receipt ids for live proof', () => {
    const available: VerifiedAgentUsageSnapshot = {
      status: 'available',
      period: '2026-07',
      as_of: '2026-07-20T11:55:00.000Z',
      total_calls: 3,
      rows: [
        {
          ledger_event_id: 'ledger-evt-1',
          routing_receipt_id: 'routing-receipt-1',
          agent_id: 'content-writer',
          period: '2026-07',
          route: 'subscription',
          recorded_at: '2026-07-20T10:00:00.000Z',
          immutable: true,
          calls: 3,
        },
      ],
    };
    render(<ProjectedSpendMeter meter={buildTeamPlanActualMeter(projectMonthlySpend({}), available)} />);

    expect(screen.getByTestId('actual-spend-value').textContent).toContain('3 bestätigte Einsätze');
    expect(screen.getByTestId('actual-spend-value').textContent).toContain('Abo-Lane');
    const proof = screen.getByTestId('actual-usage-provenance').querySelector('[data-ledger-event-id]');
    expect(proof?.getAttribute('data-agent-id')).toBe('content-writer');
    expect(proof?.getAttribute('data-period')).toBe('2026-07');
    expect(proof?.getAttribute('data-route')).toBe('subscription');
    expect(proof?.getAttribute('data-ledger-event-id')).toBe('ledger-evt-1');
    expect(proof?.getAttribute('data-routing-receipt-id')).toBe('routing-receipt-1');
  });
});
