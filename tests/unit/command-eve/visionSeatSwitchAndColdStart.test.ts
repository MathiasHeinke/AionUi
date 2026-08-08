/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-1821 B2 — vision survives a seat switch, and a cold start either gets it
 * or SAYS it did not.
 *
 * THE TWO DEFECTS THIS PINS. (1) `provisionSeatRuntimeFiles` — the synchronous
 * seat-switch writer — used to land on the `''` default for the vision ref, and
 * `''` omits the whole `auxiliary.vision` block: every seat switch rewrote the
 * target seat's config.yaml without vision until the next app launch, including
 * switching BACK to the founder seat. (2) The bootstrap's vision probe ran
 * BEFORE `ollama serve` was spawned, so a genuine cold start resolved '' two
 * seconds before Ollama came up — and nothing anywhere said so.
 *
 * The fix is a persisted last-known-good ref (seat-independent, mirrored from
 * whatever the bootstrap actually emitted) plus a post-Ollama-ready re-probe
 * with a visible `VISION_OMITTED` receipt line. The behavioural halves are
 * tested against the real writer and the real probe below; the ORDERING inside
 * `ensureCommandEveRuntimeBootstrapUnlocked` (re-probe after Ollama-ready) is
 * not observable from outside a full bootstrap run, so it is pinned structurally
 * with exact, uniqueness-checked string anchors — the honest limit of what a
 * unit test can hold here.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localVisionModelRefFilePath,
  persistLocalVisionModelRef,
  pickCommandEveLocalVisionModel,
  provisionSeatRuntimeFiles,
  readPersistedLocalVisionModelRef,
  resolveCommandEveRuntimeBootstrapPaths,
  resolveLocalVisionModelRef,
} from '@/process/commandEve/runtimeBootstrapCore';
import { __resetActiveSeatForTests, clearActiveSeat, setActiveSeatId } from '@/process/commandEve/seatContextCore';

const SEAT_UUID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const VISION_REF = 'minicpm-v:8b';

const tempRoots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-vision-b2-test-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('the persisted last-known-good ref — mirrored, fail-safe, allowlisted', () => {
  it('round-trips the ref the bootstrap emitted, including the empty one', () => {
    const root = makeRoot();
    persistLocalVisionModelRef(root, VISION_REF);
    expect(readPersistedLocalVisionModelRef(root)).toBe(VISION_REF);

    // '' is a legitimate persisted answer ("this box has no vision model") and
    // must read back as '', not as a stale earlier ref.
    persistLocalVisionModelRef(root, '');
    expect(readPersistedLocalVisionModelRef(root)).toBe('');
  });

  it('reads fail-safe to the empty ref on every broken shape', () => {
    const root = makeRoot();
    // Absent file.
    expect(readPersistedLocalVisionModelRef(root)).toBe('');
    // Garbage bytes.
    fs.writeFileSync(localVisionModelRefFilePath(root), 'not json at all');
    expect(readPersistedLocalVisionModelRef(root)).toBe('');
    // Wrong shape.
    fs.writeFileSync(localVisionModelRefFilePath(root), JSON.stringify({ model_ref: 42 }));
    expect(readPersistedLocalVisionModelRef(root)).toBe('');
  });

  it('refuses refs outside the vision allowlist — the side file is not a config injection channel', () => {
    // The value is interpolated into config.yaml. A hand-edited side file must
    // not be able to point the vision route at an arbitrary model (or smuggle a
    // YAML line through a crafted "name").
    //
    // THE NEWLINE CASE HERE USED TO PROVE NOTHING. It read
    // `minicpm-v:8b\n  base_url: http://evil`, which the allowlist rejects — but
    // for the SLASH in `http://`, since the pattern's tag part is `[^/]+`. Take
    // the slash away and the same shape passed: `[^/]` matches `\n`, and `$`
    // without the `m` flag sits at the end of the whole string. The payloads
    // below are therefore slash-free on purpose, so the only thing that can
    // reject them is the control-character guard.
    const root = makeRoot();
    const refused = [
      'gemma4:12b',
      'x'.repeat(200),
      // Newline, no slash: one extra top-level YAML key in config.yaml.
      'minicpm-v:8b\nrogue_top_level: true',
      // Newline, no slash, indented: overrides a sibling key of the vision block.
      'minicpm-v:8b\n    timeout: 99999',
      // Carriage return counts too — the emitted file is read as text.
      'minicpm-v:8b\rx: 1',
      // A tab is equally a C0 byte and equally has no business in a model tag.
      'minicpm-v:8b\tx',
    ];
    for (const evil of refused) {
      fs.writeFileSync(
        localVisionModelRefFilePath(root),
        JSON.stringify({ version: 'command-eve-local-vision-ref/v0', model_ref: evil })
      );
      expect(readPersistedLocalVisionModelRef(root), JSON.stringify(evil.slice(0, 40))).toBe('');
    }
    // ...and the legitimate ref still reads back, so the guard did not just
    // reject everything.
    fs.writeFileSync(
      localVisionModelRefFilePath(root),
      JSON.stringify({ version: 'command-eve-local-vision-ref/v0', model_ref: 'minicpm-v:8b' })
    );
    expect(readPersistedLocalVisionModelRef(root)).toBe('minicpm-v:8b');
  });

  it('refuses the same payloads on the WRITE side, where /api/tags is whatever answers the port', () => {
    // The other end, and the one that does not need write access to the app's
    // data directory: the bootstrap only spawns `ollama serve` when `pingOllama`
    // fails, so a local process already listening on the runtime port supplies
    // this model list. `compact` only trims it.
    const tags = (name: string) => JSON.stringify({ models: [{ name }] });
    expect(pickCommandEveLocalVisionModel(tags('minicpm-v:8b\nrogue_top_level: true'))).toBe('');
    expect(pickCommandEveLocalVisionModel(tags('minicpm-v:8b\n    timeout: 99999'))).toBe('');
    expect(pickCommandEveLocalVisionModel(tags('minicpm-v:8b\rx: 1'))).toBe('');
    // The clean tag from the same shape still resolves.
    expect(pickCommandEveLocalVisionModel(tags('minicpm-v:8b'))).toBe('minicpm-v:8b');
  });
});

