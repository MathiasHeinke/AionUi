import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isContentFreeCallIdentity } from '../../packages/desktop/src/common/config/commandEveProviderCallIdentity';

/**
 * Hermes mints provider-call identities and Main adjudicates them, so the two
 * repositories must agree on which tokens are valid. They cannot import one
 * module across a TypeScript/Python boundary, so this test executes BOTH
 * validators over the same probes and compares their verdicts. Restating
 * Hermes' character set here would only prove this file agrees with itself; the
 * verdicts below are the actual return values of the shipping implementations.
 */
const hermesSource = process.env.COMMAND_EVE_HERMES_SOURCE || '';
const hermesPython = path.join(hermesSource, '.venv/bin/python');
const runReal = Boolean(hermesSource && fs.existsSync(hermesPython));

/**
 * A full single-byte ASCII sweep plus the length and non-ASCII boundaries. The
 * sweep is what makes an off-by-one at either end of the printable range — the
 * most plausible way these two grammars would silently drift apart — impossible
 * to miss.
 */
function identityProbes(): string[] {
  const singleCharacters = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
  return [
    ...singleCharacters,
    '',
    'turn-1',
    'turn-1:api:1',
    'a'.repeat(256),
    'a'.repeat(257),
    'turn 1',
    'turn\t1',
    'turn-é',
    'turn-1\n',
  ];
}

function hermesVerdicts(probes: string[]): boolean[] {
  const probe = childProcess.spawnSync(
    hermesPython,
    [
      '-c',
      [
        'import json,sys',
        'sys.path.insert(0, sys.argv[1])',
        'from agent.context_breakdown import _valid_identity_text',
        'probes = json.loads(sys.stdin.read())',
        'sys.stdout.write(json.dumps([bool(_valid_identity_text(p)) for p in probes]))',
      ].join('\n'),
      hermesSource,
    ],
    { input: JSON.stringify(probes), encoding: 'utf8' }
  );
  if (probe.status !== 0) {
    throw new Error(`Hermes identity validator could not be executed: ${probe.stderr || probe.error?.message}`);
  }
  return JSON.parse(probe.stdout) as boolean[];
}

describe.skipIf(!runReal)('Command EVE provider-call identity parity with Hermes', () => {
  it('accepts and rejects exactly the same identities on both sides of the boundary', () => {
    const probes = identityProbes();
    const hermes = hermesVerdicts(probes);

    const divergent = probes
      .map((probe, index) => ({ probe, aion: isContentFreeCallIdentity(probe), hermes: hermes[index] }))
      .filter((verdict) => verdict.aion !== verdict.hermes)
      .map((verdict) => `${JSON.stringify(verdict.probe)}: aion=${verdict.aion} hermes=${verdict.hermes}`);

    expect(divergent).toEqual([]);
  });

  it('agrees that the shared grammar is neither empty nor unbounded', () => {
    // Guards the comparison above: two validators that rejected everything would
    // also "agree", and would pass a diff-only assertion while accepting no real
    // turn at all.
    const probes = ['turn-1', 'turn 1'];
    expect(hermesVerdicts(probes)).toEqual([true, false]);
    expect(probes.map(isContentFreeCallIdentity)).toEqual([true, false]);
  });
});
