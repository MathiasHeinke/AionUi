/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SeatRail — the far-left, collapsible bar of CLIENT / PROJECT seats (Command EVE).
 *
 * Each seat the admin owns is a colored circle (collapsed: a dot inside a real tap
 * target; expanded: a circle with the client's initials). The ACTIVE seat is ringed;
 * clicking another seat switches the whole app to it (same authoritative path as the
 * SeatSwitcher: useSeatAccess.switchTo drives the main-process stop + re-spawn under
 * the new HERMES_HOME). The "+" (pinned to the bottom) routes to the web account
 * where seats are added (the +99€/seat expansion).
 *
 * SECURITY / VISIBILITY: renders ONLY for an admin. useSeatAccess is fail-closed — a
 * delegate, a single-seat legacy install, no bridge, or any failed my-seats read all
 * resolve to role='delegate' (hidden). The switch IPC re-checks authorization in
 * main, so hiding the rail is defense-in-depth, not the boundary.
 */

import React, { useEffect, useState } from 'react';
import { Message, Modal, Tooltip } from '@arco-design/web-react';
import { ExpandLeft, ExpandRight, Plus } from '@icon-park/react';
import {
  isAnyGenerating,
  ensureAcpGenerationTracking,
  clearGenerationForBackendRespawn,
} from '@renderer/services/commandEveGenerationActivity';
import CommandEveGlyph from '@renderer/components/commandEve/CommandEveGlyph';
import { useTranslation } from 'react-i18next';
import { useSeatAccess } from '@renderer/hooks/useSeatAccess';
import { openAccountWeb } from '@renderer/utils/platform';
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

// The "+" chip adds a CLIENT seat (the +99€/seat expansion). Deep-link to the LIVE
// Gen-B consumer on /account (?intent=add_seat scrolls + highlights the add-seat
// section) so the click lands the operator exactly where they buy a seat. RELATIVE
// path: openAccountWeb pins the command-eve.com origin AND carries the desktop
// session so the operator lands LOGGED IN (checkout can start).
const ADD_SEAT_PATH = '/account?intent=add_seat';

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

const SeatRail: React.FC = () => {
  const { t } = useTranslation();
  const { loading, access, switching, switchTo, lastSwitchError, switchErrorNonce } = useSeatAccess();
  const [expanded, setExpanded] = useState(true);

  const visible = !loading && access.role === 'admin';

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
    const root = document.documentElement;
    root.style.setProperty('--seat-rail-width', visible ? (expanded ? '72px' : '40px') : '0px');
    return () => root.style.setProperty('--seat-rail-width', '0px');
  }, [visible, expanded]);

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

  // Admins only (see the security note above). Nothing renders otherwise.
  if (!visible) return null;

  const toggleLabel = expanded
    ? t('commandEve.seatRail.collapse', 'Leiste einklappen')
    : t('commandEve.seatRail.expand', 'Leiste ausklappen');

  return (
    <nav
      className={[
        'command-eve-seat-rail',
        expanded ? 'command-eve-seat-rail--expanded' : 'command-eve-seat-rail--collapsed',
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

      <Tooltip content={toggleLabel} position='right' trigger={['hover', 'focus']}>
        <button
          type='button'
          className='seat-rail__toggle'
          data-testid='seat-rail-toggle'
          aria-label={toggleLabel}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <ExpandLeft size={16} aria-hidden='true' /> : <ExpandRight size={16} aria-hidden='true' />}
        </button>
      </Tooltip>

      {/* Only the seat LIST scrolls. The toggle (above) and "+" (below) sit OUTSIDE
          this region so the "add client" affordance stays bottom-pinned even when an
          operator owns more clients than fit the viewport (the +99€/seat success case). */}
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
                  {expanded ? seatInitials(seat.name) : null}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      <Tooltip content={t('commandEve.seatRail.add', 'Kunde hinzufügen')} position='right' trigger={['hover', 'focus']}>
        <button
          type='button'
          className='seat-rail__add'
          data-testid='seat-rail-add'
          aria-label={t('commandEve.seatRail.add', 'Kunde hinzufügen')}
          onClick={() => void openAccountWeb(ADD_SEAT_PATH)}
        >
          <span className='seat-rail__add-glyph' aria-hidden='true'>
            <Plus size={16} />
          </span>
        </button>
      </Tooltip>
    </nav>
  );
};

export default SeatRail;
