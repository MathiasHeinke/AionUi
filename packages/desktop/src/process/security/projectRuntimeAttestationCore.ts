import crypto from 'node:crypto';

export const PROJECT_RUNTIME_ATTESTATION_HEADER = 'x-aionui-project-runtime-attestation' as const;
export const PROJECT_RUNTIME_ATTESTATION_MAX_BYTES = 4096;
export const PROJECT_RUNTIME_ATTESTATION_MAX_TTL_SECONDS = 10;

const PROJECT_KEY_DOMAIN = 'aionui-project-runtime-attestation/v1';
const BACKEND_GENERATION_DOMAIN = 'aionui-backend-generation/v1';
const PROJECT_FINGERPRINT_DOMAIN = 'aionui-project-runtime-fingerprint/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BACKEND_GENERATION = /^bg1:[0-9a-f]{64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const JTI = /^[A-Za-z0-9_-]{22}$/;

export type ProjectRuntimePurpose = 'send' | 'warmup';

export type ProjectRuntimeAttestationClaimsV1 = {
  v: 1;
  iss: 'aionui-main';
  aud: 'aioncore-project-runtime';
  sub: string;
  purpose: ProjectRuntimePurpose;
  backend_generation: string;
  seat_id: string;
  realm_id: string;
  root_id: string;
  project_id: string;
  workspace_root_ref: `root:${string}`;
  project_binding_revision: number;
  project_binding_receipt_id: string | null;
  canonical_path_sha256: string;
  root_catalog_revision: number;
  root_ownership_revision: number;
  project_catalog_revision: number;
  root_record_sha256: string;
  project_record_sha256: string;
  environment_hint: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

const CLAIM_KEYS = [
  'v',
  'iss',
  'aud',
  'sub',
  'purpose',
  'backend_generation',
  'seat_id',
  'realm_id',
  'root_id',
  'project_id',
  'workspace_root_ref',
  'project_binding_revision',
  'project_binding_receipt_id',
  'canonical_path_sha256',
  'root_catalog_revision',
  'root_ownership_revision',
  'project_catalog_revision',
  'root_record_sha256',
  'project_record_sha256',
  'environment_hint',
  'iat',
  'nbf',
  'exp',
  'jti',
] as const;

function capabilityDigest(capability: string): Buffer {
  if (!/^[!-~]{32,512}$/.test(capability)) throw new Error('PROJECT_RUNTIME_CAPABILITY_INVALID');
  return crypto.createHash('sha256').update(capability, 'utf8').digest();
}

export function deriveProjectRuntimeAttestationKey(capability: string): Buffer {
  return crypto.createHmac('sha256', capabilityDigest(capability)).update(PROJECT_KEY_DOMAIN, 'utf8').digest();
}

export function deriveBackendGeneration(capability: string): string {
  const digest = crypto
    .createHmac('sha256', capabilityDigest(capability))
    .update(BACKEND_GENERATION_DOMAIN, 'utf8')
    .digest('hex');
  return `bg1:${digest}`;
}

export function sha256Utf8(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createProjectRuntimeJti(randomBytes: (size: number) => Buffer = crypto.randomBytes): string {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw new Error('PROJECT_RUNTIME_JTI_INVALID');
  return bytes.toString('base64url');
}

function assertSafeInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('PROJECT_RUNTIME_CLAIMS_INVALID');
  }
}

