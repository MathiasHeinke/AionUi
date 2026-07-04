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

import {
  EVE_TEAM_ROSTER,
  type EveTeamRole,
  type EveTeamRoleTier,
} from '@/common/config/eveTeamRoster';
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
import {
  evaluateBudgetGate,
  projectMonthlySpend,
} from '@/common/config/eveTeamBudgetCore';
import { buildWorkerAssignment, type EveWorkerKind } from '@/common/config/eveWorkerAssignmentCore';
import { ipcBridge } from '@/common';
import { useConfig } from '@renderer/hooks/config/useConfig';
import ProjectedSpendMeter from '@renderer/components/team/ProjectedSpendMeter';
import { Button, Card, Message, Popconfirm, Select, Tag } from '@arco-design/web-react';
import { Pause, PlayOne, Power, UserPositioning } from '@icon-park/react';
import React, { useCallback, useMemo } from 'react';

/** German level label for an EVE tier (the user never sees a raw model id). */
const TIER_LABEL_DE: Record<EveTeamRoleTier, string> = {
  standard: 'Standard',
  high: 'Hoch',
  max: 'Max',
  maximum: 'Maximum',
};

/** Paid levels carry a subtle credit marker (mirrors the inference picker). */
const TIER_CONSUMES_CREDITS: Record<EveTeamRoleTier, boolean> = {
  standard: false,
  high: false,
  max: true,
  maximum: true,
};

/** German label for a worker status badge. */
const STATUS_LABEL_DE: Record<EveTeamWorkerStatus, string> = {
  active: 'Aktiv',
  paused: 'Gedrosselt',
  off: 'Aus',
};

const STATUS_COLOR: Record<EveTeamWorkerStatus, string> = {
  active: 'green',
  paused: 'orange',
  off: 'gray',
};

/**
 * SG-1 A6 — the HONEST lane state of a work role. Three states, none claiming more
 * than it knows: the free floor runs locally (its own green tag already says so);
 * a Claude-CLI worker runs on the operator's SUBSCRIPTION (no metered per-role
 * credits); everything else is EVE herself on the shared account. Per-role € metering
 * (the "Metered, attribuiert" token lane) is deliberately NOT claimed here — it
 * arrives with the 1.8 wheel train, so the card never promises attribution it can't
 * yet deliver.
 */
function laneState(
  workerKind: EveWorkerKind | null,
  isFloor: boolean
): { label: string; title: string } | null {
  if (isFloor) return null; // the free-floor tag already communicates "Gratis · Lokal".
  if (workerKind === 'claude') {
    return {
      label: 'Abo-Lane',
      title: 'Läuft auf deinem eigenen Claude-Abo — keine Extra-Credits pro Rolle.',
    };
  }
  return {
    label: 'EVE-Konto',
    title: 'EVE übernimmt das auf dem gemeinsamen Guthaben. Eine Kostenaufteilung pro Rolle kommt mit einem späteren Update.',
  };
}

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
  // Governance seats are permanent — no on/off control.
  if (role.kind === 'governance') {
    return <Tag size='small'>Immer im Dienst</Tag>;
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
          title='Über dem Basis-Budget'
          content={`${role.displayName} einstellen bringt deine voraussichtlichen Kosten auf ${Math.round(
            budget.projectedEur
          )}€/Mon. — ${Math.round(budget.overageEur)}€ über dem enthaltenen Basis-Budget (${Math.round(
            budget.hullEur
          )}€). Zusätzliche Kosten fallen an. Trotzdem einstellen?`}
          okText='Trotzdem einstellen'
          cancelText='Abbrechen'
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
      <Button size='mini' status={action === 'stop' || action === 'release' ? 'warning' : 'default'} icon={icon}>
        {label}
      </Button>
    );
    if (decision.requiresWarning) {
      // The non-empty-floor warning. Keep a free local worker — never empty.
      return (
        <Popconfirm
          key={action}
          title='Dein letzter Mitarbeiter geht'
          content='Einen kostenlosen Local-Worker behalten? Deine Firma bleibt nie ganz leer — der gratis Hauspförtner läuft weiter.'
          okText='Trotzdem, Floor behalten'
          cancelText='Abbrechen'
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
          ? renderDeactivate('pause', 'Drosseln', <Pause theme='outline' size='12' />)
          : renderActivate(
              'resume',
              'Fortsetzen',
              <Button size='mini' type='outline' icon={<PlayOne theme='outline' size='12' />}>
                Fortsetzen
              </Button>
            )}
        {status !== 'off' ? renderDeactivate('stop', 'Pausieren', <Power theme='outline' size='12' />) : null}
      </div>
    );
  }

  // burst: Einstellen für Sprint / Entlassen.
  return (
    <div className='flex items-center gap-1 flex-wrap'>
      {status === 'active'
        ? renderDeactivate('release', 'Entlassen', <Power theme='outline' size='12' />)
        : renderActivate(
            'hire',
            'Für Sprint einstellen',
            <Button size='mini' type='primary' icon={<UserPositioning theme='outline' size='12' />}>
              Für Sprint einstellen
            </Button>
          )}
    </div>
  );
};

