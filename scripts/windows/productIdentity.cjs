const path = require('node:path');

const PRODUCT_NAME = 'Command EVE';
const WINDOWS_EXECUTABLE_NAME = `${PRODUCT_NAME}.exe`;
const WINDOWS_UNPACKED_DIR = 'win-unpacked';
const WINDOWS_RUNTIME_KEY = 'win32-x64';

function assertSafeVersion(version) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
    throw new Error('Windows artifact version is invalid');
  }
}

function windowsArtifactNames(version, arch = 'x64') {
  assertSafeVersion(version);
  if (arch !== 'x64') throw new Error(`Unsupported Command EVE Windows architecture: ${arch}`);
  const stem = `${PRODUCT_NAME}-${version}-win-${arch}`;
  return {
    installer: `${stem}.exe`,
    zip: `${stem}.zip`,
    metadata: 'latest.yml',
  };
}

function windowsInstalledExecutableCandidates(env = process.env) {
  const roots = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter(Boolean);
  return roots.map((root) => path.join(root, PRODUCT_NAME, WINDOWS_EXECUTABLE_NAME));
}

module.exports = {
  PRODUCT_NAME,
  WINDOWS_EXECUTABLE_NAME,
  WINDOWS_RUNTIME_KEY,
  WINDOWS_UNPACKED_DIR,
  windowsArtifactNames,
  windowsInstalledExecutableCandidates,
};
