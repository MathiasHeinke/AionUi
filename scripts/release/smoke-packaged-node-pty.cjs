'use strict';

const path = require('node:path');

const SENTINEL = 'COMMAND_EVE_NODE_PTY_OK';
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot)) {
  process.stderr.write('node-pty package root must be absolute\n');
  process.exit(2);
}

let terminal;
const timeout = setTimeout(() => {
  try {
    terminal?.kill();
  } catch {
    // The process may already be gone.
  }
  process.stderr.write('node-pty smoke timed out\n');
  process.exit(3);
}, 10_000);

try {
  const pty = require(packageRoot);
  const ptyNodePath = Object.keys(require.cache).find((candidate) => candidate.endsWith(`${path.sep}pty.node`));
  if (!ptyNodePath) {
    throw new Error('node-pty loaded without a visible pty.node entry in require.cache');
  }
  let output = '';
  terminal = pty.spawn('/bin/sh', ['-lc', `printf '${SENTINEL}\\n'`], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'xterm-256color' },
  });
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit(() => {
    clearTimeout(timeout);
    if (!output.includes(SENTINEL)) {
      process.stderr.write(`node-pty smoke produced no sentinel: ${JSON.stringify(output)}\n`);
      process.exit(4);
    }
    process.stdout.write(
      `${SENTINEL} ${JSON.stringify({
        electron: process.versions.electron,
        node: process.versions.node,
        modules: process.versions.modules,
        arch: process.arch,
        ptyNodePath,
      })}\n`
    );
    process.exit(0);
  });
} catch (error) {
  clearTimeout(timeout);
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(5);
}
