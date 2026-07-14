// Command EVE - eve-title pure core tests.

import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildEveTitlePrompt,
  prepareEveTitleRequestBody,
  prepareEveTitleText,
  sanitizeEveGeneratedTitle,
} from './title-core.ts';

Deno.test('prepares and redacts bounded title text', () => {
  const prepared = prepareEveTitleText(`api_key=sk-test-secret\n${'x'.repeat(1500)}`);

  assertEquals(prepared?.includes('sk-test-secret'), false);
  assertEquals(prepared?.includes('[REDACTED]'), true);
  assertEquals((prepared ?? '').length <= 1000, true);
});

Deno.test('rejects provider key fields recursively', () => {
  const prepared = prepareEveTitleRequestBody({
    text: 'Bitte plane den Launch',
    metadata: { provider_key: 'secret' },
  });

  assertEquals(prepared.ok, false);
  if (!prepared.ok) assertEquals(prepared.error, 'provider_key_field');
});

Deno.test('normalizes locale and prompt language', () => {
  const prepared = prepareEveTitleRequestBody({
    text: 'Build a launch plan',
    locale: 'en-GB',
  });
  if (!prepared.ok) throw new Error('expected prepared title request');

  assertEquals(prepared.request.locale, 'en-US');
  assertEquals(buildEveTitlePrompt(prepared.request)[0].content.includes('English'), true);
});

Deno.test('sanitizes model title output to one short line', () => {
  assertEquals(
    sanitizeEveGeneratedTitle('<think>hidden</think>\nTitle: "Launchplan erstellen."'),
    'Launchplan erstellen'
  );
  assertEquals(
    sanitizeEveGeneratedTitle('one two three four five six seven eight nine ten'),
    'one two three four five six seven eight'
  );
  assertEquals(sanitizeEveGeneratedTitle(' '), null);
});
