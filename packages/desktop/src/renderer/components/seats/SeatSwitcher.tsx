/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SeatSwitcher (Phase 4 / A5, SLICE D) + embedded fail-closed SeatGuard (SLICE E).
 *
 * The admin seat-selector. It is the ONLY UI path to changing the active client
 * seat — and it renders NOTHING unless the caller is an admin with more than one
 * seat (`access.canSwitch`). For a delegate, a single-seat / legacy install, or
 * any failed/unknown my-seats read, this component is INVISIBLE and there is no
 * other route to another seat (the SeatGuard is fail-closed: unknown ⇒ delegate
 * ⇒ pinned). Selecting a seat drives the main-process switch (stop + re-spawn the
 * agent under the new HERMES_HOME); while the backend re-spawns we show a
 * "restarting EVE for <seat>" busy state and disable the selector.
 *
 * SECURITY NOTE: hiding the switcher here is defense-in-depth, NOT the boundary.
 * The switch-seat IPC re-checks authorization in main (isSeatSwitchAuthorized),
 * so a delegate who somehow reached the IPC is still rejected server-side.
 */

import React from 'react';
import { Select, Spin, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useSeatAccess } from '@renderer/hooks/useSeatAccess';

const SeatSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const { loading, access, switching, lastSwitchError, switchTo } = useSeatAccess();

  // FAIL-CLOSED SeatGuard: render nothing unless this is an admin with a real
  // choice. A delegate / single-seat / legacy / unknown-role caller sees NO
  // switcher and has no UI route to any seat other than their pinned one.
  if (loading) return null;
  if (!access.canSwitch) return null;

  return (
    <div className='command-eve-seat-switcher' data-testid='seat-switcher' style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Select
        data-testid='seat-switcher-select'
        size='small'
        style={{ minWidth: 200 }}
        value={access.activeSeatId}
        disabled={switching}
        loading={switching}
        aria-label={t('commandEve.seatSwitcher.label', 'Active client seat')}
        onChange={(value) => {
          if (typeof value === 'string') void switchTo(value);
        }}
      >
        {access.seats.map((seat) => (
          <Select.Option key={seat.seat_id} value={seat.seat_id}>
            {seat.name}
            {seat.seat_id === access.activeSeatId ? (
              <Tag color='green' size='small' style={{ marginLeft: 8 }}>
                {t('commandEve.seatSwitcher.active', 'active')}
              </Tag>
            ) : null}
          </Select.Option>
        ))}
      </Select>
      {switching ? (
        <span data-testid='seat-switcher-busy' style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.8 }}>
          <Spin size={14} />
          {t('commandEve.seatSwitcher.restarting', 'Restarting EVE for the new seat…')}
        </span>
      ) : null}
      {!switching && lastSwitchError ? (
        <Tag color='red' size='small' data-testid='seat-switcher-error'>
          {t('commandEve.seatSwitcher.error', 'Seat switch failed')}
        </Tag>
      ) : null}
    </div>
  );
};

export default SeatSwitcher;
