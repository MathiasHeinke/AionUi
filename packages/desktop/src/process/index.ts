/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import '@/common/platform/register-electron';
// configureChromium sets app name (dev isolation) and Chromium flags — must run before other modules
import '@process/utils/configureChromium';

import { app } from 'electron';

// Force node-gyp-build to skip build/ directory and use prebuilds/ only in production
// This prevents loading wrong architecture binaries from development environment
// Only apply in packaged app to allow development builds to use build/Release/
if (app.isPackaged) {
  process.env.PREBUILDS_ONLY = '1';
}
import initStorage from './utils/initStorage';
import './utils/initBridge';
import './services/i18n'; // Initialize i18n for main process

export const initializeProcess = async () => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[CommandEVE:process] ${label} +${Math.round(performance.now() - t0)}ms`);

  await initStorage();
  mark('initStorage');

  // MAT-1747 round 5 — invalidate every live paid-video-edit authority left by a
  // previous process: permit records, active-turn pointers, in-flight locks.
  // Completed receipts are kept, because they are what stops a legitimate retry
  // becoming a second charge.
  //
  // AFTER initStorage, because it needs the data path; imported dynamically so
  // this entry file does not pull the video store into every consumer of
  // `initializeProcess`.
  //
  // THIS CALL IS NOT THE GUARANTEE — the guarantee is that the paid handler
  // refuses until some sweep has proven the store, and the mint path runs the
  // same sweep on the next ordinary send. This is the proactive half, so a
  // remembered permit arriving over the Hermes loopback before any user send
  // finds nothing left to spend. Both halves live in
  // `videoEditSpendPermitStore`; neither is allowed to be the only one.
  try {
    const [{ reinitializeVideoEditSpendStore }, { getDataPath }] = await Promise.all([
      import('@process/commandEve/videoEditSpendPermitStore'),
      import('@process/utils/utils'),
    ]);
    mark(`videoEditSpendStore ${reinitializeVideoEditSpendStore(getDataPath())}`);
  } catch (error) {
    // A failure here leaves the store UNPROVEN, which is already the refusing
    // state — nothing to compensate for, only something to say out loud.
    console.error('[CommandEVE:process] video-edit spend store reinitialization failed:', error);
  }
};
