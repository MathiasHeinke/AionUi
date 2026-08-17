import { describe, expect, it } from 'vitest';

const {
  PACKAGED_E2E_BUILDER_CONFIG,
  PRODUCTION_BUILDER_CONFIG,
  SIGNED_QA_BUILDER_CONFIG,
  WINDOWS_PHASE_A_BUILDER_CONFIG,
  resolveBuilderExecutionPolicy,
} = require('../../../scripts/buildWithBuilderConfigCore.cjs') as {
  PACKAGED_E2E_BUILDER_CONFIG: string;
  PRODUCTION_BUILDER_CONFIG: string;
  SIGNED_QA_BUILDER_CONFIG: string;
  WINDOWS_PHASE_A_BUILDER_CONFIG: string;
  resolveBuilderExecutionPolicy: (input?: {
    isUnsignedWindowsPhaseA?: boolean;
    isPackagedE2E?: boolean;
    isSignedQa?: boolean;
  }) => {
    builderConfig: string;
    allowDmgRetry: boolean;
    verifyMacUpdateFeed: boolean;
  };
};

describe('buildWithBuilderConfigCore', () => {
  it('keeps ordinary and notarized-capable builds on the production config', () => {
    expect(resolveBuilderExecutionPolicy()).toEqual({
      builderConfig: PRODUCTION_BUILDER_CONFIG,
      allowDmgRetry: true,
      verifyMacUpdateFeed: true,
    });
  });

  it('preserves the isolated Windows Phase A config', () => {
    expect(resolveBuilderExecutionPolicy({ isUnsignedWindowsPhaseA: true })).toEqual({
      builderConfig: WINDOWS_PHASE_A_BUILDER_CONFIG,
      allowDmgRetry: true,
      verifyMacUpdateFeed: true,
    });
  });

  it('selects the baked packaged-QA config only for the explicit E2E lane', () => {
    expect(resolveBuilderExecutionPolicy({ isPackagedE2E: true })).toEqual({
      builderConfig: PACKAGED_E2E_BUILDER_CONFIG,
      allowDmgRetry: false,
      verifyMacUpdateFeed: false,
    });
  });

  it('rejects conflicting non-distributable build lanes', () => {
    expect(() => resolveBuilderExecutionPolicy({ isUnsignedWindowsPhaseA: true, isPackagedE2E: true })).toThrow(
      /mutually exclusive/
    );
  });

  it('selects the signed QA config only when it extends the E2E attachment lane', () => {
    expect(resolveBuilderExecutionPolicy({ isPackagedE2E: true, isSignedQa: true })).toEqual({
      builderConfig: SIGNED_QA_BUILDER_CONFIG,
      allowDmgRetry: false,
      verifyMacUpdateFeed: false,
    });
  });

  it('refuses a signed QA package outside the fused E2E lane', () => {
    expect(() => resolveBuilderExecutionPolicy({ isSignedQa: true })).toThrow(/COMMAND_EVE_E2E_PACKAGED_BUILD=1/);
  });

  it('never reaches the signed QA config without an explicit opt-in', () => {
    for (const input of [undefined, { isPackagedE2E: true }, { isUnsignedWindowsPhaseA: true }]) {
      expect(resolveBuilderExecutionPolicy(input).builderConfig).not.toBe(SIGNED_QA_BUILDER_CONFIG);
    }
  });
});
