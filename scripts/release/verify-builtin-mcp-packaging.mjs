#!/usr/bin/env node

/**
 * Verify that every builtin MCP server script built for EXTERNAL node
 * execution is actually reachable in the packaged app.
 *
 * The defect this gates (found by the MAT-1747 packaged emitted-config
 * proof, 2026-08-03): `scripts/build-mcp-servers.js` emitted
 * `out/main/builtin-mcp-eve-artifacts.js`, but
 * `packages/desktop/electron-builder.yml` `asarUnpack` only listed
 * `out/main/builtin-mcp-image-gen.js`. In the real packaged app the artifact
 * script landed INSIDE app.asar, which an external node process cannot
 * execute, so `getBuiltinMcpScriptPath(...)` failed its existsSync check and
 * the `aionui-eve-artifacts` server was silently omitted from the emitted
 * Hermes config.yaml — the seat advertised no artifact capabilities.
 *
 * The rule: EVERY `out/main/builtin-mcp-*.js` outfile in
 * build-mcp-servers.js MUST appear in electron-builder.yml's asarUnpack
 * list. Static, CI-safe, no build required. `--check-built` additionally
 * asserts the built outfiles exist and are non-empty (run after
 * `node scripts/build-mcp-servers.js` in release pipelines).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILTIN_MCP_PACKAGING_VERIFIER_VERSION = 'builtin-mcp-packaging/v1';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');

const BUILD_SCRIPT_REL = 'scripts/build-mcp-servers.js';
const BUILDER_YML_REL = 'packages/desktop/electron-builder.yml';

const OUTFILE_PATTERN = /outfile:\s*path\.join\(ROOT,\s*'((?:out\/main\/)?builtin-mcp-[^']+\.js)'\)/g;

export function listBuiltinMcpOutfiles(buildScriptSource) {
  const outfiles = [];
  for (const match of buildScriptSource.matchAll(OUTFILE_PATTERN)) {
    outfiles.push(match[1]);
  }
  return [...new Set(outfiles)].sort();
}

export function listAsarUnpackEntries(builderYmlSource) {
  const lines = builderYmlSource.split('\n');
  const entries = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (/^asarUnpack:\s*$/.test(line)) inBlock = true;
      continue;
    }
    // The asarUnpack block ends at the first non-indented, non-list line.
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s*'([^']+)'/);
    if (match) entries.push(match[1]);
  }
  return entries;
}

export function findMissingAsarUnpackEntries(outfiles, asarUnpackEntries) {
  const listed = new Set(asarUnpackEntries);
  return outfiles.filter((outfile) => !listed.has(outfile));
}

export function verifyBuiltinMcpPackaging({ projectRoot = DEFAULT_PROJECT_ROOT, checkBuilt = false } = {}) {
  const buildScriptPath = path.join(projectRoot, BUILD_SCRIPT_REL);
  const builderYmlPath = path.join(projectRoot, BUILDER_YML_REL);
  const checks = [];

  if (!fs.existsSync(buildScriptPath) || !fs.existsSync(builderYmlPath)) {
    return {
      version: BUILTIN_MCP_PACKAGING_VERIFIER_VERSION,
      ok: false,
      status: 'BLOCKED_INPUT',
      detail: `missing input: ${!fs.existsSync(buildScriptPath) ? BUILD_SCRIPT_REL : BUILDER_YML_REL}`,
      checks,
    };
  }

  const outfiles = listBuiltinMcpOutfiles(fs.readFileSync(buildScriptPath, 'utf8'));
  const asarUnpackEntries = listAsarUnpackEntries(fs.readFileSync(builderYmlPath, 'utf8'));
  checks.push({ check: 'builtin-mcp-outfiles', outfiles });
  checks.push({ check: 'asarUnpack-entries', count: asarUnpackEntries.length });

  if (outfiles.length === 0) {
    return {
      version: BUILTIN_MCP_PACKAGING_VERIFIER_VERSION,
      ok: false,
      status: 'BLOCKED_INPUT',
      detail: `no builtin-mcp outfiles found in ${BUILD_SCRIPT_REL}`,
      checks,
    };
  }

  const missing = findMissingAsarUnpackEntries(outfiles, asarUnpackEntries);
  checks.push({ check: 'asarUnpack-covers-every-builtin-mcp-script', missing });
  if (missing.length > 0) {
    return {
      version: BUILTIN_MCP_PACKAGING_VERIFIER_VERSION,
      ok: false,
      status: 'FAIL_UNPACKED_MISSING',
      detail:
        `builtin MCP script(s) NOT in asarUnpack: ${missing.join(', ')} — an external node process ` +
        `cannot execute files inside app.asar, so the packaged app would silently omit the server.`,
      checks,
    };
  }

  if (checkBuilt) {
    const notBuilt = outfiles.filter((outfile) => {
      const outfilePath = path.join(projectRoot, outfile);
      try {
        return fs.statSync(outfilePath).size === 0;
      } catch {
        return true;
      }
    });
    checks.push({ check: 'built-outfiles-exist-non-empty', notBuilt });
    if (notBuilt.length > 0) {
      return {
        version: BUILTIN_MCP_PACKAGING_VERIFIER_VERSION,
        ok: false,
        status: 'FAIL_NOT_BUILT',
        detail: `built output missing or empty: ${notBuilt.join(', ')} — run node scripts/build-mcp-servers.js first.`,
        checks,
      };
    }
  }

  return {
    version: BUILTIN_MCP_PACKAGING_VERIFIER_VERSION,
    ok: true,
    status: 'PASS',
    detail: `all ${outfiles.length} builtin MCP script(s) are unpacked for external node: ${outfiles.join(', ')}`,
    checks,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const checkBuilt = process.argv.includes('--check-built');
  const result = verifyBuiltinMcpPackaging({ checkBuilt });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
