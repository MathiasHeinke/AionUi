/**
 * Non-distributable packaged-QA Playwright attachment proof for the TTFT
 * benchmark.
 *
 * Playwright attaches to a packaged Electron app through Node `--inspect` and
 * Chromium remote-debugging switches. The production CDP policy strips those
 * switches fail-closed unless the four-way runtime gate is true:
 *   packaged app + AIONUI_E2E_TEST=1 + COMMAND_EVE_E2E_PACKAGED_ATTACHMENT=1
 *   + the baked marker beside the runtime manifest.
 *
 * This module is the harness half of that contract: it proves the baked
 * marker before launch (so a missing marker fails fast instead of surfacing
 * as a 90s launch timeout) and supplies the two runtime authorization flags
 * for packaged launches only. Raw flags without the baked marker stay inert
 * in the app process by design; this harness must never weaken that policy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER } from '../../../packages/desktop/src/common/platform/userDataPath';

export const COMMAND_EVE_PACKAGED_QA_ATTACHMENT_ENV = Object.freeze({
  AIONUI_E2E_TEST: '1',
  COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1',
});

export type CommandEvePackagedQaAttachmentProof = {
  marker: string;
  markerPath: string;
  verifiedAtEpochMs: number;
};

export function requireCommandEvePackagedQaAttachment(manifestPath: string): CommandEvePackagedQaAttachmentProof {
  const markerPath = path.join(path.dirname(manifestPath), COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER);
  if (!fs.existsSync(markerPath)) {
    throw new Error(
      `Non-distributable packaged-QA marker is missing: ${markerPath}. ` +
        'Build with COMMAND_EVE_E2E_PACKAGED_BUILD=1 and packages/desktop/electron-builder.e2e.yml. ' +
        'Raw AIONUI_E2E_TEST or COMMAND_EVE_E2E_PACKAGED_ATTACHMENT flags must not enable packaged CDP.'
    );
  }
  return {
    marker: COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER,
    markerPath,
    verifiedAtEpochMs: Date.now(),
  };
}

export function commandEvePackagedQaLaunchEnv(packaged: boolean): Record<string, string> {
  return packaged ? { ...COMMAND_EVE_PACKAGED_QA_ATTACHMENT_ENV } : {};
}
