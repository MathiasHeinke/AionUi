/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SeatRail — the far-left, collapsible bar of Seeds (Command EVE).
 *
 * Each seat the admin owns is a colored circle (collapsed: a dot inside a real tap
 * target; expanded: a circle with the client's initials). The ACTIVE seat is ringed;
 * clicking another seat switches the whole app to it (same authoritative path as the
 * SeatSwitcher: useSeatAccess.switchTo drives the main-process stop + re-spawn under
 * the new HERMES_HOME). The "+" (pinned to the bottom) provisions a free Seed
 * directly in the app at no extra cost. Every Seed consumes the same account
 * credit pool and retains its own usage attribution.
 *
 * SECURITY / VISIBILITY: renders ONLY for an admin. useSeatAccess is fail-closed —
 * a delegate, a single-seat legacy install, or no bridge all resolve to
 * role='delegate' (hidden). MAT-1773: a FAILED my-seats read no longer hides the
 * rail when local main-derived evidence says the account is an admin — the rail
 * then shows the DEGRADED posture (own seat + "+", canSwitch=false, never a
 * fabricated seat). The switch IPC re-checks authorization in main against a
 * fresh read, so the rail is defense-in-depth display, not the boundary.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Message, Modal, Tooltip } from '@arco-design/web-react';
import { ExpandLeft, ExpandRight, Plus } from '@icon-park/react';
import {
  isAnyGenerating,
  ensureAcpGenerationTracking,
  clearGenerationForBackendRespawn,
} from '@renderer/services/commandEveGenerationActivity';
import CommandEveGlyph from '@renderer/components/commandEve/CommandEveGlyph';
import { useTranslation } from 'react-i18next';
import { useSeatAccess } from '@renderer/hooks/useSeatAccess';
import { useSeedLifecycle } from '@renderer/hooks/useSeedLifecycle';
import { commandEve } from '@/common/adapter/ipcBridge';
// From the SHARED renderer-safe home — never from the main-process fetch module
// (a runtime import of `@process/...` black-screened the packaged app on boot).
import { isDeadSessionFailure } from '@/common/config/seatWireFailureCore';
import '@renderer/styles/seatRail.css';

// A fixed palette. The seat's color is deterministic from its id (FNV-1a hash) so the
// SAME client always gets the SAME color across launches. (Light swatches are kept;
// the initials color is chosen per-seat by luminance so contrast always clears AA.)
// Every swatch is chosen so the BETTER of {white, #1d2129} initials clears WCAG AA
// (4.5:1). The two mid-luminance teals were darkened (cyan-600 #0891b2→#0e7490 5.36:1,
// teal-600 #0d9488→#0f766e 5.47:1) because at -600 NEITHER ink reached 4.5:1.
const SEAT_PALETTE = [
  '#2563eb',
  '#0e7490',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#15803d',
  '#0f766e',
  '#9333ea',
  '#dc2626',
  '#ca8a04',
];

export function seatColor(key: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit, stable across runs/platforms.
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SEAT_PALETTE[Math.abs(h) % SEAT_PALETTE.length];
}

const DARK_INK = '#1d2129';
const linearizeSrgb = (value: number): number =>
  value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

function relLuminance(hex: string): number {
  const c = hex.replace('#', '');
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255;
  return 0.2126 * linearizeSrgb(ch(0)) + 0.7152 * linearizeSrgb(ch(2)) + 0.0722 * linearizeSrgb(ch(4));
}

// WCAG contrast ratio between two hex colors (1..21).
function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// White or near-black initials, whichever ACTUALLY has the higher contrast on this
// seat color. (The old `L > 0.45` threshold was unreachable — every palette swatch
// sits below it — so it always picked white, leaving amber #ca8a04 at 2.94:1, an AA
// fail. Comparing the two real ratios yields dark ink on amber/teal/orange-600 and
// clears AA 4.5:1 on every swatch.)
export function contrastText(hex: string): string {
  return contrastRatio(hex, DARK_INK) >= contrastRatio(hex, '#ffffff') ? DARK_INK : '#ffffff';
}

