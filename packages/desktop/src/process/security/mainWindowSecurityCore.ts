import { pathToFileURL } from 'node:url';

export type MainRendererUrlPolicy = {
  isPackaged: boolean;
  rendererUrl?: string;
  fallbackFile: string;
};

function parseUrl(value: string, base?: string): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedMainRendererUrl(targetUrl: string, policy: MainRendererUrlPolicy): boolean {
  const target = parseUrl(targetUrl);
  if (!target) return false;

  if (!policy.isPackaged && policy.rendererUrl) {
    const developmentOrigin = parseUrl(policy.rendererUrl)?.origin;
    return Boolean(developmentOrigin && target.origin === developmentOrigin);
  }

  const expected = parseUrl(pathToFileURL(policy.fallbackFile).href);
  if (!expected || target.protocol !== 'file:') return false;
  target.hash = '';
  target.search = '';
  return target.href === expected.href;
}

export function isSafeExternalNavigationUrl(targetUrl: string): boolean {
  const target = parseUrl(targetUrl);
  return Boolean(target && ['https:', 'http:', 'mailto:'].includes(target.protocol));
}

export function isAllowedWebviewSource(targetUrl: string): boolean {
  const target = parseUrl(targetUrl);
  if (!target) return false;
  if (target.protocol === 'about:') return target.href === 'about:blank';
  return ['https:', 'http:', 'file:', 'data:', 'blob:'].includes(target.protocol);
}

export function isAllowedWebviewNavigation(currentUrl: string, targetUrl: string): boolean {
  const target = parseUrl(targetUrl);
  if (!target || !isAllowedWebviewSource(targetUrl)) return false;

  const isBlankBootstrap = currentUrl === '' || currentUrl === 'about:blank';
  if (isBlankBootstrap) {
    return target.protocol === 'https:' || target.protocol === 'http:';
  }

  const current = parseUrl(currentUrl);
  if (!current) return false;
  if (target.href === current.href) return true;

  const currentIsNetworkViewer = current.protocol === 'https:' || current.protocol === 'http:';
  const targetIsNetworkViewer = target.protocol === 'https:' || target.protocol === 'http:';
  return currentIsNetworkViewer && targetIsNetworkViewer && target.origin === current.origin;
}

export function hardenAttachedWebviewPreferences(webPreferences: Record<string, unknown>): void {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.safeDialogs = true;
  webPreferences.navigateOnDragDrop = false;
  webPreferences.enableWebSQL = false;
}
