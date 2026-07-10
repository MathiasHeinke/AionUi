import { isDeepStrictEqual } from 'node:util';
import type { BrowserWindow, Event, IpcMainEvent } from 'electron';

type AuxiliaryWindowLike = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

export type PetConfirmationLike = {
  id: string;
  call_id: string;
  conversation_id: string;
  options: Array<{ value: unknown }>;
};

export type PetConfirmationResponse = {
  conversation_id: string;
  msg_id: string;
  call_id: string;
  data: unknown;
};

export function isTrustedAuxiliaryIpcSender(
  event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>,
  expectedWindow: AuxiliaryWindowLike | null
): boolean {
  if (!expectedWindow || expectedWindow.isDestroyed()) return false;
  const expectedContents = expectedWindow.webContents;
  if (expectedContents.isDestroyed()) return false;
  return event.sender === expectedContents && event.senderFrame === expectedContents.mainFrame;
}

export function isAllowedAuxiliaryNavigation(allowedUrl: string, targetUrl: string): boolean {
  try {
    const allowed = new URL(allowedUrl);
    const target = new URL(targetUrl);
    if (!['file:', 'http:', 'https:'].includes(allowed.protocol)) return false;
    if (target.protocol !== allowed.protocol || target.origin !== allowed.origin) return false;
    if (target.username || target.password) return false;
    return target.pathname === allowed.pathname;
  } catch {
    return false;
  }
}

export function hardenAuxiliaryWindowNavigation(window: BrowserWindow, allowedUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const preventUnexpectedNavigation = (event: Event, targetUrl: string) => {
    if (!isAllowedAuxiliaryNavigation(allowedUrl, targetUrl)) event.preventDefault();
  };

  window.webContents.on('will-navigate', preventUnexpectedNavigation);
  window.webContents.on('will-redirect', preventUnexpectedNavigation);
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

export function normalizePetClickData(input: unknown): { side: 'left' | 'right'; count: number } | null {
  if (!input || typeof input !== 'object') return null;
  const { side, count } = input as { side?: unknown; count?: unknown };
  if ((side !== 'left' && side !== 'right') || !Number.isInteger(count) || (count as number) < 1) return null;
  return { side, count: Math.min(count as number, 10) };
}

export function resolvePetConfirmationResponse(
  input: unknown,
  confirmations: Iterable<PetConfirmationLike>
): PetConfirmationResponse | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<PetConfirmationResponse>;
  if (
    typeof candidate.conversation_id !== 'string' ||
    typeof candidate.msg_id !== 'string' ||
    typeof candidate.call_id !== 'string' ||
    candidate.conversation_id.length === 0 ||
    candidate.conversation_id.length > 256 ||
    candidate.msg_id.length === 0 ||
    candidate.msg_id.length > 256 ||
    candidate.call_id.length === 0 ||
    candidate.call_id.length > 256
  ) {
    return null;
  }

  for (const confirmation of confirmations) {
    if (
      confirmation.id !== candidate.msg_id ||
      confirmation.call_id !== candidate.call_id ||
      confirmation.conversation_id !== candidate.conversation_id
    ) {
      continue;
    }

    const option = confirmation.options.find((entry) => isDeepStrictEqual(entry.value, candidate.data));
    if (!option) return null;
    return {
      conversation_id: confirmation.conversation_id,
      msg_id: confirmation.id,
      call_id: confirmation.call_id,
      data: option.value,
    };
  }

  return null;
}
