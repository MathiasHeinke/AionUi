/**
 * Security helpers for model-generated HTML previews.
 *
 * Artifact HTML is untrusted content. Keep its local resource reads inside the
 * artifact workspace and render it with a network-denying CSP.
 */

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const MAX_CONSOLE_MESSAGE_LENGTH = 128 * 1024;
const MAX_INSPECTED_HTML_LENGTH = 64 * 1024;
const MAX_ARTIFACT_DIMENSION = 100_000_000;

export const ARTIFACT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  'font-src data:',
  "form-action 'none'",
  "frame-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "object-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'worker-src blob:',
].join('; ');

interface NormalizedPath {
  path: string;
  windows: boolean;
}

export type ArtifactConsoleMessage =
  | { kind: 'inspect'; html: string; tag: string }
  | { kind: 'scroll'; scrollTop: number; scrollHeight: number; clientHeight: number }
  | { kind: 'height'; height: number };

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isArtifactDimension(value: unknown, allowZero = true): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= MAX_ARTIFACT_DIMENSION
  );
}

/** Parse the intentionally narrow console bridge emitted by artifact previews. */
export function parseArtifactConsoleMessage(message: unknown): ArtifactConsoleMessage | null {
  if (typeof message !== 'string' || message.length === 0 || message.length > MAX_CONSOLE_MESSAGE_LENGTH) {
    return null;
  }

  if (message.startsWith('__INSPECT_ELEMENT__')) {
    const record = parseRecord(message.slice('__INSPECT_ELEMENT__'.length));
    if (!record || typeof record.html !== 'string' || typeof record.tag !== 'string') return null;
    if (record.html.length > MAX_INSPECTED_HTML_LENGTH || record.tag.length > 128) return null;
    return { kind: 'inspect', html: record.html, tag: record.tag };
  }

  if (message.startsWith('__SCROLL_SYNC__')) {
    const record = parseRecord(message.slice('__SCROLL_SYNC__'.length));
    if (
      !record ||
      !isArtifactDimension(record.scrollTop) ||
      !isArtifactDimension(record.scrollHeight) ||
      !isArtifactDimension(record.clientHeight)
    ) {
      return null;
    }
    return {
      kind: 'scroll',
      scrollTop: record.scrollTop,
      scrollHeight: record.scrollHeight,
      clientHeight: record.clientHeight,
    };
  }

  if (message.startsWith('__CONTENT_HEIGHT__')) {
    const height = Number(message.slice('__CONTENT_HEIGHT__'.length));
    return isArtifactDimension(height, false) ? { kind: 'height', height } : null;
  }

  return null;
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeAbsolutePath(value: string): NormalizedPath | null {
  const withoutFileScheme = value.replace(/^file:\/\//i, '');
  const decoded = decodePath(withoutFileScheme);
  if (!decoded || hasControlCharacters(decoded)) return null;

  let normalized = decoded.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:\//.test(normalized)) normalized = normalized.slice(1);

  const windows = /^[a-zA-Z]:\//.test(normalized);
  if (!windows && !normalized.startsWith('/')) return null;

  const prefix = windows ? normalized.slice(0, 2).toUpperCase() : '';
  const rawSegments = (windows ? normalized.slice(2) : normalized).split('/');
  const segments: string[] = [];

  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return {
    path: windows ? `${prefix}/${segments.join('/')}` : `/${segments.join('/')}`,
    windows,
  };
}

function directoryOf(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf('/');
  if (separatorIndex <= 0) return filePath.slice(0, separatorIndex + 1);
  return filePath.slice(0, separatorIndex);
}

function isPathInside(candidate: NormalizedPath, root: NormalizedPath): boolean {
  if (candidate.windows !== root.windows) return false;
  const candidatePath = candidate.windows ? candidate.path.toLowerCase() : candidate.path;
  const rootPath = root.windows ? root.path.toLowerCase() : root.path;
  const rootPrefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return candidatePath === rootPath || candidatePath.startsWith(rootPrefix);
}

/**
 * Resolve an artifact-relative resource without allowing absolute paths or a
 * traversal outside the declared workspace. Without a workspace, the HTML
 * file's own directory is the boundary.
 */
export function resolveArtifactResourcePath(
  baseFilePath: string,
  resourceReference: string,
  workspace?: string
): string | null {
  if (!baseFilePath || !resourceReference || hasControlCharacters(resourceReference)) return null;

  const pathOnly = resourceReference.split(/[?#]/, 1)[0]?.trim();
  if (!pathOnly) return null;
  const decodedReference = decodePath(pathOnly);
  if (!decodedReference || hasControlCharacters(decodedReference)) return null;
  if (
    URL_SCHEME_PATTERN.test(decodedReference) ||
    decodedReference.startsWith('/') ||
    decodedReference.startsWith('\\')
  ) {
    return null;
  }

  const base = normalizeAbsolutePath(baseFilePath);
  if (!base) return null;
  const baseDirectory = directoryOf(base.path);
  const boundary = workspace ? normalizeAbsolutePath(workspace) : normalizeAbsolutePath(baseDirectory);
  if (!boundary || !isPathInside(base, boundary)) return null;

  const candidate = normalizeAbsolutePath(`${baseDirectory}/${decodedReference}`);
  if (!candidate || !isPathInside(candidate, boundary)) return null;
  return candidate.path;
}

/** Add the restrictive policy before any artifact markup can load resources. */
export function secureArtifactHtml(html: string): string {
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CONTENT_SECURITY_POLICY}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${cspTag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${cspTag}</head>`);
  }
  return `<head>${cspTag}</head>${html}`;
}
