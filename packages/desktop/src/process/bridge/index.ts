/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { initApplicationBridge } from './applicationBridge';
import { initDialogBridge } from './dialogBridge';
import { initUpdateBridge } from './updateBridge';
import { initSystemSettingsBridge } from './systemSettingsBridge';
import { initWindowControlsBridge } from './windowControlsBridge';
import { initNotificationBridge } from './notificationBridge';
import { initWebuiBridge } from './webuiBridge';
import { initCommandEveBridge } from './commandEveBridge';
import { initThemeBridge } from './themeBridge';
import { initProjectWorkspaceBridge } from './projectWorkspaceBridge';
import { initProjectWorkspaceServiceBridge } from './projectWorkspaceServiceBridge';
import { initCommandEveTerminalBridge } from './commandEveTerminalBridge';
import {
  initExternalActionBridge,
  registerExternalActionAdapter,
  registerExternalActionAdapterPayloadReadPort,
  registerExternalActionCompletionAttestationReadPort,
  registerExternalActionConversationContextReadPort,
  registerExternalActionReconciliationEvidenceReadPort,
  registerExternalActionSecretFieldSinkPort,
  reconcileExternalActionFromMain,
} from './externalActionBridge';

export type BridgeDependencies = Record<string, never>;

export function initAllBridges(_deps: BridgeDependencies = {}): void {
  initDialogBridge();
  initApplicationBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initSystemSettingsBridge();
  initNotificationBridge();
  initWebuiBridge();
  initThemeBridge();
  initCommandEveBridge();
  initExternalActionBridge();
  initProjectWorkspaceBridge();
  initProjectWorkspaceServiceBridge();
  initCommandEveTerminalBridge();
}

export {
  initApplicationBridge,
  initDialogBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initThemeBridge,
  initUpdateBridge,
  initWindowControlsBridge,
  initWebuiBridge,
  initCommandEveBridge,
  initProjectWorkspaceBridge,
  initProjectWorkspaceServiceBridge,
  initCommandEveTerminalBridge,
  initExternalActionBridge,
  registerExternalActionAdapter,
  registerExternalActionAdapterPayloadReadPort,
  registerExternalActionCompletionAttestationReadPort,
  registerExternalActionConversationContextReadPort,
  registerExternalActionReconciliationEvidenceReadPort,
  registerExternalActionSecretFieldSinkPort,
  reconcileExternalActionFromMain,
};
export { registerWindowMaximizeListeners } from './windowControlsBridge';
export const disposeAllTeamSessions = (): Promise<void> => Promise.resolve();
