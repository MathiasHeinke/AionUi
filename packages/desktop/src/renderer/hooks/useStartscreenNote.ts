/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6 Slice 2 ("Die Hinterlassene Hand") — reads EVE's handover note for the
 * start surface. Mirrors useOnboardingStatus: main process is the only source
 * of truth, the hook reads once on mount, non-desktop reports nothing. A
 * missing/unreadable note is a QUIET state (null) — the claim-free system card
 * then owns the surface; the hook never fabricates presence.
 */

import { useCallback, useEffect, useState } from 'react';
import { commandEve } from '@/common/adapter/ipcBridge';
import { isElectronDesktop } from '@renderer/utils/platform';
import { parseHandoverNote, type CommandEveHandoverNote } from '@/common/config/startscreenNoteCore';

export interface StartscreenNoteState {
  loading: boolean;
  /** Parsed note + the system's timestamp authority, or null (no note / non-desktop / error). */
  note: (CommandEveHandoverNote & { mtimeMs: number }) | null;
  refresh: () => Promise<void>;
}

export function useStartscreenNote(): StartscreenNoteState {
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<StartscreenNoteState['note']>(null);

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      setNote(null);
      setLoading(false);
      return;
    }
    try {
      const response = await commandEve.startscreenNote.invoke();
      const data = response.data ?? null;
      if (data && data.ok && data.exists && typeof data.mtime_ms === 'number' && typeof data.raw === 'string') {
        const parsed = parseHandoverNote(data.raw);
        // An empty body is no note — never render an empty shell in her name.
        setNote(parsed.body_md ? { ...parsed, mtimeMs: data.mtime_ms } : null);
      } else {
        setNote(null);
      }
    } catch (error) {
      console.error('Startscreen note read failed:', error);
      setNote(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loading, note, refresh };
}
