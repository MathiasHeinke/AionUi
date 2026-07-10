/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useSyncExternalStore } from 'react';
import { commandEve } from '@/common/adapter/ipcBridge';

export type CommandEveProfile = {
  name?: string;
  email?: string;
  loaded: boolean;
};

export type CommandEveProfileSnapshot = CommandEveProfile & {
  refresh: () => Promise<void>;
};

let profile: CommandEveProfile = { loaded: false };
let refreshPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const getSnapshot = () => profile;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Derive up-to-2-char uppercase initials from a display name. */
export function initialsFromName(name?: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** One deduplicated local registration read shared by all account surfaces. */
export function refreshCommandEveProfile(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await commandEve.registrationStatus.invoke();
      const data = response.data;
      profile = data?.ok ? { name: data.name, email: data.email, loaded: true } : { loaded: true };
    } catch {
      profile = { loaded: true };
    }
    emit();
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export const useCommandEveProfile = (): CommandEveProfileSnapshot => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!snapshot.loaded) void refreshCommandEveProfile();
  }, [snapshot.loaded]);

  return { ...snapshot, refresh: refreshCommandEveProfile };
};
