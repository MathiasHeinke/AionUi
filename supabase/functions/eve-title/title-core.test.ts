// Command EVE - eve-title pure core tests.

import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildEveTitlePrompt,
  EVE_TITLE_DEFAULT_MODEL,
  EVE_TITLE_MAX_CHARS,
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

Deno.test('pins title inference to DeepSeek V4 Flash and asks for the shared short-title contract', () => {
  const prompt = buildEveTitlePrompt({ text: 'Bitte plane den Launch', locale: 'de-DE' })[0].content;

  assertEquals(EVE_TITLE_DEFAULT_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assertEquals(prompt.includes('2-4 words'), true);
  assertEquals(prompt.includes('at most 36 characters'), true);
});

Deno.test('sanitizes reasoning, labels, markdown, controls, and wrapping punctuation', () => {
  assertEquals(
    sanitizeEveGeneratedTitle('<think>hidden</think>\n### 1. Session title: **"Launchplan\u200b erstellen."**'),
    'Launchplan erstellen'
  );
});

Deno.test('keeps at most four whole words without crossing 36 characters', () => {
  assertEquals(sanitizeEveGeneratedTitle('one two three four five six seven eight nine ten'), 'one two three four');
  const title = sanitizeEveGeneratedTitle('Internationalisierungsstrategie für weltweite Kampagnen');
  assertEquals(title, 'Internationalisierungsstrategie für');
  assertEquals((title ?? '').length <= EVE_TITLE_MAX_CHARS, true);
});

Deno.test('fails closed instead of returning one-word, partial-word, or empty titles', () => {
  assertEquals(sanitizeEveGeneratedTitle('Launch'), null);
  assertEquals(sanitizeEveGeneratedTitle('Außergewöhnlichlangeswortdasgrenzeüberschreitet kurz'), null);
  assertEquals(sanitizeEveGeneratedTitle('<think>unfinished reasoning'), null);
  assertEquals(sanitizeEveGeneratedTitle(' '), null);
});
