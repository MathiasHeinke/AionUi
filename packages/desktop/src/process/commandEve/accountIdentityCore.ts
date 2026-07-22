export type CommandEveProfileNameSource = 'explicit' | 'account_metadata' | 'email_fallback';

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function titleCase(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Legacy auth builds derived this candidate from the address local-part. */
export function deriveEmailFallbackName(email: string): string {
  const localPart = normalize(email).split('@')[0] || '';
  return titleCase(localPart);
}

export function isConfirmedCommandEveProfileName(input: {
  name?: string;
  email?: string;
  source?: CommandEveProfileNameSource;
}): boolean {
  const name = normalize(input.name);
  if (!name) return false;
  if (input.source === 'email_fallback') return false;
  if (input.source === 'explicit' || input.source === 'account_metadata') return true;

  // Backward-compatible migration rule for records created before provenance
  // existed: exact email-local-part guesses are treated conservatively as
  // unconfirmed; every other legacy value remains a confirmed explicit name.
  const legacyEmailGuess = deriveEmailFallbackName(input.email || '');
  return !legacyEmailGuess || name.localeCompare(legacyEmailGuess, undefined, { sensitivity: 'accent' }) !== 0;
}

/** Explicit local registration outranks account metadata; guesses are omitted. */
export function resolveCommandEveDisplayIdentity(input: {
  registrationName?: string;
  registrationNameSource?: CommandEveProfileNameSource;
  sessionName?: string;
  email?: string;
}): { name?: string; nameConfirmed: boolean; source?: CommandEveProfileNameSource } {
  const registrationName = normalize(input.registrationName);
  if (
    isConfirmedCommandEveProfileName({
      name: registrationName,
      email: input.email,
      source: input.registrationNameSource,
    })
  ) {
    return { name: registrationName, nameConfirmed: true, source: input.registrationNameSource ?? 'explicit' };
  }

  const sessionName = normalize(input.sessionName);
  if (sessionName) return { name: sessionName, nameConfirmed: true, source: 'account_metadata' };
  return { nameConfirmed: false };
}
