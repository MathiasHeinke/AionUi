const PRODUCTION_BUILDER_CONFIG = 'packages/desktop/electron-builder.yml';
const WINDOWS_PHASE_A_BUILDER_CONFIG = 'packages/desktop/electron-builder.phase-a.yml';
const PACKAGED_E2E_BUILDER_CONFIG = 'packages/desktop/electron-builder.e2e.yml';
const SIGNED_QA_BUILDER_CONFIG = 'packages/desktop/electron-builder.qa-signed.yml';

function resolveBuilderExecutionPolicy({
  isUnsignedWindowsPhaseA = false,
  isPackagedE2E = false,
  isSignedQa = false,
} = {}) {
  if (isUnsignedWindowsPhaseA && isPackagedE2E) {
    throw new Error('Windows Phase A and the packaged E2E attachment are mutually exclusive build lanes.');
  }

  // The signed QA lane is the E2E attachment plus real Developer ID signing.
  // It can never be a lane of its own: the inspect fuse it depends on is gated
  // on COMMAND_EVE_E2E_PACKAGED_BUILD=1 in scripts/electronFusePolicy.js, and
  // scripts/afterPackE2E.js refuses to bake the QA marker without it.
  if (isSignedQa && !isPackagedE2E) {
    throw new Error(
      'The signed QA package extends the packaged E2E attachment; it requires COMMAND_EVE_E2E_PACKAGED_BUILD=1.'
    );
  }

  if (isPackagedE2E && isSignedQa) {
    return {
      builderConfig: SIGNED_QA_BUILDER_CONFIG,
      allowDmgRetry: false,
      verifyMacUpdateFeed: false,
    };
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
  SIGNED_QA_BUILDER_CONFIG,
  WINDOWS_PHASE_A_BUILDER_CONFIG,
  resolveBuilderExecutionPolicy,
};
