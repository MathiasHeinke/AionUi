import { describe, expect, it } from 'vitest';
import {
  isAllowedAuxiliaryNavigation,
  isTrustedAuxiliaryIpcSender,
  normalizePetClickData,
  resolvePetConfirmationResponse,
} from '@/process/security/auxiliaryWindowSecurityCore';

describe('auxiliaryWindowSecurityCore', () => {
  it('accepts only the expected live main frame as IPC sender', () => {
    const mainFrame = {};
    const sender = { isDestroyed: () => false, mainFrame };
    const window = { isDestroyed: () => false, webContents: sender };

    expect(isTrustedAuxiliaryIpcSender({ sender, senderFrame: mainFrame } as never, window as never)).toBe(true);
    expect(isTrustedAuxiliaryIpcSender({ sender: {}, senderFrame: mainFrame } as never, window as never)).toBe(false);
    expect(isTrustedAuxiliaryIpcSender({ sender, senderFrame: {} } as never, window as never)).toBe(false);
    expect(
      isTrustedAuxiliaryIpcSender(
        { sender: { ...sender, isDestroyed: () => true }, senderFrame: mainFrame } as never,
        { ...window, webContents: { ...sender, isDestroyed: () => true } } as never
      )
    ).toBe(false);
  });

  it('keeps auxiliary navigation on the exact trusted document', () => {
    expect(
      isAllowedAuxiliaryNavigation('file:///Applications/EVE/pet.html', 'file:///Applications/EVE/pet.html#ready')
    ).toBe(true);
    expect(
      isAllowedAuxiliaryNavigation('http://localhost:5173/pet/pet.html', 'http://localhost:5173/pet/pet.html')
    ).toBe(true);
    expect(isAllowedAuxiliaryNavigation('http://localhost:5173/pet/pet.html', 'http://localhost:5173/settings')).toBe(
      false
    );
    expect(isAllowedAuxiliaryNavigation('file:///Applications/EVE/pet.html', 'https://attacker.example/pet.html')).toBe(
      false
    );
  });

  it('normalizes bounded click input', () => {
    expect(normalizePetClickData({ side: 'left', count: 2 })).toEqual({ side: 'left', count: 2 });
    expect(normalizePetClickData({ side: 'right', count: 1000 })).toEqual({ side: 'right', count: 10 });
    expect(normalizePetClickData({ side: 'middle', count: 1 })).toBeNull();
    expect(normalizePetClickData({ side: 'left', count: Number.NaN })).toBeNull();
  });

  it('canonicalizes only a currently offered confirmation option', () => {
    const confirmations = [
      {
        id: 'message-1',
        call_id: 'call-1',
        conversation_id: 'conversation-1',
        options: [{ value: 'deny' }, { value: { action: 'proceed_once' } }],
      },
    ];

    expect(
      resolvePetConfirmationResponse(
        {
          msg_id: 'message-1',
          call_id: 'call-1',
          conversation_id: 'conversation-1',
          data: { action: 'proceed_once' },
        },
        confirmations
      )
    ).toEqual({
      msg_id: 'message-1',
      call_id: 'call-1',
      conversation_id: 'conversation-1',
      data: { action: 'proceed_once' },
    });

    expect(
      resolvePetConfirmationResponse(
        { msg_id: 'message-1', call_id: 'call-1', conversation_id: 'conversation-1', data: 'proceed_always' },
        confirmations
      )
    ).toBeNull();
    expect(
      resolvePetConfirmationResponse(
        { msg_id: 'message-1', call_id: 'forged', conversation_id: 'conversation-1', data: 'deny' },
        confirmations
      )
    ).toBeNull();
  });
});
