/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Dein Team" — the curated A-roster surface with rhythm-correct controls.
 *
 * HONEST-A: this presents a FIXED, curated team straight — it is NOT an
 * assemble-your-own-company builder. There is no add/remove of roles, no
 * marketplace. What it DOES expose is the two rhythm-correct controls per the
 * pre-mortem, keyed off each role's {@link EveTeamRole.rhythm}:
 *
 *   - always-on workers → Pause / Drosseln (throttle). They stay members of the
 *     company; you never "feuern" them.
 *   - burst workers     → Einstellen für Sprint / Entlassen (hire / let go).
 *
 * NON-EMPTY FLOOR (P0 #2): the base always keeps at least one free local
 * always-on worker (the Hauspförtner / FAQ, G0). Before deactivating the LAST
 * active worker, the panel warns and keeps the free floor — the company is never
 * empty. All the floor logic is the pure {@link applyControlAction} reducer; the
 * panel only renders its decision and persists the result.
 *
 * The roster is pure DATA from {@link EVE_TEAM_ROSTER}; active/paused state is
 * persisted via the existing config service (`commandEve.teamWorkerStatus`).
 *
 * ENFORCEMENT (DUX-4): the persisted status is not cosmetic — the EVE-cloud
 * send path READS it and refuses to dispatch a paused/off delegated worker (see
 * {@link evaluateWorkerDispatch} in eveTeamControlsCore, wired through the shim
 * via the main-process team-status resolver). So pausing/throttling/firing a
 * worker actually stops it being used on the cloud lane — not just a label.
 */

import { EVE_TEAM_ROSTER, type EveTeamRole, type EveTeamRoleTier } from '@/common/config/eveTeamRoster';
import {
  applyControlAction,
  controlKindForRole,
  evaluateFloorGuard,
  isFreeFloorWorker,
  statusForRole,
  type EveTeamControlAction,
  type EveTeamWorkerStatus,
  type EveTeamWorkerStatusMap,
} from '@/common/config/eveTeamControlsCore';
import { buildTeamPlanActualMeter, evaluateBudgetGate, projectMonthlySpend } from '@/common/config/eveTeamBudgetCore';
import { ipcBridge } from '@/common';
import { useConfig } from '@renderer/hooks/config/useConfig';
import { useSeatUsage } from '@renderer/hooks/useSeatUsage';
import ProjectedSpendMeter from '@renderer/components/team/ProjectedSpendMeter';
import { Button, Message, Popconfirm, Tag } from '@arco-design/web-react';
import { Pause, PlayOne, Power, UserPositioning } from '@icon-park/react';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Paid levels carry a subtle credit marker (mirrors the inference picker). */
const TIER_CONSUMES_CREDITS: Record<EveTeamRoleTier, boolean> = {
  standard: false,
  high: false,
  max: true,
  maximum: true,
};

const STATUS_COLOR: Record<EveTeamWorkerStatus, string> = {
  active: 'green',
  paused: 'gray',
  off: 'gray',
};

interface RoleControlsProps {
  role: EveTeamRole;
  status: EveTeamWorkerStatus;
  statuses: EveTeamWorkerStatusMap;
  onAction: (role: EveTeamRole, action: EveTeamControlAction) => void;
}

/**
 * The rhythm-correct control cluster for a role. always-on roles get
 * Pause/Drosseln + Aus; burst roles get Einstellen/Entlassen. Governance seats
 * are never deactivatable (the company always has its leadership) — they show no
 * control.
 */
const RoleControls: React.FC<RoleControlsProps> = ({ role, status, statuses, onAction }) => {
  const { t } = useTranslation();
  const roleName = t(`deinTeam.roles.${role.agent_id}.name`, { defaultValue: role.displayName });
  // Governance seats are permanent — no on/off control.
  if (role.kind === 'governance') {
    return <Tag size='small'>{t('deinTeam.controls.alwaysOn')}</Tag>;
  }

  const controlKind = controlKindForRole(role);

  // Build a guarded ACTIVATE (hire / resume) button: cap-and-ask STOPS AT the
  // budget line — if activating this paid worker would push the projected
  // month-end spend over the included base hull, wrap it in a Popconfirm so the
  // user confirms the overage BEFORE it is incurred. Within budget → fire direct.
  const renderActivate = (
    action: Extract<EveTeamControlAction, 'hire' | 'resume'>,
    label: string,
    button: React.ReactElement<React.ComponentProps<typeof Button>>
  ) => {
    const budget = evaluateBudgetGate(role, action, statuses);
    if (budget.requiresWarning) {
      return (
        <Popconfirm
          key={action}
          title={t('deinTeam.confirm.budgetTitle')}
          content={t('deinTeam.confirm.budgetBody', {
            role: roleName,
            projected: Math.round(budget.projectedEur),
            overage: Math.round(budget.overageEur),
            hull: Math.round(budget.hullEur),
          })}
          okText={t('deinTeam.confirm.hireAnyway')}
          cancelText={t('deinTeam.controls.cancel')}
          onOk={() => onAction(role, action)}
        >
          {React.cloneElement(button, { key: action })}
        </Popconfirm>
      );
    }
    return React.cloneElement(button, { key: action, onClick: () => onAction(role, action) });
  };

  // Build a guarded deactivation button: if the floor guard requires a warning,
  // wrap it in a Popconfirm; otherwise fire directly.
  const renderDeactivate = (action: EveTeamControlAction, label: string, icon: React.ReactNode) => {
    const decision = evaluateFloorGuard(role, action, statuses);
    const button = (
      <Button size='mini' status='default' icon={icon}>
        {label}
      </Button>
    );
    if (decision.requiresWarning) {
      // The non-empty-floor warning. Keep a free local worker — never empty.
      return (
        <Popconfirm
          key={action}
          title={t('deinTeam.confirm.floorTitle')}
          content={t('deinTeam.confirm.floorBody')}
          okText={t('deinTeam.confirm.keepFloor')}
          cancelText={t('deinTeam.controls.cancel')}
          onOk={() => onAction(role, action)}
        >
          {button}
        </Popconfirm>
      );
    }
    return React.cloneElement(button, { key: action, onClick: () => onAction(role, action) });
  };

  if (controlKind === 'pause-throttle') {
    // always-on: Pause / Drosseln (+ resume + fully off). NEVER "feuern".
    return (
      <div className='flex items-center gap-1 flex-wrap'>
        {status === 'active'
          ? renderDeactivate('pause', t('deinTeam.controls.throttle'), <Pause theme='outline' size='12' />)
          : renderActivate(
              'resume',
              t('deinTeam.controls.resume'),
              <Button size='mini' type='outline' icon={<PlayOne theme='outline' size='12' />}>
                {t('deinTeam.controls.resume')}
              </Button>
            )}
        {status !== 'off'
          ? renderDeactivate('stop', t('deinTeam.controls.pause'), <Power theme='outline' size='12' />)
          : null}
      </div>
    );
  }

  // burst: Einstellen für Sprint / Entlassen.
  return (
    <div className='flex items-center gap-1 flex-wrap'>
      {status === 'active'
        ? renderDeactivate('release', t('deinTeam.controls.release'), <Power theme='outline' size='12' />)
        : renderActivate(
            'hire',
            t('deinTeam.controls.hireForSprint'),
            <Button size='mini' type='primary' icon={<UserPositioning theme='outline' size='12' />}>
              {t('deinTeam.controls.hireForSprint')}
            </Button>
          )}
    </div>
  );
};

interface RoleCardProps {
  role: EveTeamRole;
  statuses: EveTeamWorkerStatusMap;
  onAction: (role: EveTeamRole, action: EveTeamControlAction) => void;
}

const RoleCard: React.FC<RoleCardProps> = ({ role, statuses, onAction }) => {
  const { t } = useTranslation();
  const consumesCredits = TIER_CONSUMES_CREDITS[role.tier];
  const status = statusForRole(role, statuses);
  const isFloor = isFreeFloorWorker(role);
  const roleName = t(`deinTeam.roles.${role.agent_id}.name`, { defaultValue: role.displayName });
  const roleTitle = t(`deinTeam.roles.${role.agent_id}.title`, { defaultValue: role.title });
  const roleOutcome = t(`deinTeam.roles.${role.agent_id}.outcome`, { defaultValue: role.outcome });
  return (
    <div className='eve-settings-group w-full' data-agent-id={role.agent_id}>
      <div className='flex items-start gap-3'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 mb-1 flex-wrap'>
            <span className='font-medium text-t-primary'>{roleName}</span>
            <span className='text-xs text-t-secondary'>{roleTitle}</span>
            {role.kind === 'governance' ? (
              <Tag color='arcoblue' size='small'>
                {t('deinTeam.labels.leadership')}
              </Tag>
            ) : null}
            {isFloor ? (
              <Tag color='green' size='small'>
                {t('deinTeam.labels.freeLocalAlwaysOn')}
              </Tag>
            ) : null}
            <Tag size='small' color='gray'>
              {t(`deinTeam.tiers.${role.tier}`)}
              {consumesCredits ? ` · ${t('deinTeam.labels.consumesCredits')}` : ''}
            </Tag>
            {role.kind === 'work' ? (
              <Tag size='small' color={STATUS_COLOR[status]} bordered>
                {t(`deinTeam.status.${status}`)}
              </Tag>
            ) : null}
          </div>
          <div className='text-sm text-t-primary mb-2'>{roleOutcome}</div>
          <div className='flex items-center gap-1 flex-wrap mb-2'>
            {role.skills.map((skill) => (
              <Tag key={skill} size='small' bordered>
                {t(`deinTeam.skills.${skill}`, { defaultValue: t('deinTeam.skills.unknown') })}
              </Tag>
            ))}
          </div>
          <RoleControls role={role} status={status} statuses={statuses} onAction={onAction} />
        </div>
      </div>
    </div>
  );
};

/**
 * Read-write Dein-Team panel. Lists the curated roster — governance seats first,
 * then operators — and exposes the rhythm-correct controls. The non-empty-floor
 * guard is enforced by the pure reducer before anything is persisted.
 */
const DeinTeamPanel: React.FC = () => {
  const { t } = useTranslation();
  const [persisted, setPersisted] = useConfig('commandEve.teamWorkerStatus');
  const statuses: EveTeamWorkerStatusMap = useMemo(() => persisted ?? {}, [persisted]);
  const { agentUsage } = useSeatUsage();

  const { governance, operators } = useMemo(() => {
    const governanceRoles: EveTeamRole[] = [];
    const operatorRoles: EveTeamRole[] = [];
    for (const role of EVE_TEAM_ROSTER) {
      (role.kind === 'governance' ? governanceRoles : operatorRoles).push(role);
    }
    return { governance: governanceRoles, operators: operatorRoles };
  }, []);

  // Live PRE-VISIBLE projection (P0 #1): the running month-end spend = sum of the
  // ACTIVE workers' grade salaries, recomputed from the persisted status map.
  const projection = useMemo(() => projectMonthlySpend(statuses), [statuses]);
  const planActualMeter = useMemo(() => buildTeamPlanActualMeter(projection, agentUsage), [projection, agentUsage]);

  const handleAction = useCallback(
    (role: EveTeamRole, action: EveTeamControlAction) => {
      // The Popconfirm has already surfaced any required warning; confirm here so
      // the reducer applies (or keeps the floor). The pure reducer is the single
      // source of truth for the resulting state — it can never go empty.
      const { next, decision } = applyControlAction(role, action, statuses, { confirmedWarning: true });
      if (decision.resolution === 'keep-floor') {
        Message.info(t('deinTeam.messages.floorKept'));
      } else if (decision.resolution === 'restore-floor') {
        Message.info(t('deinTeam.messages.floorRestored'));
      }
      // SG-1 A3: the authoritative status write MUST land BEFORE we nudge main to
      // rewrite the derived launcher status files — the sync IPC re-reads the
      // backend, so firing it un-sequenced races the PUT and can rewrite a STALE
      // 'active' file (a just-paused delegate role would keep spawning). Await the
      // write, THEN refresh. Both best-effort: neither blocks the UI.
      void (async () => {
        await Promise.resolve(setPersisted(next as Record<string, 'active' | 'paused' | 'off'>)).catch(() => {});
        await ipcBridge.commandEve.syncWorkerLauncherState.invoke().catch(() => {});
      })();
    },
    [statuses, setPersisted, t]
  );

  return (
    <div className='w-full'>
      {/* Plan stays a roster salary-band plan. Actual is rendered only from a
          complete, current SG-1 agent/period/route ledger proof. */}
      <ProjectedSpendMeter meter={planActualMeter} />
      {governance.length > 0 ? (
        <div className='mb-3'>
          <div className='text-xs uppercase tracking-wide text-t-secondary mb-1'>
            {t('deinTeam.sections.leadership')}
          </div>
          {governance.map((role) => (
            <RoleCard key={role.agent_id} role={role} statuses={statuses} onAction={handleAction} />
          ))}
        </div>
      ) : null}
      {operators.length > 0 ? (
        <div>
          <div className='text-xs uppercase tracking-wide text-t-secondary mb-1'>{t('deinTeam.sections.roles')}</div>
          {operators.map((role) => (
            <RoleCard key={role.agent_id} role={role} statuses={statuses} onAction={handleAction} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default DeinTeamPanel;