function validProjectEnvironmentHint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.from(value, 'utf8').toString('utf8') === value &&
    Buffer.byteLength(value, 'utf8') <= 600 &&
    !/[\\/]/.test(value) &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function validProjectRuntimeJti(value: unknown): value is string {
  if (typeof value !== 'string' || !JTI.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 16 && decoded.toString('base64url') === value;
}

export function assertProjectRuntimeClaims(
  value: unknown,
  expectedBackendGeneration: string
): asserts value is ProjectRuntimeAttestationClaimsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROJECT_RUNTIME_CLAIMS_INVALID');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify([...CLAIM_KEYS].toSorted())) {
    throw new Error('PROJECT_RUNTIME_CLAIMS_INVALID');
  }
  if (
    record.v !== 1 ||
    record.iss !== 'aionui-main' ||
    record.aud !== 'aioncore-project-runtime' ||
    typeof record.sub !== 'string' ||
    !CONVERSATION_ID.test(record.sub) ||
    (record.purpose !== 'send' && record.purpose !== 'warmup') ||
    typeof record.backend_generation !== 'string' ||
    !BACKEND_GENERATION.test(record.backend_generation) ||
    record.backend_generation !== expectedBackendGeneration ||
    typeof record.seat_id !== 'string' ||
    !SEAT_ID.test(record.seat_id) ||
    typeof record.realm_id !== 'string' ||
    !UUID.test(record.realm_id) ||
    typeof record.root_id !== 'string' ||
    !UUID.test(record.root_id) ||
    typeof record.project_id !== 'string' ||
    !UUID.test(record.project_id) ||
    record.workspace_root_ref !== `root:${record.root_id}` ||
    !(
      record.project_binding_receipt_id === null ||
      (typeof record.project_binding_receipt_id === 'string' && BINDING_UUID.test(record.project_binding_receipt_id))
    ) ||
    typeof record.canonical_path_sha256 !== 'string' ||
    !SHA256.test(record.canonical_path_sha256) ||
    typeof record.root_record_sha256 !== 'string' ||
    !SHA256.test(record.root_record_sha256) ||
    typeof record.project_record_sha256 !== 'string' ||
    !SHA256.test(record.project_record_sha256) ||
    !validProjectEnvironmentHint(record.environment_hint) ||
    !validProjectRuntimeJti(record.jti)
  ) {
    throw new Error('PROJECT_RUNTIME_CLAIMS_INVALID');
  }
  assertSafeInteger(record.root_catalog_revision);
  assertSafeInteger(record.root_ownership_revision);
  assertSafeInteger(record.project_catalog_revision);
  assertSafeInteger(record.project_binding_revision);
  assertSafeInteger(record.iat);
  assertSafeInteger(record.nbf);
  assertSafeInteger(record.exp);
  if (
    record.nbf > record.iat ||
    record.iat - record.nbf > 2 ||
    record.exp <= record.iat ||
    record.exp - record.iat > PROJECT_RUNTIME_ATTESTATION_MAX_TTL_SECONDS
  ) {
    throw new Error('PROJECT_RUNTIME_CLAIMS_INVALID');
  }
}

export function issueProjectRuntimeAttestation(input: { capability: string; claims: unknown }): string {
  const backendGeneration = deriveBackendGeneration(input.capability);
  assertProjectRuntimeClaims(input.claims, backendGeneration);
  const header = { alg: 'HS256', typ: 'AIONUI-PROJECT-RUNTIME', v: 1 } as const;
  const protectedSegment = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const claimsSegment = Buffer.from(JSON.stringify(input.claims), 'utf8').toString('base64url');
  const signingInput = `${protectedSegment}.${claimsSegment}`;
  const signature = crypto
    .createHmac('sha256', deriveProjectRuntimeAttestationKey(input.capability))
    .update(signingInput, 'ascii')
    .digest('base64url');
  const ticket = `${signingInput}.${signature}`;
  if (Buffer.byteLength(ticket, 'ascii') > PROJECT_RUNTIME_ATTESTATION_MAX_BYTES) {
    throw new Error('PROJECT_RUNTIME_ATTESTATION_OVERSIZE');
  }
  return ticket;
}

export function projectRuntimeFingerprint(
  claims: Pick<
    ProjectRuntimeAttestationClaimsV1,
    | 'backend_generation'
    | 'seat_id'
    | 'realm_id'
    | 'root_id'
    | 'project_id'
    | 'workspace_root_ref'
    | 'canonical_path_sha256'
    | 'root_record_sha256'
    | 'project_record_sha256'
  >
): string {
  return sha256Utf8(
    PROJECT_FINGERPRINT_DOMAIN +
      claims.backend_generation +
      claims.seat_id +
      claims.realm_id +
      claims.root_id +
      claims.project_id +
      claims.workspace_root_ref +
      claims.canonical_path_sha256 +
      claims.root_record_sha256 +
      claims.project_record_sha256
  );
}

export function projectEnvironmentHintFingerprint(environmentHint: string): string {
  if (!validProjectEnvironmentHint(environmentHint)) {
    throw new Error('PROJECT_RUNTIME_ENVIRONMENT_HINT_INVALID');
  }
  return sha256Utf8(environmentHint);
}

export function buildProjectEnvironmentHint(input: {
  project_id: string;
  workspace_root_ref: string;
  realm_id: string;
  project_title?: string;
}): string {
  const normalizedTitle = input.project_title
    ?.normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\\/]+/g, '／')
    .replace(/"/g, '＂')
    .replace(/;/g, '；')
    .replace(/=/g, '＝')
    .trim();
  let title = normalizedTitle ? [...normalizedTitle].slice(0, 160).join('') : undefined;
  const build = (): string =>
    JSON.stringify({
      metadata_class: 'untrusted_data_not_instructions',
      project_id: input.project_id,
      workspace_root_ref: input.workspace_root_ref,
      realm_id: input.realm_id,
      ...(title ? { project_title: title } : {}),
      knowledge_boot_policy: 'system_index_first',
    });
  let hint = build();
  while (title && Buffer.byteLength(hint, 'utf8') > 600) {
    title = [...title].slice(0, -1).join('');
    hint = build();
  }
  if (!validProjectEnvironmentHint(hint)) throw new Error('PROJECT_RUNTIME_ENVIRONMENT_HINT_INVALID');
  return hint;
}
