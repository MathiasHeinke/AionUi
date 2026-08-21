import path from 'node:path';
import { COMMAND_EVE_DATA_DIR_NAME } from '../../../packages/desktop/src/common/config/commandEveShell';

/**
 * `--user-data-dir` selects Electron's profile root. Command EVE keeps its
 * product data below the canonical `command-eve/` child of that root.
 */
export function resolveCommandEveTtftDataRoot(profileRoot: string): string {
  return path.join(path.resolve(profileRoot), COMMAND_EVE_DATA_DIR_NAME);
}

export function resolveCommandEveTtftRuntimeRoot(profileRoot: string): string {
  return path.join(resolveCommandEveTtftDataRoot(profileRoot), 'command-eve-runtime');
}
