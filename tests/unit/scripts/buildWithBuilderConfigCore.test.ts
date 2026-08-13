import { describe, expect, it } from 'vitest';

const {
  PACKAGED_E2E_BUILDER_CONFIG,
  PRODUCTION_BUILDER_CONFIG,
  WINDOWS_PHASE_A_BUILDER_CONFIG,
  resolveBuilderExecutionPolicy,
} = require('../../../scripts/buildWithBuilderConfigCore.cjs') as {
  PACKAGED_E2E_BUILDER_CONFIG: string;
  PRODUCTION_BUILDER_CONFIG: string;
  WINDOWS_PHASE_A_BUILDER_CONFIG: string;
  resolveBuilderExecutionPolicy: (input?: { isUnsignedWindowsPhaseA?: boolean; isPackagedE2E?: boolean }) => {
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
});
