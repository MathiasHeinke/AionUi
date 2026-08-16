#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import { buildCommandEveTtftFormalReceipt, type CommandEveTtftFormalInput } from './formal-core';

const valueAfter = (argv: string[], flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};

function main(argv = process.argv.slice(2)): void {
  const inputPath = valueAfter(argv, '--input');
  const outputPath = valueAfter(argv, '--output');
  if (!inputPath) throw new Error('usage: formal.ts --input <capture.json> [--output <receipt.json>]');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')) as CommandEveTtftFormalInput;
  const receipt = buildCommandEveTtftFormalReceipt(input);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    fs.writeFileSync(absoluteOutput, serialized, { mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
  process.exitCode = receipt.outcome === 'PASS' ? 0 : 2;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
