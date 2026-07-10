import { describe, expect, it } from 'vitest';
import { parseDeepLinkUrl, PROTOCOL_SCHEME } from '@/process/utils/deepLink';

function link(path: string): string {
  return `${PROTOCOL_SCHEME}://${path}`;
}

describe('deep-link security', () => {
  it('accepts the supported provider formats with bounded string fields', () => {
    expect(parseDeepLinkUrl(link('add-provider?base_url=https%3A%2F%2Fapi.example.com&api_key=sk-test'))).toEqual({
      action: 'add-provider',
      params: { base_url: 'https://api.example.com', api_key: 'sk-test' },
    });

    const data = Buffer.from(JSON.stringify({ base_url: 'http://127.0.0.1:11434', key: 'local-key' })).toString(
      'base64'
    );
    expect(parseDeepLinkUrl(link(`provider/add?v=1&data=${encodeURIComponent(data)}`))).toEqual({
      action: 'provider/add',
      params: { v: '1', base_url: 'http://127.0.0.1:11434', key: 'local-key' },
    });
  });

  it('drops prototype keys and non-string data fields', () => {
    const data = Buffer.from(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"api_key":"safe"}'
    ).toString('base64');
    const parsed = parseDeepLinkUrl(link(`add-provider?data=${encodeURIComponent(data)}`));
    expect(parsed).toEqual({ action: 'add-provider', params: { api_key: 'safe' } });
    if (!parsed) throw new Error('expected the deep link to parse');
    expect((parsed.params as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects unsupported actions, unsafe navigation and oversized input', () => {
    expect(parseDeepLinkUrl(link('run-command?command=rm'))).toBeNull();
    expect(parseDeepLinkUrl(link('navigate?route=%2Fsettings%2Fmodel'))).toBeNull();
    expect(parseDeepLinkUrl(link('navigate?route=%2Fconversation%2Fconv-123'))).toEqual({
      action: 'navigate',
      params: { route: '/conversation/conv-123' },
    });
    expect(parseDeepLinkUrl(link(`add-provider?api_key=${'x'.repeat(9000)}`))).toEqual({
      action: 'add-provider',
      params: {},
    });
    expect(parseDeepLinkUrl(`${PROTOCOL_SCHEME}://${'x'.repeat(17 * 1024)}`)).toBeNull();
  });
});