export function seatInitials(name: string): string {
  // Split on whitespace AND hyphen/underscore so "Müller-Bau" → "MB", not "MÜ".
  const words = (name ?? '')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// Reason-code → human German string for a failed/rolled-back switch. A switch is the
// most consequential rail action (it re-homes the whole app to another client), so a
// silent failure is the worst outcome — the admin must SEE that they are still on the
// previous client. Unknown codes fall back to a generic failure line.
function switchErrorMessage(code: string): string {
  switch (code) {
    case 'SWITCH_SEAT_FORBIDDEN':
      return 'Kein Zugriff auf diesen Kunden-Seat.';
    case 'SWITCH_SEAT_TIMEOUT':
      return 'Der Wechsel hat zu lange gedauert — EVE bleibt vorerst beim bisherigen Kunden.';
    case 'SWITCH_SEAT_IN_PROGRESS':
      return 'Ein Kunden-Wechsel läuft bereits. Bitte kurz warten.';
    case 'SWITCH_SEAT_NO_BRIDGE':
      return 'Kunden-Wechsel ist hier nicht verfügbar.';
    case 'SWITCH_SEAT_RECOVERY_REQUIRED':
      return 'Der Kunden-Wechsel ist nicht sicher abgeschlossen. Starte Command EVE neu und arbeite bis dahin in keinem Kunden-Seat weiter.';
    case 'SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN':
      // Hotfix-B: the switch failed AND the backend could not be restarted — do NOT
      // claim "EVE läuft weiter" (it does NOT). Tell the operator a relaunch is needed.
      return 'Kunden-Wechsel fehlgeschlagen und der EVE-Dienst konnte nicht neu gestartet werden. Bitte starte Command EVE neu.';
    default:
      // SWITCH_SEAT_FAILED / SWITCH_SEAT_BRIDGE_FAILED / SWITCH_SEAT_NO_TARGET /
      // SEAT_SWITCH_RESPAWN_FAILED (rolled back, backend restarted — EVE IS live) / …
      return 'Kunden-Wechsel fehlgeschlagen — EVE läuft weiter auf dem bisherigen Kunden. Bitte erneut versuchen.';
  }
}

export interface SeatRailProps {
  /** Keep the same authoritative rail reachable on narrow layouts without taking 72px. */
  compact?: boolean;
}

const SeatRail: React.FC<SeatRailProps> = ({ compact = false }) => {
  const { t } = useTranslation();
  const { loading, access, switching, switchTo, lastSwitchError, switchErrorNonce, mySeatsWireError, refresh } =
    useSeatAccess();
  const { provisioning, retryPending, createSeed, resetCreateAttempt } = useSeedLifecycle();
  const [expanded, setExpanded] = useState(true);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [createSeedVisible, setCreateSeedVisible] = useState(false);
  const [seedName, setSeedName] = useState('');
  const [seedCreateAnnouncement, setSeedCreateAnnouncement] = useState('');

  const visible = !loading && access.role === 'admin';
  // MAT-1773 follow-up: the rail fail-closed because the my-seats read died on a
  // DEAD stored account session (refresh rejected / store undecryptable) — the
  // one failure a fresh sign-in repairs. Offer exactly that, in the rail's
  // place, instead of hiding without a trace. A genuine no-account install
  // (NO_SESSION) and transient read failures (network/http/malformed) still
  // render nothing, byte-identical to before.
  const sessionRecovery = !visible && !loading && isDeadSessionFailure(mySeatsWireError);
  const renderedExpanded = !compact && expanded;

  const reauthLabel = t('commandEve.seatRail.reauth', 'Erneut anmelden, um Kundenplätze zu laden');
  const handleReauth = useCallback(async () => {
    setReauthenticating(true);
    try {
      await commandEve.authWebLogin.invoke({ intent: 'login' });
      // A fresh session is now stored; re-read the wire so the rail populates.
      await refresh();
    } catch {
      // Self-quiet: the next focus/poll reconcile re-reads either way.
    } finally {
      setReauthenticating(false);
    }
  }, [refresh]);

  // 1.7.3 (Codex #1): make sure the global ACP generation tracker is attached from
  // the moment the seat rail exists — BEFORE any switch — so isAnyGenerating() is
  // correct even for a turn streaming under a conversation view that is not mounted.
  // Idempotent; a no-op once the bridge-backed listener is live.
  useEffect(() => {
    ensureAcpGenerationTracking();
  }, []);

  // Publish the rail's current width so the global toast offset (layout.css) keeps
  // content centered for admins. 0 when hidden/unmounted (non-admins unaffected).
  useEffect(() => {
    const railVisible = visible || sessionRecovery;
    const root = document.documentElement;
    root.style.setProperty('--seat-rail-width', railVisible ? (renderedExpanded && visible ? '72px' : '40px') : '0px');
    return () => root.style.setProperty('--seat-rail-width', '0px');
  }, [visible, sessionRecovery, renderedExpanded]);

  // SURFACE a failed switch (CONFIRMED-HIGH fix). useSeatAccess nulls lastSwitchError
  // at the start of every switchTo and sets it on each failure path, so null→code is a
  // real transition that fires this effect once per failed attempt. Without this the
  // admin clicks a client, the switch rolls back, the ring snaps to the old seat, and
  // they see NOTHING — believing they are on the new client when they are not.
  useEffect(() => {
    if (!lastSwitchError) return;
    Message.error({ content: switchErrorMessage(lastSwitchError), duration: 4500 });
    // switchErrorNonce in deps ⇒ a repeated identical reject code still re-fires.
  }, [lastSwitchError, switchErrorNonce]);

  // Admins only (see the security note above). The ONE exception: a dead stored
  // account session, where the rail's slot shows a single re-authenticate
  // affordance — a fresh sign-in re-stores the session and the live read below
  // populates the rail. Everything else renders nothing.
  if (!visible) {
    if (!sessionRecovery) return null;
    return (
      <nav
        className='command-eve-seat-rail command-eve-seat-rail--collapsed'
        data-testid='seat-rail-recovery'
        aria-label={reauthLabel}
      >
        <div className='seat-rail__brand' aria-hidden='true'>
          <CommandEveGlyph size={22} />
        </div>
        <Tooltip content={reauthLabel} position='right' trigger={['hover', 'focus']}>
          <button
            type='button'
            className='seat-rail__toggle'
            data-testid='seat-rail-reauth'
            aria-label={reauthLabel}
            aria-busy={reauthenticating || undefined}
            disabled={reauthenticating}
            onClick={() => void handleReauth()}
          >
            <ExpandRight size={16} aria-hidden='true' />
          </button>
        </Tooltip>
      </nav>
    );
  }

  const toggleLabel = renderedExpanded
    ? t('commandEve.seatRail.collapse', 'Leiste einklappen')
    : t('commandEve.seatRail.expand', 'Leiste ausklappen');

  const closeCreateSeed = () => {
    if (provisioning) return;
    setCreateSeedVisible(false);
    // A timed-out request may already have committed server-side. Preserve its
    // name + idempotency key across close/reopen until reconciliation succeeds.
    if (!retryPending) {
      setSeedName('');
      setSeedCreateAnnouncement('');
      resetCreateAttempt();
    }
  };

  const handleCreateSeed = async () => {
    const displayName = seedName.trim();
    if (!displayName) {
      Message.error(t('commandEve.seatRail.createNameRequired', 'Bitte gib dem Seed einen Namen.'));
      return;
    }
    setSeedCreateAnnouncement(
      retryPending
        ? t('commandEve.seatRail.reconciling', 'Seed wird abgeglichen …')
        : t('commandEve.seatRail.provisioning', 'Seed wird erstellt …')
    );
    const result = await createSeed(displayName);
    if (result.ok) {
      await refresh();
      setCreateSeedVisible(false);
      setSeedName('');
      const successMessage =
        result.created === false
          ? t('commandEve.seatRail.reconciled', 'Seed wurde abgeglichen.')
          : t('commandEve.seatRail.created', 'Seed wurde erstellt.');
      setSeedCreateAnnouncement(successMessage);
      Message.success(successMessage);
      return;
    }
    if (result.reasonCode === 'SEED_ABUSE_CEILING_REACHED') {
      const message = t(
        'commandEve.seatRail.abuseCeilingReached',
        'Zu viele automatische Seat-Anlagen. Bitte kontaktiere den Support.'
      );
      setSeedCreateAnnouncement(message);
      Message.error(message);
      return;
    }
    if (result.reasonCode === 'SEED_PROVISION_TIMEOUT') {
      setSeedCreateAnnouncement(
        t(
          'commandEve.seatRail.timeoutRetry',
          'Zeitüberschreitung. Noch einmal abgleichen — es wird kein zweiter Seed erzeugt.'
        )
      );
      return;
    }
    setSeedCreateAnnouncement(t('commandEve.seatRail.createError', 'Seed konnte nicht erstellt werden.'));
    Message.error(t('commandEve.seatRail.createError', 'Seed konnte nicht erstellt werden.'));
  };

  return (
    <>
      <nav
        className={[
          'command-eve-seat-rail',
          renderedExpanded ? 'command-eve-seat-rail--expanded' : 'command-eve-seat-rail--collapsed',
          compact ? 'command-eve-seat-rail--compact' : '',
          switching ? 'command-eve-seat-rail--switching' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid='seat-rail'
        aria-label={t('commandEve.seatRail.label', 'Kunden')}
        aria-busy={switching || undefined}
      >
        {/* Screen-reader mirror of the failure toast — Arco's Message renders NO live
          region, so AT users would otherwise get no signal that a switch rolled back
          (the exact cross-client confusion the toast exists to prevent). Keyed on the
          nonce so role='alert' remounts and re-announces on every failure, including a
          repeated identical reject code. Empty (silent) when there is no error. */}
        <span key={switchErrorNonce} role='alert' className='seat-rail__sr-only' data-testid='seat-rail-live'>
          {lastSwitchError ? switchErrorMessage(lastSwitchError) : ''}
        </span>

        <div className='seat-rail__brand' data-testid='seat-rail-brand' aria-hidden='true'>
          <CommandEveGlyph size={22} />
        </div>

        {!compact && (
          <Tooltip content={toggleLabel} position='right' trigger={['hover', 'focus']}>
            <button
              type='button'
              className='seat-rail__toggle'
              data-testid='seat-rail-toggle'
              aria-label={toggleLabel}
              aria-expanded={renderedExpanded}
              onClick={() => setExpanded((e) => !e)}
            >
              {renderedExpanded ? (
                <ExpandLeft size={16} aria-hidden='true' />
              ) : (
                <ExpandRight size={16} aria-hidden='true' />
              )}
            </button>
          </Tooltip>
        )}

        {/* Only the Seed list scrolls. The toggle (above) and "+" (below) sit outside
          this region so the in-app create affordance stays bottom-pinned. */}
        <div className='seat-rail__seats'>
          {access.seats.map((seat) => {
            const active = seat.seat_id === access.activeSeatId;
            const color = seatColor(seat.seat_id);
            return (
              <Tooltip key={seat.seat_id} content={seat.name} position='right' trigger={['hover', 'focus']}>
                <button
                  type='button'
                  className={active ? 'seat-rail__seat seat-rail__seat--active' : 'seat-rail__seat'}
                  data-testid={`seat-rail-seat-${seat.seat_id}`}
                  aria-label={
                    active ? t('commandEve.seatRail.activeSeat', '{{name}} (aktiv)', { name: seat.name }) : seat.name
                  }
                  aria-current={active ? 'true' : undefined}
                  // aria-disabled (NOT the `disabled` attr) keeps the just-clicked seat in
                  // the tab order, so a keyboard-initiated switch does not drop focus to
                  // <body> mid-transition. The onClick guard below is the real no-op gate.
                  aria-disabled={switching || undefined}
                  onClick={() => {
                    if (active || switching) return;
                    // A committed switch respawns the single backend, which SIGKILLs every
                    // in-flight turn on this seat WITHOUT a terminal stream event. Clear the
                    // generation set at commit time so a killed turn never lingers as a
                    // stuck flag that would nag on every future switch (Codex 1.7.3 #1).
                    const commitSwitch = () => {
                      clearGenerationForBackendRespawn();
                      void switchTo(seat.seat_id);
                    };
                    // 1.7.3: if a response is currently streaming, confirm before interrupting
                    // it — default is to STAY (protect the answer); the operator can still switch.
                    if (isAnyGenerating()) {
                      Modal.confirm({
                        title: t('commandEve.seatRail.switchWhileGeneratingTitle', 'Antwort läuft noch'),
                        content: t(
                          'commandEve.seatRail.switchWhileGeneratingBody',
                          'Beim Seat-Wechsel wird die laufende Antwort abgebrochen und verworfen. Trotzdem wechseln?'
                        ),
                        okText: t('commandEve.seatRail.switchAnyway', 'Trotzdem wechseln'),
                        cancelText: t('common.cancel', 'Abbrechen'),
                        onOk: commitSwitch,
                      });
                      return;
                    }
                    commitSwitch();
                  }}
                >
                  <span
                    className='seat-rail__dot'
                    style={{ ['--seat-color' as never]: color, ['--seat-text' as never]: contrastText(color) }}
                  >
                    {renderedExpanded ? seatInitials(seat.name) : null}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>

        <Tooltip
          content={t('commandEve.seatRail.add', 'Seed hinzufügen')}
          position='right'
          trigger={['hover', 'focus']}
        >
          <button
            type='button'
            className='seat-rail__add'
            data-testid='seat-rail-add'
            aria-label={t('commandEve.seatRail.add', 'Seed hinzufügen')}
            disabled={provisioning || switching}
            aria-busy={provisioning || undefined}
            onClick={() => {
              if (!retryPending) resetCreateAttempt();
              setCreateSeedVisible(true);
            }}
          >
            <span className='seat-rail__add-glyph' aria-hidden='true'>
              <Plus size={16} />
            </span>
          </button>
        </Tooltip>
      </nav>

      <Modal
        visible={createSeedVisible}
        title={t('commandEve.seatRail.createTitle', 'Neuen Seed erstellen')}
        onCancel={closeCreateSeed}
        maskClosable={!provisioning}
        escToExit={!provisioning}
        autoFocus={false}
        footer={
          <>
            <Button disabled={provisioning} onClick={closeCreateSeed}>
              {t('common.cancel', 'Abbrechen')}
            </Button>
            <Button
              type='primary'
              loading={provisioning}
              disabled={!seedName.trim()}
              onClick={() => void handleCreateSeed()}
              data-testid='seed-create-submit'
            >
              {retryPending
                ? t('commandEve.seatRail.retryReconcile', 'Erneut abgleichen')
                : t('commandEve.seatRail.createAction', 'Seed erstellen')}
            </Button>
          </>
        }
      >
        <p className='eve-settings-muted' id='seed-create-help'>
          {t(
            'commandEve.seatRail.createHelp',
            'Der Seed ist ein eigener Arbeitsraum. Er ist kostenlos und nutzt den Credit-Pool deines Accounts.'
          )}
        </p>
        <label className='eve-settings-field' htmlFor='seed-create-name'>
          <span>{t('commandEve.seatRail.seedName', 'Seed-Name')}</span>
          <Input
            id='seed-create-name'
            value={seedName}
            maxLength={200}
            disabled={provisioning || retryPending}
            aria-describedby='seed-create-help'
            onChange={(value) => {
              setSeedName(value);
            }}
            placeholder={t('commandEve.seatRail.seedNamePlaceholder', 'z. B. Fyn Labs')}
            data-testid='seed-create-name'
          />
        </label>
        <p role='status' aria-live='polite' data-testid='seed-create-status'>
          {seedCreateAnnouncement}
        </p>
      </Modal>
    </>
  );
};

export default SeatRail;
