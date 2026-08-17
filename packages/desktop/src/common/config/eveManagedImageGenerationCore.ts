/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TProviderWithModel } from './storage';
import type { CommandEvePrivacyLane } from './eveMultimodalGatewayCore';
import type { CommandEveImageModelTierId } from './eveImageModelRegistryCore';
import type { CommandEveActiveImageArtifact } from './managedImageArtifactCore';

export const COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID = 'command-eve-managed-image';
export const COMMAND_EVE_MANAGED_IMAGE_PLATFORM = 'command-eve-managed-image';
export const COMMAND_EVE_MANAGED_IMAGE_MODEL = 'command-eve-visual-direction-v1';
export const COMMAND_EVE_MANAGED_IMAGE_VERSION = 'command-eve-managed-image/v1' as const;
export const COMMAND_EVE_MANAGED_IMAGE_ENABLED = true;
export const COMMAND_EVE_MANAGED_IMAGE_GATEWAY_DEPLOYED = true;
export const COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const COMMAND_EVE_MANAGED_IMAGE_MAX_PROMPT_CHARS = 12_000;
export const COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES = 4;

export const COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;
export const COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS = ['1K', '2K'] as const;
export const COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type CommandEveManagedImageAspectRatio = (typeof COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS)[number];
export type CommandEveManagedImageResolution = (typeof COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS)[number];
export type CommandEveManagedImageMimeType = (typeof COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES)[number];

/**
 * Renderer -> Main contract for one explicit composer image turn. Provider
 * slugs, credentials and output paths are intentionally absent: Main resolves
 * the requested tier against the live server registry and returns only the
 * conversation-scoped artifact record.
 */
export type CommandEveImageGenerateRequest = {
  prompt: string;
  conversationId: string;
  requestId: string;
  tierId: CommandEveImageModelTierId;
  resolution: CommandEveManagedImageResolution;
  aspectRatio: CommandEveManagedImageAspectRatio;
  /** Local paths are accepted only when Main still holds a read grant. */
  referenceImagePaths?: string[];
};

export type CommandEveImageGenerateFailureArtifactState =
  | 'none'
  | 'creation_unverified'
  | 'created_not_stored'
  | 'stored_not_bound'
  /**
   * Generated, debited AND durably bound — but withheld from the caller because
   * the active seat changed before delivery. The artifact is intact in the
   * capturing seat's conversation, so this is the one failure state that must
   * never invite a retry: a retry would pay for the same image twice.
   */
  | 'stored_and_bound';

export type CommandEveImageGenerateResult =
  | {
      ok: true;
      requestId: string;
      artifact: CommandEveActiveImageArtifact;
      /** True only when Main returned a completed request-id replay. */
      alreadyCompleted: boolean;
    }
  | {
      ok: false;
      requestId?: string;
      reasonCode: string;
      message: string;
      retryable: boolean;
      /** Distinguishes provider/store/bind failures without claiming a lost artifact never existed. */
      artifactState: CommandEveImageGenerateFailureArtifactState;
    };

export type CommandEveManagedImageReference = {
  mime_type: CommandEveManagedImageMimeType;
  sha256: string;
  data_base64: string;
};

export type CommandEveManagedImageEdgeRequest = {
  provider: 'openrouter';
  capability: 'image_generation';
  privacyLane: CommandEvePrivacyLane;
  directProviderKeyPresentInDesktop: false;
  requestId: string;
  prompt: string;
  aspect_ratio: CommandEveManagedImageAspectRatio;
  resolution: CommandEveManagedImageResolution;
  input_references: CommandEveManagedImageReference[];
  /**
   * The seat's image model choice as the BARE TIER ID (MAT-1769, CoS
   * contract). Resolved MAIN-SIDE against the server-owned registry
   * immediately before the request; the server owns tier → slug resolution
   * authoritatively, so a slug never travels — a slug the client could name
   * would be a slug the registry never priced. The shim-facing model name
   * stays `command-eve-visual-direction-v1`; the agent/shim contract never
   * sees this field.
   */
  image_model: CommandEveImageModelTierId;
};

export type CommandEveManagedImageArtifact = {
  status: 'created';
  kind: 'image';
  mime_type: CommandEveManagedImageMimeType;
  encoding: 'base64';
  data_base64: string;
  bytes: number;
  sha256: string;
};

