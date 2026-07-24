/**
 * Hidden preload-to-main channel used only to attest paths returned by
 * Electron webUtils.getPathForFile. It is intentionally not exposed as a raw
 * renderer IPC primitive.
 */
export const COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL = 'command-eve:file-selection-grant';
