/**
 * Hidden preload-to-main channel used only to attest paths returned by
 * Electron webUtils.getPathForFile. It is intentionally not exposed as a raw
 * renderer IPC primitive.
 */
export const COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL = 'command-eve:file-selection-grant';

/**
 * Hidden preload-to-main channel for paths returned by AionCore's own
 * `/api/fs/upload` endpoint. Main independently verifies that the path is a
 * regular, non-linked file below the app-owned temp upload root before it
 * records a read grant.
 */
export const COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL = 'command-eve:app-upload-grant';
