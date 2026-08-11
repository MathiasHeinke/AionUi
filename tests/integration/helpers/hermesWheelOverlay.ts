import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HermesWheelOverlay = {
  root: string;
  pythonPath: string;
  dispose: () => void;
};

/**
 * Loads the frozen Hermes wheel without mutating an installed runtime.
 *
 * The empty plugins/__init__.py makes the wheel's namespace package win over
 * any older regular `plugins` package in the selected Python environment.
 */
export function prepareHermesWheelOverlay(python: string, wheel: string): HermesWheelOverlay {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-hermes-wheel-'));
  try {
    childProcess.execFileSync(python, ['-m', 'zipfile', '-e', wheel, root], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const pluginsPackage = path.join(root, 'plugins');
    if (!fs.existsSync(pluginsPackage)) throw new Error('Hermes wheel has no plugins package.');
    const pluginsInit = path.join(pluginsPackage, '__init__.py');
    if (!fs.existsSync(pluginsInit)) fs.writeFileSync(pluginsInit, '', { flag: 'wx' });
    return {
      root,
      pythonPath: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
