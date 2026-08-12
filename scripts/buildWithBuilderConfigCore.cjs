const PRODUCTION_BUILDER_CONFIG = 'packages/desktop/electron-builder.yml';
const WINDOWS_PHASE_A_BUILDER_CONFIG = 'packages/desktop/electron-builder.phase-a.yml';
const PACKAGED_E2E_BUILDER_CONFIG = 'packages/desktop/electron-builder.e2e.yml';

function resolveBuilderExecutionPolicy({ isUnsignedWindowsPhaseA = false, isPackagedE2E = false } = {}) {
  if (isUnsignedWindowsPhaseA && isPackagedE2E) {
    throw new Error('Windows Phase A and the packaged E2E attachment are mutually exclusive build lanes.');
  }

  if (isPackagedE2E) {
    return {
      builderConfig: PACKAGED_E2E_BUILDER_CONFIG,
      allowDmgRetry: false,
      verifyMacUpdateFeed: false,
    };
  }

  return {
    builderConfig: isUnsignedWindowsPhaseA ? WINDOWS_PHASE_A_BUILDER_CONFIG : PRODUCTION_BUILDER_CONFIG,
    allowDmgRetry: true,
    verifyMacUpdateFeed: true,
  };
}

module.exports = {
  PACKAGED_E2E_BUILDER_CONFIG,
  PRODUCTION_BUILDER_CONFIG,
  WINDOWS_PHASE_A_BUILDER_CONFIG,
  resolveBuilderExecutionPolicy,
};
