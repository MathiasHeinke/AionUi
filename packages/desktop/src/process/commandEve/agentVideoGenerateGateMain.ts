/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-FLAG — the PRODUCTION wiring of the agent video-generate gate.
 *
 * WHY THIS IS ITS OWN MODULE, and not three lines inside `agentVideoGenerateFlag.ts`:
 * that flag module is imported by `eveArtifactToolSurface.ts`, which is bundled
 * by esbuild into the standalone MCP CHILD. Composing the gate there would drag
 * `commandEveBackendSettingsRead` → `httpBridge` into that bundle, giving the
 * child a backend HTTP client it must never have — it holds no seat context, no
 * credential and no authority, and the whole point of the env carrier is that
 * Main has already decided for it.
 *
 * So the split is by AUDIENCE, not by taste: the flag module holds what the child
 * may know (an exact-`'1'` env read), and this module holds what only Main may do
 * (read the seat's persisted release from the backend store).
 *
 * The composed decision itself lives in `agentVideoGenerateSeatResolver.ts` and is
 * fully injectable; this file only supplies the three real implementations.
 */

import { readCommandEveSettingsFromBackend } from './commandEveBackendSettingsRead';
import { getDataPath } from '@process/utils/utils';
import { isAgentVideoGenerateKillSwitched, isAgentVideoGenerateLicenseEligible } from './agentVideoGenerateFlag';
import { createAgentVideoGenerateGate, createAgentVideoGenerateSeatResolver } from './agentVideoGenerateSeatResolver';

/**
 * THE production gate. Async, fail-closed, and re-read per call so an operator's
 * toggle takes effect on the next tool call rather than at the next boot.
 *
 * `getDataPath()` is resolved INSIDE the closure, not captured at module load:
 * the active seat can change while the process lives, and a gate bound to the
 * seat that happened to be active at import time would answer for the wrong one
 * after a switch.
 */
export const productionAgentVideoGenerateGate: () => Promise<boolean> = createAgentVideoGenerateGate({
  readSeatRelease: createAgentVideoGenerateSeatResolver(readCommandEveSettingsFromBackend),
  isKillSwitched: () => isAgentVideoGenerateKillSwitched(),
  isLicenseEligible: () => isAgentVideoGenerateLicenseEligible(getDataPath()),
});
