import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  MAX_REMEMBERED_COMMAND_LENGTH,
  answerAllowsExecution,
  canOfferRemember,
  classifyRememberCandidate,
  forgetCommand,
  readRememberedCommands,
  rememberCommand,
  type EveRememberedCommand,
} from '@/common/config/eveRememberedCommandsCore';

const NOW = '2026-07-27T22:00:00.000Z';

describe('what may be remembered', () => {
  it('accepts a plain literal command', () => {
    expect(classifyRememberCandidate('git status')).toBe('ok');
    expect(canOfferRemember('git status')).toBe(true);
  });

  it('refuses a compound command, because Hermes could never match it', () => {
    // These are the exact operators the wheel's allowlist shortcut bails on.
    // Storing one would be a promise silently never kept: the user clicks
    // "always" and keeps being asked.
    for (const command of [
      'ls && rm -rf build',
      'ls; rm x',
      'cat a | grep b',
      'echo hi > out.txt',
      'echo `whoami`',
      'echo $(whoami)',
      'ls || true',
      'ls\nrm x',
      'ls & ',
      'cat < in.txt',
    ]) {
      expect(classifyRememberCandidate(command), command).toBe('compound');
      expect(canOfferRemember(command), command).toBe(false);
    }
  });

  it('refuses a glob, because its scope is not visible at the moment of granting', () => {
    for (const command of ['podman *', 'rm ?', 'ls [ab]']) {
      expect(classifyRememberCandidate(command), command).toBe('pattern');
    }
  });

  it('refuses empty and over-long commands', () => {
    expect(classifyRememberCandidate('   ')).toBe('empty');
    expect(classifyRememberCandidate('a'.repeat(MAX_REMEMBERED_COMMAND_LENGTH + 1))).toBe('too-long');
  });

  it('reports a duplicate as such but still lets the card offer it', () => {
    const existing: EveRememberedCommand[] = [{ command: 'git status', grantedAt: NOW }];
    expect(classifyRememberCandidate('git status', existing)).toBe('duplicate');
    expect(canOfferRemember('git status', existing)).toBe(true);
  });
});

describe('granting and withdrawing', () => {
  it('records the command and when it was granted', () => {
    const list = rememberCommand([], 'git status', NOW);
    expect(list).toEqual([{ command: 'git status', grantedAt: NOW }]);
  });

  it('leaves the list untouched when the candidate is rejected', () => {
    const existing: readonly EveRememberedCommand[] = [{ command: 'git status', grantedAt: NOW }];
    for (const bad of ['', 'ls && rm -rf /', 'podman *', 'a'.repeat(1000)]) {
      expect(rememberCommand(existing, bad, NOW)).toBe(existing);
    }
  });

  it('withdraws exactly one grant and ignores unknown ones', () => {
    const list = rememberCommand(rememberCommand([], 'git status', NOW), 'bun test', NOW);
    expect(forgetCommand(list, 'git status')).toEqual([{ command: 'bun test', grantedAt: NOW }]);
    expect(forgetCommand(list, 'never granted')).toHaveLength(2);
  });
});

describe('stored rows are re-checked on read, not trusted for being there', () => {
  it('drops rows that a hand-edited file or an older build could have introduced', () => {
    const rows = readRememberedCommands([
      { command: 'git status', grantedAt: NOW },
      { command: 'ls && rm -rf /', grantedAt: NOW }, // compound
      { command: 'podman *', grantedAt: NOW }, // glob
      { command: 'a'.repeat(1000), grantedAt: NOW }, // too long
      { command: 'git status', grantedAt: NOW }, // duplicate
      { command: 'no date' },
      { command: '', grantedAt: NOW },
      null,
      'git status',
      42,
    ]);
    expect(rows).toEqual([{ command: 'git status', grantedAt: NOW }]);
  });

  it('returns nothing for a non-array', () => {
    for (const bad of [null, undefined, {}, 'git status', 7]) {
      expect(readRememberedCommands(bad)).toEqual([]);
    }
  });
});

describe('the mirrored wheel constant', () => {
  it('still matches the bundled wheel, or this file is lying', () => {
    // MIRRORED CONSTANT. If a Hermes bump changes the operator set, our
    // "compound" rejection stops agreeing with what Hermes can actually match,
    // and users get told a command is remembered when it never will be.
    const repoRoot = path.resolve(__dirname, '../../..');
    const wheels = fs
      .readdirSync(path.join(repoRoot, 'resources/bundled-hermes'))
      .filter((name) => name.startsWith('hermes_agent-') && name.endsWith('.whl'));
    expect(wheels.length).toBeGreaterThan(0);
    const wheelPath = path.join(repoRoot, 'resources/bundled-hermes', wheels[0] as string);
    const source = execFileSync(
      'python3',
      [
        '-c',
        [
          'import sys,zipfile',
          'z=zipfile.ZipFile(sys.argv[1])',
          's=z.read("tools/approval.py").decode()',
          'i=s.find("_ALLOWLIST_SHELL_OPERATOR_RE")',
          'print(s[i:s.find(chr(10),i)])',
        ].join('\n'),
        wheelPath,
      ],
      { encoding: 'utf8' }
    ).trim();
    expect(source).toContain(String.raw`re.compile(r"(?:\n|&&|\|\||[;&|<>` + '`' + String.raw`]|\$\()")`);
  });
});

describe('only an allow may trigger a remember', () => {
  it('accepts the answers that actually let the command run', () => {
    for (const id of ['allow_once', 'allow_session', 'allow', 'proceed_once', 'Allow-Once', ' allow_session ']) {
      expect(answerAllowsExecution(id), id).toBe(true);
    }
  });

  it('refuses every refusal, and anything it does not recognise', () => {
    // A remember triggered by a DENY is the worst bug this feature could have:
    // the human says no and EVE writes a standing yes. Unknown ids therefore
    // fall on the refusal side, not the permissive one.
    for (const id of [
      'deny',
      'deny_always',
      'reject',
      'cancel',
      'never_allow',
      'allow_always',
      'something_new',
      '',
      null,
      undefined,
    ]) {
      expect(answerAllowsExecution(id as string), String(id)).toBe(false);
    }
  });
});