describe('GATE 1 — a seat switch keeps auxiliary.vision', () => {
  it('the switch-path writer emits the persisted vision block for the target seat', () => {
    // This drives the REAL function the seat-switch bridge calls
    // (commandEveBridge -> provisionSeatRuntimeFiles); the bridge adds only
    // best-effort logging around it, so this is the switch path's write.
    const root = makeRoot();
    setActiveSeatId(SEAT_UUID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, SEAT_UUID);
    persistLocalVisionModelRef(paths.runtimeRoot, VISION_REF);

    const result = provisionSeatRuntimeFiles({ userDataPath: root, seatId: SEAT_UUID });
    expect(result.ok, result.error ?? '').toBe(true);

    const config = fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8');
    expect(config).toContain('  vision:');
    expect(config).toContain(`    model: ${VISION_REF}`);
  });

  it('without a persisted ref the switch still omits the block — no invented route', () => {
    // Fail-safe direction unchanged: a box whose last boot found no vision model
    // (or that never persisted one) keeps emitting a config without the key,
    // exactly as the boot itself would. Last-known-good, never invented-good.
    const root = makeRoot();
    setActiveSeatId(SEAT_UUID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, SEAT_UUID);

    const result = provisionSeatRuntimeFiles({ userDataPath: root, seatId: SEAT_UUID });
    expect(result.ok, result.error ?? '').toBe(true);

    const config = fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8');
    expect(config).not.toContain('  vision:');
    expect(config).not.toContain(VISION_REF);
  });
});

describe('GATE 2 — the cold-start probe halves, against a real HTTP boundary', () => {
  it('an unreachable runtime resolves to the empty ref instead of throwing', async () => {
    // Port 9 (discard) refuses immediately on loopback — the cold-start shape.
    await expect(resolveLocalVisionModelRef('http://127.0.0.1:9')).resolves.toBe('');
  });

  it('a runtime that has come up resolves the installed vision model — the re-probe half', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'gemma4:12b' }, { name: VISION_REF }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(resolveLocalVisionModelRef(`http://127.0.0.1:${port}`)).resolves.toBe(VISION_REF);
    } finally {
      server.close();
    }
  });

  it('a runtime without any vision model resolves to the empty ref — omission, not a guess', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'gemma4:12b' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(resolveLocalVisionModelRef(`http://127.0.0.1:${port}`)).resolves.toBe('');
    } finally {
      server.close();
    }
  });
});

describe('the re-probe ordering and the receipt line — pinned structurally', () => {
  /**
   * A full `ensureCommandEveRuntimeBootstrap` run installs Python and Hermes and
   * is not a unit test, so the ORDER (first probe -> ollama spawn/ready ->
   * re-probe -> VISION_OMITTED line) cannot be asserted behaviourally here.
   * Exact string anchors with a uniqueness check are the agreed fallback: each
   * anchor must appear EXACTLY once, so a refactor that duplicates or removes
   * one reddens this test instead of silently un-pinning the order.
   */
  const source = fs.readFileSync(
    path.join(__dirname, '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'),
    'utf8'
  );

  const indexOfUnique = (anchor: string): number => {
    const first = source.indexOf(anchor);
    expect(first, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
    expect(source.indexOf(anchor, first + 1), `anchor not unique: ${anchor}`).toBe(-1);
    return first;
  };

  it('the re-probe sits after Ollama-ready, and the omission line after the re-probe', () => {
    const ready = indexOfUnique('const ollamaReady = await waitForOllama(');
    const reprobe = indexOfUnique('if (!localVisionModelRef && ollamaReady) {');
    const omitted = indexOfUnique("makeStage('vision', 'skip', {");
    expect(ready).toBeLessThan(reprobe);
    expect(reprobe).toBeLessThan(omitted);
  });

  it('the switch path reads the persisted ref, not a probe and not a literal', () => {
    indexOfUnique('readPersistedLocalVisionModelRef(paths.runtimeRoot)');
  });
});
