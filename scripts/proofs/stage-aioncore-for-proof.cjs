#!/usr/bin/env node
/**
 * MAT-1747 proof helper: stage the bundled-aioncore payload (darwin-arm64)
 * exactly the way scripts/build-with-builder.js does before electron-builder
 * runs. Public GitHub release download only; no signing, no secrets.
 */
const { prepareAioncore } = require('../../packages/shared-scripts/src/prepare-aioncore.js');
const { resolveAioncoreVersion } = require('../resolveAioncoreVersion.js');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
prepareAioncore({
  projectRoot,
  platform: process.platform,
  arch: 'arm64',
  version: resolveAioncoreVersion(projectRoot),
});
console.log('PROOF: aioncore staging completed');
