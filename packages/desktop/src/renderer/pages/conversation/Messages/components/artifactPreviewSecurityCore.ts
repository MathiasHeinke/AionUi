import type { IGeneratedArtifactType } from '@/common/adapter/ipcBridge';

const MAX_NETWORK_SOURCE_LENGTH = 8 * 1024;
const MAX_DATA_SOURCE_LENGTH = 64 * 1024 * 1024;
const MIME_PREFIX_BY_TYPE: Partial<Record<IGeneratedArtifactType, string>> = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
  html: 'text/html',
};

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function sanitizeArtifactPreviewSource(
  value: string | undefined,
  type: IGeneratedArtifactType
): string | undefined {
  if (!value) return undefined;
  const source = value.trim();
  if (!source || hasControlCharacters(source)) return undefined;

  if (source.toLowerCase().startsWith('data:')) {
    if (source.length > MAX_DATA_SOURCE_LENGTH) return undefined;
    const expectedMimePrefix = MIME_PREFIX_BY_TYPE[type];
    if (!expectedMimePrefix) return undefined;
    const mediaType = source.slice(5, source.indexOf(',')).split(';', 1)[0]?.toLowerCase();
    return mediaType?.startsWith(expectedMimePrefix) ? source : undefined;
  }

  if (source.length > MAX_NETWORK_SOURCE_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }

  if (!['https:', 'http:', 'file:', 'blob:'].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.protocol === 'file:' && parsed.hostname && parsed.hostname !== 'localhost') return undefined;
  return parsed.href;
}
