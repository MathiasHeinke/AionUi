import { describe, expect, it } from 'vitest';

import {
  configureMainRendererSessionPermissions,
  isAllowedMainRendererPermission,
} from '@/process/security/sessionPermissionCore';

describe('main renderer session permission policy', () => {
  it('allows only main-frame audio capture and sanitized clipboard writes', () => {
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaTypes: ['audio'] })).toBe(true);
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    expect(isAllowedMainRendererPermission('clipboard-sanitized-write', { isMainFrame: true })).toBe(true);
  });

  it('denies camera, mixed media, subframes, and every unrelated browser permission', () => {
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaTypes: ['video'] })).toBe(false);
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(isAllowedMainRendererPermission('media', { isMainFrame: false, mediaTypes: ['audio'] })).toBe(false);
    expect(isAllowedMainRendererPermission('display-capture', { isMainFrame: true })).toBe(false);
    expect(isAllowedMainRendererPermission('geolocation', { isMainFrame: true })).toBe(false);
    expect(isAllowedMainRendererPermission('openExternal', { isMainFrame: true })).toBe(false);
    expect(isAllowedMainRendererPermission('fileSystem', { isMainFrame: true })).toBe(false);
    expect(isAllowedMainRendererPermission('notifications', { isMainFrame: true })).toBe(false);
  });

  it('fails closed when Chromium does not identify a requested media type', () => {
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true })).toBe(false);
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaType: 'unknown' })).toBe(false);
    expect(isAllowedMainRendererPermission('media', { isMainFrame: true, mediaTypes: [] })).toBe(false);
  });

  it('binds the policy to the owning main webContents rather than the shared session', () => {
    let checkHandler: ((contents: unknown, permission: string, origin: string, details: never) => boolean) | undefined;
    let requestHandler:
      | ((contents: unknown, permission: string, callback: (allowed: boolean) => void, details: never) => void)
      | undefined;
    let downloadHandler:
      | ((event: { preventDefault: () => void }, item: unknown, contents: unknown) => void)
      | undefined;
    const session = {
      setPermissionCheckHandler: (handler: typeof checkHandler) => {
        checkHandler = handler;
      },
      setPermissionRequestHandler: (handler: typeof requestHandler) => {
        requestHandler = handler;
      },
      on: (eventName: string, handler: typeof downloadHandler) => {
        if (eventName === 'will-download') downloadHandler = handler;
      },
    };
    const mainContents = { session };

    configureMainRendererSessionPermissions({ webContents: mainContents } as never);

    expect(
      checkHandler?.(mainContents, 'media', 'file:///app/index.html', {
        isMainFrame: true,
        mediaType: 'audio',
      } as never)
    ).toBe(true);
    expect(
      checkHandler?.({}, 'media', 'file:///app/index.html', { isMainFrame: true, mediaType: 'audio' } as never)
    ).toBe(false);

    let requestDecision: boolean | undefined;
    requestHandler?.(
      mainContents,
      'media',
      (allowed) => {
        requestDecision = allowed;
      },
      { isMainFrame: false, mediaTypes: ['audio'] } as never
    );
    expect(requestDecision).toBe(false);

    let guestDownloadBlocked = false;
    downloadHandler?.({ preventDefault: () => (guestDownloadBlocked = true) }, {}, {});
    expect(guestDownloadBlocked).toBe(true);

    let mainDownloadBlocked = false;
    downloadHandler?.({ preventDefault: () => (mainDownloadBlocked = true) }, {}, mainContents);
    expect(mainDownloadBlocked).toBe(false);
  });
});
