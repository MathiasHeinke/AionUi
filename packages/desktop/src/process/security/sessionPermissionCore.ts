import type { BrowserWindow } from 'electron';

type PermissionDetails = {
  isMainFrame: boolean;
  mediaType?: 'video' | 'audio' | 'unknown';
  mediaTypes?: Array<'video' | 'audio'>;
};

export function isAllowedMainRendererPermission(permission: string, details: PermissionDetails): boolean {
  if (!details.isMainFrame) return false;
  if (permission === 'clipboard-sanitized-write') return true;
  if (permission !== 'media') return false;

  if (details.mediaTypes) {
    return details.mediaTypes.length > 0 && details.mediaTypes.every((mediaType) => mediaType === 'audio');
  }
  return details.mediaType === 'audio';
}

export function configureMainRendererSessionPermissions(mainWindow: BrowserWindow): void {
  const mainContents = mainWindow.webContents;
  const rendererSession = mainContents.session;

  rendererSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    return (
      webContents === mainContents &&
      isAllowedMainRendererPermission(permission, {
        isMainFrame: details.isMainFrame,
        mediaType: details.mediaType,
      })
    );
  });

  rendererSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      webContents === mainContents &&
        isAllowedMainRendererPermission(permission, {
          isMainFrame: details.isMainFrame,
          mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
        })
    );
  });

  rendererSession.on('will-download', (event, _item, webContents) => {
    if (webContents !== mainContents) event.preventDefault();
  });
}
