#!/usr/bin/env node
/**
 * MAT-1747 PROOF 2 runner — bundles the no-paid dry harness
 * (scripts/proofs/mat1747NoPaidDryProof.ts) with esbuild (same pattern as
 * scripts/build-mcp-servers.js) and runs it with plain node.
 *
 * Prerequisites: out/main/builtin-mcp-eve-artifacts.js (built by
 * scripts/build-mcp-servers.js — run automatically when missing).
 */
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'scripts', 'proofs', 'out');
const BUNDLE = path.join(OUT_DIR, 'proof-mat1747-no-paid-dry.cjs');

if (!fs.existsSync(path.join(ROOT, 'out/main/builtin-mcp-eve-artifacts.js'))) {
  execSync('node scripts/build-mcp-servers.js', { cwd: ROOT, stdio: 'inherit' });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const esbuild = require('esbuild');
esbuild.buildSync({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'sharp', '@napi-rs/canvas'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
  define: { 'import.meta.url': JSON.stringify('file:///proof') },
  entryPoints: [path.join(ROOT, 'scripts/proofs/mat1747NoPaidDryProof.ts')],
  outfile: BUNDLE,
});

// The harness resolves the MCP child script relative to its own bundle
// location (scripts/proofs/out/ → repo root → out/main).
try {
  const output = execFileSync(process.execPath, [BUNDLE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(output);
  process.exit(0);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(typeof error.status === 'number' ? error.status : 1);
}
