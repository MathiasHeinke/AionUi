#!/usr/bin/env node

import { evaluateMacUpdateFeed } from './verify-mac-update-feed-core.mjs';

function parseArgs(argv) {
  const args = { dmg: '', outDir: '', metadata: '', json: false, help: false, allowSiblingMetadata: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dmg') args.dmg = argv[++index] || '';
    else if (arg === '--out-dir') args.outDir = argv[++index] || '';
    else if (arg === '--metadata') args.metadata = argv[++index] || '';
    else if (arg === '--allow-sibling-metadata') args.allowSiblingMetadata = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/release/verify-mac-update-feed.mjs \\
    --dmg <path-to-final.dmg> \\
    [--out-dir <release-out-dir>] \\
    [--metadata <latest-*-mac.yml>] \\
    [--allow-sibling-metadata] \\
    [--json]

Verifies that the electron-updater mac metadata points to the final stapled DMG
and ZIP bytes. Blocks stale generic latest-mac.yml next to an arm64-only release.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = evaluateMacUpdateFeed({
    dmgPath: args.dmg,
    outDir: args.outDir || undefined,
    metadataPath: args.metadata || undefined,
    allowSiblingMetadata: args.allowSiblingMetadata,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status}: ${result.detail}`);
  process.exitCode = result.exit_code;
}

main().catch((error) => {
  console.error(`verify-mac-update-feed failed: ${error.message}`);
  process.exitCode = 1;
});