export type CommandEveManagedImageReceipt = {
  model: string;
  prompt_sha256: string;
  aspect_ratio: CommandEveManagedImageAspectRatio;
  resolution: CommandEveManagedImageResolution;
  input_reference_count: number;
  input_reference_sha256: string[];
  zdr_enforced: true;
  data_collection: 'deny';
  cost_usd?: number;
};

export type CommandEveManagedImageEdgeSuccess = {
  ok: true;
  provider: 'openrouter';
  capability: 'image_generation';
  reason: 'provider-complete';
  artifact: CommandEveManagedImageArtifact;
  image_generation: CommandEveManagedImageReceipt;
  residency: {
    requestedPrivacyLane: 'cloud_auto';
    effectiveResidency: 'global_cloud';
    confirmation: 'zdr-enforced-global';
  };
};

export type CommandEveManagedImageParseResult =
  | { ok: true; data: CommandEveManagedImageEdgeSuccess }
  | { ok: false; reason_code: string; message?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodedBase64ByteLength(value: string): number | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((value.length * 3) / 4) - padding;
  return bytes > 0 ? bytes : null;
}

export function getCommandEveManagedImageProvider(): TProviderWithModel {
  return {
    id: COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
    name: 'EVE Visual Directions',
    platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
    base_url: 'http://127.0.0.1:25811/v1',
    api_key: '',
    use_model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
    enabled: true,
    is_full_url: false,
  };
}

export function parseCommandEveManagedImageEdgeResponse(raw: unknown): CommandEveManagedImageParseResult {
  if (!isRecord(raw)) {
    return { ok: false, reason_code: 'EVE_MANAGED_IMAGE_BAD_BODY' };
  }
  if (raw.ok !== true) {
    return {
      ok: false,
      reason_code: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'EVE_MANAGED_IMAGE_FAILED',
      ...(typeof raw.message === 'string' && raw.message.trim() ? { message: raw.message.trim().slice(0, 300) } : {}),
    };
  }
  if (
    raw.provider !== 'openrouter' ||
    raw.capability !== 'image_generation' ||
    raw.reason !== 'provider-complete' ||
    !isRecord(raw.artifact) ||
    !isRecord(raw.image_generation) ||
    !isRecord(raw.residency)
  ) {
    return { ok: false, reason_code: 'EVE_MANAGED_IMAGE_BAD_SUCCESS_SHAPE' };
  }
  const artifact = raw.artifact;
  const receipt = raw.image_generation;
  const mimeType = typeof artifact.mime_type === 'string' ? artifact.mime_type.toLowerCase() : '';
  const dataBase64 = typeof artifact.data_base64 === 'string' ? artifact.data_base64 : '';
  const bytes = Number(artifact.bytes);
  const decodedBytes = decodedBase64ByteLength(dataBase64);
  const referenceHashes = Array.isArray(receipt.input_reference_sha256)
    ? receipt.input_reference_sha256.filter((value): value is string => typeof value === 'string')
    : [];
  if (
    artifact.status !== 'created' ||
    artifact.kind !== 'image' ||
    artifact.encoding !== 'base64' ||
    !COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES.includes(mimeType as CommandEveManagedImageMimeType) ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    decodedBytes !== bytes ||
    typeof artifact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof receipt.model !== 'string' ||
    !receipt.model.trim() ||
    typeof receipt.prompt_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.prompt_sha256) ||
    !COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.includes(receipt.aspect_ratio as CommandEveManagedImageAspectRatio) ||
    !COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS.includes(receipt.resolution as CommandEveManagedImageResolution) ||
    !Number.isInteger(receipt.input_reference_count) ||
    receipt.input_reference_count !== referenceHashes.length ||
    referenceHashes.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    receipt.zdr_enforced !== true ||
    receipt.data_collection !== 'deny' ||
    raw.residency.requestedPrivacyLane !== 'cloud_auto' ||
    raw.residency.effectiveResidency !== 'global_cloud' ||
    raw.residency.confirmation !== 'zdr-enforced-global'
  ) {
    return { ok: false, reason_code: 'EVE_MANAGED_IMAGE_INVALID_ARTIFACT' };
  }
  return { ok: true, data: raw as CommandEveManagedImageEdgeSuccess };
}
