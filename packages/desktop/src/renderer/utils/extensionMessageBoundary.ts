export function resolveTrustedFrameOrigin(url: string | undefined, baseUrl?: string): string | null {
  if (!url) return null;
  try {
    const parsed = baseUrl ? new URL(url, baseUrl) : new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isTrustedFrameMessage(
  event: { source: unknown; origin: string },
  frameWindow: unknown,
  expectedOrigin: string | null
): boolean {
  return Boolean(frameWindow && expectedOrigin && event.source === frameWindow && event.origin === expectedOrigin);
}