/** The card's worker choice. 'eve' = the EVE-Runtime default (no assignment row). */
type RoleWorkerChoice = 'eve' | EveWorkerKind;

interface RoleCardProps {
  role: EveTeamRole;
  statuses: EveTeamWorkerStatusMap;
  /** Persisted `commandEve.workerAssignments` value shape (agent_id is the key). */
  workerKind: EveWorkerKind | null;
  onAction: (role: EveTeamRole, action: EveTeamControlAction) => void;
  onWorkerChange: (role: EveTeamRole, choice: RoleWorkerChoice) => void;
}

const RoleCard: React.FC<RoleCardProps> = ({ role, statuses, workerKind, onAction, onWorkerChange }) => {
  const consumesCredits = TIER_CONSUMES_CREDITS[role.tier];
  const status = statusForRole(role, statuses);
  const isFloor = isFreeFloorWorker(role);
  return (
    <Card className='w-full mb-2' size='small' bordered data-agent-id={role.agent_id}>
      <div className='flex items-start gap-3'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 mb-1 flex-wrap'>
            <span className='font-medium text-t-primary'>{role.displayName}</span>
            <span className='text-xs text-t-secondary'>{role.title}</span>
            {role.kind === 'governance' ? (
              <Tag color='arcoblue' size='small'>
                Führung
              </Tag>
            ) : null}
            {isFloor ? (
              <Tag color='green' size='small'>
                Gratis · Lokal · Immer da
              </Tag>
            ) : null}
            <Tag size='small' color={consumesCredits ? 'orange' : 'gray'}>
              {TIER_LABEL_DE[role.tier]}
              {consumesCredits ? ' · verbraucht Credits' : ''}
            </Tag>
            {role.kind === 'work' ? (
              <Tag size='small' color={STATUS_COLOR[status]} bordered>
                {STATUS_LABEL_DE[status]}
              </Tag>
            ) : null}
            {role.kind === 'work'
              ? (() => {
                  const lane = laneState(workerKind, isFloor);
                  return lane ? (
                    <Tag size='small' color='gray' bordered title={lane.title} data-testid='role-lane-state'>
                      {lane.label}
                    </Tag>
                  ) : null;
                })()
              : null}
          </div>
          <div className='text-sm text-t-primary mb-2'>{role.outcome}</div>
          <div className='flex items-center gap-1 flex-wrap mb-2'>
            {role.skills.map((skill) => (
              <Tag key={skill} size='small' bordered>
                {skill}
              </Tag>
            ))}
          </div>
          <RoleControls role={role} status={status} statuses={statuses} onAction={onAction} />
          {/* 1.6.3 (Founder-UX): the worker binding lives ON the role card — the
              separate "Agenten & Belegschaft" dialog stays as the expert view
              (cli_path/version). Same persisted key, same validator; the image
              lane is not offered here (a foreign persisted kind falls back to
              the default display). GOVERNANCE seats carry no row (review fix:
              "EVE nutzt jetzt Claude" on the EVE card claimed a main-turn swap
              that never happens — the main turn always stays on EVE-Runtime). */}
          {role.kind !== 'governance' && (
            <div className='mt-2 flex items-center gap-2' data-testid='role-worker-row'>
              <span className='text-xs text-t-secondary'>Worker:</span>
              <Select
                size='mini'
                style={{ width: 210 }}
                value={(workerKind === 'claude' || workerKind === 'codex' ? workerKind : 'eve') as RoleWorkerChoice}
                onChange={(value) => onWorkerChange(role, value as RoleWorkerChoice)}
                data-testid='role-worker-select'
              >
                <Select.Option value='eve'>EVE-Runtime (Standard)</Select.Option>
                <Select.Option value='claude'>Claude-CLI</Select.Option>
                <Select.Option value='codex' disabled>
                  Codex-CLI — bald verfügbar
                </Select.Option>
              </Select>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

/**
 * Read-write Dein-Team panel. Lists the curated roster — governance seats first,
 * then operators — and exposes the rhythm-correct controls. The non-empty-floor
 * guard is enforced by the pure reducer before anything is persisted.
 */
const DeinTeamPanel: React.FC = () => {
  const [persisted, setPersisted] = useConfig('commandEve.teamWorkerStatus');
  const statuses: EveTeamWorkerStatusMap = useMemo(() => persisted ?? {}, [persisted]);
  // 1.6.3: the SAME persisted map the expert dialog writes — one source of truth.
  const [assignments, setAssignments] = useConfig('commandEve.workerAssignments');

  const workerKindFor = useCallback(
    (agentId: string): EveWorkerKind | null => {
      const entry = (assignments ?? {})[agentId] as { kind?: EveWorkerKind } | undefined;
      return entry?.kind ?? null;
    },
    [assignments]
  );

  const handleWorkerChange = useCallback(
    (role: EveTeamRole, choice: RoleWorkerChoice) => {
      const current = { ...((assignments ?? {}) as Record<string, { kind: EveWorkerKind; cli_path?: string; cli_version?: string }>) };
      const isRevoke = choice === 'eve';
      if (isRevoke && !(role.agent_id in current)) return;
      if (isRevoke) {
        delete current[role.agent_id];
      } else {
        const assignment = buildWorkerAssignment({ agent_id: role.agent_id, kind: choice });
        if (!assignment) return; // validator refused (never persist an invented binding)
        current[role.agent_id] = { kind: assignment.kind, ...(assignment.cli_path ? { cli_path: assignment.cli_path } : {}), ...(assignment.cli_version ? { cli_version: assignment.cli_version } : {}) };
      }
      // M2 (audit): AWAIT the write — a backend failure must not show a false
      // "now via …" success. H12 (audit): after the write lands, nudge main to
      // rewrite the derived launcher state so a REVOKED role's stale .status/.token
      // are removed (its old launcher then fail-closes) and a new binding is wired.
      // Sequenced: the sync re-reads the backend, so it must run AFTER the PUT.
      void (async () => {
        try {
          await Promise.resolve(setAssignments(current));
        } catch {
          Message.error('Die Zuweisung konnte nicht gespeichert werden.');
          return;
        }
        if (isRevoke) {
          Message.info(`${role.displayName} läuft wieder über die EVE-Runtime.`);
        } else {
          // Precise claim: the binding affects DELEGATED tasks of this role — EVE's
          // main turn always stays on the EVE-Runtime.
          Message.success(`Delegierte Aufgaben von ${role.displayName} laufen jetzt über die ${choice === 'claude' ? 'Claude-CLI' : 'Codex-CLI'} — Einsatz bleibt über Status und Freigabe-Stufe gesteuert.`);
        }
        void ipcBridge.commandEve.syncWorkerLauncherState.invoke().catch(() => {});
      })();
    },
    [assignments, setAssignments]
  );

  const { governance, operators } = useMemo(() => {
    const governance: EveTeamRole[] = [];
    const operators: EveTeamRole[] = [];
    for (const role of EVE_TEAM_ROSTER) {
      (role.kind === 'governance' ? governance : operators).push(role);
    }
    return { governance, operators };
  }, []);

  // Live PRE-VISIBLE projection (P0 #1): the running month-end spend = sum of the
  // ACTIVE workers' grade salaries, recomputed from the persisted status map.
  const projection = useMemo(() => projectMonthlySpend(statuses), [statuses]);

  const handleAction = useCallback(
    (role: EveTeamRole, action: EveTeamControlAction) => {
      // The Popconfirm has already surfaced any required warning; confirm here so
      // the reducer applies (or keeps the floor). The pure reducer is the single
      // source of truth for the resulting state — it can never go empty.
      const { next, decision } = applyControlAction(role, action, statuses, { confirmedWarning: true });
      if (decision.resolution === 'keep-floor') {
        Message.info('Der kostenlose Hauspförtner bleibt an — deine Firma ist nie ganz leer.');
      } else if (decision.resolution === 'restore-floor') {
        Message.info('Letzter bezahlter Mitarbeiter weg — der gratis Hauspförtner übernimmt den Empfang.');
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
    [statuses, setPersisted]
  );

  return (
    <div className='w-full'>
      <div className='mb-3'>
        <div className='text-base font-medium text-t-primary'>Dein Team</div>
        <div className='text-sm text-t-secondary'>
          Ein festes, kuratiertes Team. EVE verteilt die Arbeit an die passende Rolle. Dauer-Mitarbeiter kannst du
          drosseln oder pausieren; Sprint-Kräfte für einen Push einstellen und wieder entlassen. Ein gratis lokaler
          Mitarbeiter bleibt immer an — deine Firma ist nie leer.
        </div>
      </div>
      {/* PRE-VISIBLE projected-budget meter (P0 #1): always-on running total of
          what the active team will cost this month vs the included base hull. */}
      <ProjectedSpendMeter projection={projection} />
      {governance.length > 0 ? (
        <div className='mb-3'>
          <div className='text-xs uppercase tracking-wide text-t-secondary mb-1'>Führung</div>
          {governance.map((role) => (
            <RoleCard key={role.agent_id} role={role} statuses={statuses} workerKind={workerKindFor(role.agent_id)} onAction={handleAction} onWorkerChange={handleWorkerChange} />
          ))}
        </div>
      ) : null}
      {operators.length > 0 ? (
        <div>
          <div className='text-xs uppercase tracking-wide text-t-secondary mb-1'>Rollen</div>
          {operators.map((role) => (
            <RoleCard key={role.agent_id} role={role} statuses={statuses} workerKind={workerKindFor(role.agent_id)} onAction={handleAction} onWorkerChange={handleWorkerChange} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default DeinTeamPanel;
