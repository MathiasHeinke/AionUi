#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMAND_EVE_TTFT_GOLDEN_RESULT_VERSION,
  evaluateCommandEveTtftGoldenSet,
  type CommandEveTtftGoldenResult,
} from './golden-set-core';

const valueAfter = (argv: string[], flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};

const readResult = (filePath: string): CommandEveTtftGoldenResult => {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as CommandEveTtftGoldenResult;
  if (parsed.version !== COMMAND_EVE_TTFT_GOLDEN_RESULT_VERSION) {
    throw new Error(`${filePath}: expected ${COMMAND_EVE_TTFT_GOLDEN_RESULT_VERSION}`);
  }
  return parsed;
};

function main(argv = process.argv.slice(2)): void {
  const baselinePath = valueAfter(argv, '--baseline');
  const candidatePath = valueAfter(argv, '--candidate');
  const outputPath = valueAfter(argv, '--output');
  if (!baselinePath || !candidatePath) {
    throw new Error('usage: golden-set.ts --baseline <result.json> --candidate <result.json> [--output <gate.json>]');
  }

  const gate = evaluateCommandEveTtftGoldenSet({
    baseline: readResult(baselinePath),
    candidate: readResult(candidatePath),
  });
  const serialized = `${JSON.stringify(gate, null, 2)}\n`;
  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    fs.writeFileSync(absoluteOutput, serialized, { mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
  process.exitCode = gate.outcome === 'FAIL' ? 1 : gate.outcome === 'SOURCE_PASS_MEASUREMENT_REQUIRED' ? 2 : 0;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
