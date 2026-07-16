/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('node:fs');
const path = require('node:path');

function isNonEmptyRegularFile(filePath, deps = fs) {
  try {
    const stat = deps.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function viteBuildExists(outDir, deps = fs) {
  return (
    isNonEmptyRegularFile(path.join(outDir, 'main', 'index.js'), deps) &&
    isNonEmptyRegularFile(path.join(outDir, 'renderer', 'index.html'), deps)
  );
}

module.exports = {
  isNonEmptyRegularFile,
  viteBuildExists,
};
