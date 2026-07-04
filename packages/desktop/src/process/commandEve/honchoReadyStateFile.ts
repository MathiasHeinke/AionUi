/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO READY-STATE FILE bridge (1.7.0 / COMPA-624 Inc.3 / P6 — the
 * thin fs bridge between the I/O shells and the pure readers).
 *
 * The orchestration shell (O1) WRITES the per-seat readiness snapshot after it
 * probes /health + the deriver; the pure readers (the P3 deriver-route resolver,
 * the P5 onboarding lane) READ it. This is the ONLY fs surface between them —
 * everything that DECIDES on the snapshot stays pure (honchoReadinessCore /
 * honchoDeriverRouteCore).
 *
 * FAIL-SAFE: a read that is missing / unreadable / not valid JSON returns
 * `undefined`, which every pure reader treats as NOT ready — so a corrupt or
 * absent file can only ever fall back to "Honcho off", never to a false-ready.
 * The write is atomic (temp + rename, mode 0600) so a crash mid-write never leaves
 * a half-written snapshot a reader could mistake for ready.
 */

import fs from 'fs';
import path from 'path';
import type { HonchoReadinessState } from './honchoReadinessCore';

/** The per-seat readiness snapshot filename, rooted at the seat's honchoHome. */
export const HONCHO_READINESS_FILENAME = 'honcho-readiness.json';

/** `<honchoHome>/honcho-readiness.json` — the per-seat snapshot path. */
export function honchoReadinessPath(honchoHome: string): string {
  return path.join(honchoHome, HONCHO_READINESS_FILENAME);
}

/**
 * Atomically write the per-seat readiness snapshot. temp-then-rename (mode 0600)
 * so a reader never sees a partial file. Best-effort: throws only on a genuine fs
 * failure the caller can log — a Honcho miss is never fatal.
 */
export function writeHonchoReadyState(honchoHome: string, state: HonchoReadinessState): void {
  const file = honchoReadinessPath(honchoHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read the per-seat readiness snapshot. Returns `undefined` on ANY problem
 * (absent / unreadable / invalid JSON / non-object) — the fail-safe the pure
 * readers rely on (undefined ⇒ not ready ⇒ Honcho falls back to Company Brain +
 * MEMORY.md). NEVER throws.
 */
export function readHonchoReadyState(honchoHome: string): HonchoReadinessState | undefined {
  try {
    const raw = fs.readFileSync(honchoReadinessPath(honchoHome), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HonchoReadinessState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
