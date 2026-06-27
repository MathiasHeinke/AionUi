/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import useSWR from 'swr';

/**
 * useIsDevMode — the single dev-gate primitive for founder/dev-only UI.
 *
 * Returns `true` ONLY in an unpackaged development build (Electron `app.isPackaged
 * === false`, surfaced via `app.get-cdp-status` → `ICdpStatus.isDevMode`). It powers
 * surfaces operators must NOT see — e.g. the runtime log status bar ("EVE bereit ·
 * Modell unbekannt · Logs").
 *
 * FAIL-CLOSED to the operator view: defaults to `false` while the status is loading
 * AND in any packaged/production build, so dev-only chrome stays HIDDEN by default
 * (a transient load never flashes the dev bar to an operator). Mirrors the exact
 * gate DevSettings already uses (`status?.isDevMode`). Shares the `'cdp.status'`
 * SWR key so every consumer dedupes onto one IPC round-trip.
 */
export function useIsDevMode(): boolean {
  const { data } = useSWR('cdp.status', () => ipcBridge.application.getCdpStatus.invoke());
  return data?.data?.isDevMode === true;
}

export default useIsDevMode;
