/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAloudText, stopReadAloud } from '@/renderer/services/ReadAloudService';

class FakeSpeechSynthesisUtterance {
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  onstart: (() => void) | null = null;

  constructor(public text: string) {}
}

const originalSpeechSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
const spokenUtterances: FakeSpeechSynthesisUtterance[] = [];

function installSpeechSynthesis() {
  spokenUtterances.length = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
        spokenUtterances.push(utterance);
      }),
    },
  });
}

function restoreSpeechSynthesis() {
  if (originalSpeechSynthesis) {
    Object.defineProperty(window, 'speechSynthesis', originalSpeechSynthesis);
    return;
  }
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
}

describe('ReadAloudService', () => {
  afterEach(() => {
    stopReadAloud();
    restoreSpeechSynthesis();
    vi.unstubAllGlobals();
  });

  it.each(['canceled', 'cancelled', 'interrupted'])('suppresses %s speech errors after cancel/stop', (error) => {
    installSpeechSynthesis();
    const onError = vi.fn();

    expect(readAloudText('Assistant answer', { onError })).toBe(true);
    spokenUtterances[0].onerror?.({ error } as SpeechSynthesisErrorEvent);

    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards real speech errors to the caller', () => {
    installSpeechSynthesis();
    const onError = vi.fn();

    expect(readAloudText('Assistant answer', { onError })).toBe(true);
    spokenUtterances[0].onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'not-allowed' }));
  });
});
