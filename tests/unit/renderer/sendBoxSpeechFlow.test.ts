import { describe, expect, it } from 'vitest';
import {
  buildSpeechSendDraft,
  shouldAbortPendingSpeechSend,
  shouldTranscribeSpeechOnEnter,
} from '@/renderer/components/chat/SendBox/speechSendFlow';

describe('SendBox speech send flow', () => {
  it('intercepts plain Enter only while recorded speech is pending', () => {
    expect(shouldTranscribeSpeechOnEnter('Enter', false, true)).toBe(true);
    expect(shouldTranscribeSpeechOnEnter('Enter', true, true)).toBe(false);
    expect(shouldTranscribeSpeechOnEnter('Escape', false, true)).toBe(false);
    expect(shouldTranscribeSpeechOnEnter('Enter', false, false)).toBe(false);
  });

  it('only aborts a null speech transcript when no typed draft or DOM snippet exists', () => {
    expect(shouldAbortPendingSpeechSend('', 0)).toBe(true);
    expect(shouldAbortPendingSpeechSend('   ', 0)).toBe(true);
    expect(shouldAbortPendingSpeechSend('typed prompt', 0)).toBe(false);
    expect(shouldAbortPendingSpeechSend('', 1)).toBe(false);
  });

  it('builds the sent draft from the input snapshot plus the spoken transcript', () => {
    expect(buildSpeechSendDraft('typed prompt', 'spoken prompt')).toBe('typed prompt\nspoken prompt');
    expect(buildSpeechSendDraft('', 'spoken prompt')).toBe('spoken prompt');
    expect(buildSpeechSendDraft('typed prompt', null)).toBe('typed prompt');
  });
});
