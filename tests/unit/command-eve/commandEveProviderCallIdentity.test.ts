/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The provider-call identity has a minter and no adjudicator (1.823.0).
 *
 * This replaces a cross-boundary parity test that could never run. It imported
 * `agent.context_breakdown._valid_identity_text` from a Hermes source tree
 * selected by `COMMAND_EVE_HERMES_SOURCE`, and skipped silently when that
 * variable was unset — which is every run in this repository. It could not have
 * passed even when set against the shipped artifact: no member of the bundled
 * wheel defines that function, so the import would raise. It only ever described
 * some other Hermes tree, and its silent skip made that indistinguishable from
 * agreement.
 *
 * What the shipped wheel does carry is the MINTER: one expression composes
 * `api_request_id`, and nothing validates it afterwards. So the checkable
 * promise is not "both sides accept the same tokens" — one side has no verdict
 * to compare — but "what Hermes mints, this repository accepts". That is
 * asserted below against the wheel's own bytes.
 *
 * The absence assertion is a tripwire, not a conclusion. It goes red the day a
 * Hermes-side validator lands, because from that day a real parity test is owed
 * and this weaker guarantee stops being enough.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commandEveProviderCallRequestId,
  isContentFreeCallIdentity,
} from '@/common/config/commandEveProviderCallIdentity';

const WHEEL_PATH = fileURLToPath(
  new URL('../../../resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl', import.meta.url)
);
const MINT_EXPRESSION = /api_request_id = f"([^"]*:api:[^"]*)"/g;
const PYTHON_PLACEHOLDER = /\{(\w+)\}/g;
const PYTHON_DEFINITION = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm;
const IDENTITY_VALIDATOR_NAME = '_valid_identity_text';

/**
 * Wheel members read from their DECOMPRESSED bytes. A substring search over the
 * archive would answer "absent" for a wheel that does carry the symbol, because
 * deflate leaves no plain text behind.
 */
async function wheelPythonMembers(): Promise<Map<string, string>> {
  const yauzl = await import('yauzl');
  const buffer = fs.readFileSync(WHEEL_PATH);
  return new Promise<Map<string, string>>((resolve, reject) => {
    const members = new Map<string, string>();
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('bundled Hermes wheel could not be opened'));
      zip.on('entry', (entry: { fileName: string }) => {
        if (!entry.fileName.endsWith('.py')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            return reject(streamError ?? new Error(`wheel entry unreadable: ${entry.fileName}`));
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            members.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('error', reject);
      zip.on('end', () => resolve(members));
      zip.readEntry();
    });
  });
}

/** Every `api_request_id` f-string template the wheel composes, with its file. */
function mintTemplates(members: ReadonlyMap<string, string>): { member: string; template: string }[] {
  const templates: { member: string; template: string }[] = [];
  for (const [member, source] of members) {
    for (const match of source.matchAll(MINT_EXPRESSION)) templates.push({ member, template: match[1] });
  }
  return templates;
}

function renderPythonTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PYTHON_PLACEHOLDER, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Hermes mint template uses an unexpected field: ${placeholder}`);
    return value;
  });
}

/** Members that both mint an identity and define a plausible validator for one. */
function identityValidatorsNearTheMint(members: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [member, source] of members) {
    if (source.includes(IDENTITY_VALIDATOR_NAME)) found.push(`${member}:${IDENTITY_VALIDATOR_NAME}`);
    if (!source.includes('api_request_id')) continue;
    for (const match of source.matchAll(PYTHON_DEFINITION)) {
      const name = match[1].toLowerCase();
      if (name.includes('valid') && name.includes('identity')) found.push(`${member}:${match[1]}`);
    }
  }
  return found.toSorted();
}

describe('Command EVE provider-call identity', () => {
  it('accepts every identity the bundled Hermes wheel mints', async () => {
    const templates = mintTemplates(await wheelPythonMembers());

    expect(templates.map((entry) => entry.member)).toEqual(['agent/conversation_loop.py']);
    const minted = renderPythonTemplate(templates[0].template, { turn_id: 'turn-1', api_call_count: '3' });
    expect(minted).toBe(commandEveProviderCallRequestId('turn-1', 3));
    expect(isContentFreeCallIdentity(minted)).toBe(true);
  });

  it('finds no Hermes-side validator to hold a parity test against', async () => {
    // Red on arrival of a counterpart: whoever lands one owes the real
    // both-sides parity test this file stands in for.
    expect(identityValidatorsNearTheMint(await wheelPythonMembers())).toEqual([]);
  });

  it('admits printable non-space ASCII and nothing else', () => {
    const singleBytes = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
    const accepted = singleBytes.filter(isContentFreeCallIdentity);

    // An off-by-one at either end of the printable range is the most plausible
    // way this grammar drifts, so the boundary is asserted by enumeration.
    expect(accepted.at(0)).toBe('!');
    expect(accepted.at(-1)).toBe('~');
    expect(accepted).toHaveLength(0x7e - 0x21 + 1);
  });

  it('rejects empty, oversized, spaced and non-ASCII identities', () => {
    expect(isContentFreeCallIdentity('turn-1')).toBe(true);
    expect('a'.repeat(256)).toSatisfy(isContentFreeCallIdentity);
    expect(['', 'a'.repeat(257), 'turn 1', 'turn\t1', 'turn-é', 'turn-1\n'].some(isContentFreeCallIdentity)).toBe(
      false
    );
  });
});
