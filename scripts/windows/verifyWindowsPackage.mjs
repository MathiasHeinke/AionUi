#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { inspectWindowsPackage } from './windowsPackageInventoryCore.mjs';

function parseArgs(argv) {
  const args = { outDir: 'out', version: '', report: '', requirePython: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') args.outDir = argv[++index] || '';
    else if (arg === '--version') args.version = argv[++index] || '';
    else if (arg === '--report') args.report = argv[++index] || '';
    else if (arg === '--require-python') args.requirePython = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function writeAtomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, filePath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const result = inspectWindowsPackage({
    outDir: path.resolve(args.outDir),
    version: args.version || packageJson.version,
    requirePython: args.requirePython,
  });
  if (args.report) writeAtomicJson(path.resolve(args.report), result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(`[verify-windows-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
