import crypto from 'node:crypto';
import { verifyLicenseCode } from '../../_shared/license-code-core.ts';

let cachedPublicKeyPem: string | null = null;

export function resetEveMultimodalPublicKeyCacheForTests(): void {
  cachedPublicKeyPem = null;
}

function publicKeyPem(): string {
  if (cachedPublicKeyPem) return cachedPublicKeyPem;
  const signingKeyPem = Deno.env.get('COMMAND_EVE_LICENSE_SIGNING_KEY');
  if (!signingKeyPem) {
    throw new Error('signing_key_not_configured');
  }
  cachedPublicKeyPem = crypto.createPublicKey(signingKeyPem).export({ type: 'spki', format: 'pem' }) as string;
  return cachedPublicKeyPem;
}

export function verifyEveMultimodalLicense(wire: string, now: string): ReturnType<typeof verifyLicenseCode> {
  return verifyLicenseCode({
    code: wire,
    publicKeyPem: publicKeyPem(),
    now,
  });
}

export function requestIdFromBody(body: unknown): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const requestId = (body as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string' && requestId.trim().length > 0) {
      return requestId.trim();
    }
  }
  return crypto.randomUUID();
}
