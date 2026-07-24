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
 * === false`, surfaced as a boolean-only `command-eve.shell-flags` fact). It powers
 * surfaces operators must NOT see — e.g. the runtime log status bar ("EVE bereit ·
 * Modell unbekannt · Logs").
 *
 * FAIL-CLOSED to the operator view: defaults to `false` while the status is loading
 * AND in any packaged/production build, so dev-only chrome stays HIDDEN by default
 * (a transient load never flashes the dev bar to an operator). Mirrors the exact
 * gate DevSettings already uses (`status?.isDevMode`) without exposing the
 * founder-only CDP status/config provider to customer builds.
 */
export function useIsDevMode(): boolean {
  const { data } = useSWR('command-eve.shell-flags', () => ipcBridge.commandEve.shellFlags.invoke());
  return data?.data?.is_dev_mode === true;
}

export default useIsDevMode;
