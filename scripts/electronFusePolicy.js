const fs = require('fs');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const PACKAGED_ELECTRON_FUSE_POLICY = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // The main renderer still loads from file:// inside app.asar. Electron 42
  // returns ERR_FILE_NOT_FOUND for that document when this fuse is disabled.
  // Keep it explicit until the main renderer moves to a custom protocol.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  [FuseV1Options.WasmTrapHandlers]: true,
});

function resolvePackagedElectronPath({ electronPlatformName, appOutDir, packager }) {
  const productFilename = packager?.appInfo?.productFilename || 'AionUi';

  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`);
  }

  const executableNames = [
    packager?.executableName,
    packager?.appInfo?.productFilename,
    packager?.appInfo?.name,
    productFilename,
  ].filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index);

  const candidates = executableNames.map((name) =>
    path.join(appOutDir, electronPlatformName === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name)
  );
  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!existingPath) {
    throw new Error(`Packaged Electron executable not found. Checked: ${candidates.join(', ')}`);
  }

  return existingPath;
}

function buildPackagedElectronFusePolicy(context, targetArch, overrides = {}) {
  const allowedOverrides = ['enableNodeCliInspectArguments'];
  const unknownOverrides = Object.keys(overrides).filter((key) => !allowedOverrides.includes(key));
  if (unknownOverrides.length > 0) {
    throw new Error(`Unsupported packaged Electron fuse override(s): ${unknownOverrides.join(', ')}`);
  }
  if (overrides.enableNodeCliInspectArguments === true && process.env.COMMAND_EVE_E2E_PACKAGED_BUILD !== '1') {
    throw new Error('Enabling Electron CLI inspect arguments requires COMMAND_EVE_E2E_PACKAGED_BUILD=1.');
  }

  return {
    ...PACKAGED_ELECTRON_FUSE_POLICY,
    ...(overrides.enableNodeCliInspectArguments === true
      ? { [FuseV1Options.EnableNodeCliInspectArguments]: true }
      : {}),
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && targetArch === 'arm64',
  };
}

async function applyPackagedElectronFusePolicy(context, targetArch, overrides = {}) {
  const electronPath = resolvePackagedElectronPath(context);
  await flipFuses(electronPath, buildPackagedElectronFusePolicy(context, targetArch, overrides));
  console.log(`   ✓ Explicit Electron fuse policy applied: ${electronPath}`);
}

module.exports = {
  PACKAGED_ELECTRON_FUSE_POLICY,
  applyPackagedElectronFusePolicy,
  buildPackagedElectronFusePolicy,
  resolvePackagedElectronPath,
};
