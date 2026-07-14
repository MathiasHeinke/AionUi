// Command EVE - eve-title gateway core (pure).
//
// Server-side title generation is app-billed and must never use a provider key
// from the desktop app. This core keeps request validation, prompt shaping, and
// output sanitization testable without network or Supabase runtime access.

export type EveTitleLocale = 'de-DE' | 'en-US';

export const EVE_TITLE_TEXT_MAX_CHARS = 1000;
export const EVE_TITLE_MAX_CHARS = 48;
export const EVE_TITLE_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export type EveTitleRequest = {
  text: string;
  locale: EveTitleLocale;
};

export type EveTitlePrepareResult =
  | { ok: true; request: EveTitleRequest }
  | { ok: false; error: string; status: number };

const FORBIDDEN_PROVIDER_KEY_FIELDS = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'openrouter-api-key',
  'openrouterApiKey',
  'openrouter_api_key',
  'provider-key',
  'providerKey',
  'provider_key',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenProviderKeyField(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenProviderKeyField(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    return (
      FORBIDDEN_PROVIDER_KEY_FIELDS.has(key) ||
      FORBIDDEN_PROVIDER_KEY_FIELDS.has(key.toLowerCase()) ||
      containsForbiddenProviderKeyField(nested, depth + 1)
    );
  });
}

export function normalizeEveTitleLocale(value: unknown): EveTitleLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en-US' : 'de-DE';
}

export function prepareEveTitleText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\b(api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]')
    .slice(0, EVE_TITLE_TEXT_MAX_CHARS)
    .trim();
  return normalized || null;
}

export function prepareEveTitleRequestBody(body: unknown): EveTitlePrepareResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'invalid_request', status: 400 };
  }
  if (containsForbiddenProviderKeyField(body)) {
    return { ok: false, error: 'provider_key_field', status: 400 };
  }
  const text = prepareEveTitleText(body.text);
  if (!text) {
    return { ok: false, error: 'missing_text', status: 400 };
  }
  return {
    ok: true,
    request: {
      text,
      locale: normalizeEveTitleLocale(body.locale),
    },
  };
}

export function buildEveTitlePrompt(request: EveTitleRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const language = request.locale === 'en-US' ? 'English' : 'German';
  return [
    {
      role: 'system',
      content: [
        'You generate short chat session titles for Command EVE.',
        `Return one ${language} title only.`,
        'Use 3-6 words, no quotes, no markdown, no trailing punctuation.',
        'Do not include secrets, provider names, model names, or labels like Title:',
      ].join(' '),
    },
    {
      role: 'user',
      content: request.text,
    },
  ];
}

export function sanitizeEveGeneratedTitle(raw: unknown): string | null {
  let text = String(raw ?? '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const firstLine = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  let title = firstLine
    .replace(/^\s*(titel|title)\s*[:：]\s*/i, '')
    .replace(/^[#>*\-\d.\s]+/u, '')
    .replace(/^["'“”«»‟]+/u, '')
    .replace(/["'“”«»‟]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。!！?？,;:、]+$/u, '')
    .trim();

  if (!title) return null;
  const words = title.split(' ').filter(Boolean);
  if (words.length > 8) {
    title = words.slice(0, 8).join(' ');
  }
  if (title.length > EVE_TITLE_MAX_CHARS) {
    title = title.slice(0, EVE_TITLE_MAX_CHARS).trim();
  }
  return title.length >= 2 ? title : null;
}
