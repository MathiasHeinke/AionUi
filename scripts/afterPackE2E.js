const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');
const { applyPackagedElectronFusePolicy } = require('./electronFusePolicy');
const productionAfterPack = require('./afterPack');
const { normalizeArch } = require('./rebuildNativeModules');

const E2E_ATTACHMENT_MARKER = '.command-eve-e2e-packaged-attachment';

module.exports = async function afterPackE2E(context) {
  if (process.env.COMMAND_EVE_E2E_PACKAGED_BUILD !== '1') {
    throw new Error('The inspect-enabled package is test-only and requires COMMAND_EVE_E2E_PACKAGED_BUILD=1.');
  }

  await productionAfterPack(context);

  const resourcesPath =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  fs.writeFileSync(path.join(resourcesPath, E2E_ATTACHMENT_MARKER), 'non-distributable-playwright-attachment\n', {
    encoding: 'utf8',
    flag: 'wx',
  });

  const { arch, electronPlatformName } = context;
  const targetArch = normalizeArch(typeof arch === 'string' ? arch : Arch[arch] || process.arch);
  await applyPackagedElectronFusePolicy(context, targetArch, { enableNodeCliInspectArguments: true });
  console.log(
    `   ✓ NON-DISTRIBUTABLE E2E fuse override applied for ${electronPlatformName}-${targetArch}: Node CLI inspect enabled`
  );
};
