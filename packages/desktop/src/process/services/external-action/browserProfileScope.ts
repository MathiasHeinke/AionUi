/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { normalizeEveExternalOrigin, type EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';

/**
 * Persistent Electron partition for one installation/account/seed/origin.
 * Cookies stay inside this Main-owned profile; raw account/seed/origin values
 * are not embedded in the partition name and are never sent over IPC.
 */
export function externalActionBrowserPartition(binding: EveExternalActionBinding, targetOrigin: string): string | null {
  const origin = normalizeEveExternalOrigin(targetOrigin);
  if (!origin) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`${binding.installationId}\0${binding.accountId}\0${binding.seedId}\0${origin}`)
    .digest('hex')
    .slice(0, 32);
  return `persist:command-eve-external-${digest}`;
}
