#!/usr/bin/env tsx
/**
 * Command EVE local Gemma title smoke gate.
 *
 * This is deliberately stricter than the user-facing title path. Runtime title
 * generation may fail quiet and keep the heuristic fallback; this release gate
 * fails loud when local Gemma is missing, slow, empty, rambly, prompt-echoing,
 * or off-topic.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  buildLocalTitlePrompt,
  evaluateLocalTitleSmokeGate,
  pickLocalTitleModel,
  type CommandEveTitleLocale,
} from '../packages/desktop/src/process/commandEve/commandEveTitleCore.ts';

type Args = {
  baseUrl: string;
  model?: string;
  locale: CommandEveTitleLocale;
  text: string;
  expectedTerms: string[];
  timeoutMs: number;
  output: string;
};

type Receipt = {
  version: 'command-eve-gemma-title-smoke/v0';
  created_at: string;
  ok: boolean;
  reason_code?: string;
  host: {
    platform: NodeJS.Platform;
    arch: string;
    cpus: number;
    total_memory_gb: number;
  };
  args: {
    base_url: string;
    model?: string;
    locale: CommandEveTitleLocale;
    text_chars: number;
    expected_terms: string[];
    timeout_ms: number;
  };
  result: {
    model?: string;
    prompt_chars?: number;
    raw_output?: string;
    title?: string | null;
    total_ms?: number;
    error?: string;
  };
};

const DEFAULT_TEXT = 'Erstelle eine Landingpage für eine Steuerberater-Kanzlei zur KI-Automation.';
const DEFAULT_EXPECTED_TERMS = ['landingpage', 'steuerberater', 'ki-automation'];

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseNumber(name: string, fallback: number): number {
  const value = Number(readArg(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseArgs(): Args {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(`Usage:
  npm run command-eve:smoke:gemma-title -- [options]

Options:
  --base-url URL       Ollama base URL. Default: http://127.0.0.1:11434
  --model MODEL        Model to test. Default: pick command-eve-* from /api/tags.
  --locale de-DE|en-US Prompt locale. Default: de-DE
  --text TEXT          Smoke task text.
  --expect a,b,c       Comma-separated terms; at least one must appear in the title.
  --timeout-ms N       Request timeout. Default: 12000
  --output PATH        JSON receipt path.
`);
    process.exit(0);
  }

  const locale = readArg('locale') === 'en-US' ? 'en-US' : 'de-DE';
  const expectedTerms = (readArg('expect') || DEFAULT_EXPECTED_TERMS.join(','))
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);

  return {
    baseUrl: normalizeBaseUrl(readArg('base-url') || 'http://127.0.0.1:11434'),
    model: readArg('model'),
    locale,
    text: readArg('text') || DEFAULT_TEXT,
    expectedTerms,
    timeoutMs: parseNumber('timeout-ms', 12_000),
    output:
      readArg('output') ||
      path.join(process.cwd(), 'scripts', 'benchmark-results', 'command-eve-gemma-title-smoke-latest.json'),
  };
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pickModel(args: Args): Promise<string> {
  if (args.model) return args.model;
  const response = await withTimeout(args.timeoutMs, (signal) => fetch(`${args.baseUrl}/api/tags`, { signal }));
  if (!response.ok) throw new Error(`TITLE_SMOKE_TAGS_HTTP_${response.status}`);
  const json = (await response.json()) as { models?: Array<{ name?: string }> };
  const model = pickLocalTitleModel((json.models || []).map((item) => String(item?.name || '')));
  if (!model) throw new Error('TITLE_SMOKE_NO_LOCAL_MODEL');
  return model;
}

async function runSmoke(args: Args): Promise<Receipt> {
  const startedAt = performance.now();
  const prompt = buildLocalTitlePrompt(args.text, args.locale);
  const receiptBase = buildReceipt(args);

  try {
    const model = await pickModel(args);
    const response = await withTimeout(args.timeoutMs, (signal) =>
      fetch(`${args.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          messages: [{ role: 'user', content: prompt }],
          options: { num_predict: 24, temperature: 0.2 },
        }),
        signal,
      })
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`TITLE_SMOKE_CHAT_HTTP_${response.status}${body ? `: ${body.slice(0, 240)}` : ''}`);
    }

    const json = (await response.json()) as { message?: { content?: string }; response?: string };
    const raw = json.message?.content || json.response || '';
    const gate = evaluateLocalTitleSmokeGate(raw, args.expectedTerms);
    return {
      ...receiptBase,
      ok: gate.ok,
      reason_code: gate.reason_code,
      result: {
        model,
        prompt_chars: prompt.length,
        raw_output: raw,
        title: gate.title,
        total_ms: Math.round(performance.now() - startedAt),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = smokeReasonFromError(error);
    return {
      ...receiptBase,
      ok: false,
      reason_code: reason,
      result: {
        prompt_chars: prompt.length,
        total_ms: Math.round(performance.now() - startedAt),
        error: message,
      },
    };
  }
}

function smokeReasonFromError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'TITLE_SMOKE_TIMEOUT';
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split(':')[0] || '';
  return first.startsWith('TITLE_SMOKE_') ? first : 'TITLE_SMOKE_FAILED';
}

function buildReceipt(args: Args): Receipt {
  return {
    version: 'command-eve-gemma-title-smoke/v0',
    created_at: new Date().toISOString(),
    ok: false,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      total_memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    },
    args: {
      base_url: args.baseUrl,
      model: args.model,
      locale: args.locale,
      text_chars: args.text.length,
      expected_terms: args.expectedTerms,
      timeout_ms: args.timeoutMs,
    },
    result: {},
  };
}

function writeReceipt(output: string, receipt: Receipt): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
}

const args = parseArgs();

void runSmoke(args)
  .then((receipt) => {
    writeReceipt(args.output, receipt);
    const summary = {
      ok: receipt.ok,
      reason: receipt.reason_code || 'PASS',
      model: receipt.result.model,
      title: receipt.result.title,
      totalMs: receipt.result.total_ms,
      receipt: args.output,
    };
    console.table([summary]);
    if (!receipt.ok) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
