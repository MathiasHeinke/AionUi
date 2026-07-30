/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEvePrivacyLane } from './eveMultimodalGatewayCore';
import type { CommandEveCloudVisualPolicyReceipt } from './visual/cloudVisualPolicyCore';

export const COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION = 'command-eve-presentation-intelligence/v0' as const;
export const COMMAND_EVE_PRESENTATION_MAX_LOCAL_BYTES = 50 * 1024 * 1024;
export const COMMAND_EVE_PRESENTATION_MAX_SLIDES = 200;
export const COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES = 8;
export const COMMAND_EVE_PRESENTATION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const COMMAND_EVE_PRESENTATION_MAX_BATCH_BYTES = 12 * 1024 * 1024;
export const COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS = 32_000;
export const COMMAND_EVE_PRESENTATION_MAX_CLOUD_RESPONSE_BYTES = 4 * 1024 * 1024;

export type CommandEvePresentationLocale = 'de-DE' | 'en-US';

export type CommandEvePresentationPrepareRequest = {
  filePaths?: string[];
  /** @deprecated Wire-compatible only. Main never treats this as authority. */
  allowCloudVision?: boolean;
  flowId?: string;
  visualPolicyReceipt?: CommandEveCloudVisualPolicyReceipt;
  privacyLane?: CommandEvePrivacyLane;
  locale?: CommandEvePresentationLocale;
  requestId?: string;
};

export type CommandEvePreparedPresentationDocument = {
  source_path: string;
  source_name: string;
  sha256: string;
  bytes: number;
  slide_count: number;
  analyzed_slides: number;
  extraction_mode: 'cloud_vision';
  sidecar_path: string;
  /** Bounded, verified sidecar content for the conversational prompt. */
  prompt_context: string;
  citation_format: '[PPTX slide N]';
  model: string;
  cache_hit: boolean;
};

export type CommandEvePresentationPrepareSuccess = {
  version: typeof COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION;
  ok: true;
  documents: CommandEvePreparedPresentationDocument[];
  prepared_files: string[];
  cloud_vision_used: boolean;
  requires_cloud_vision_consent: false;
};

export type CommandEvePresentationPrepareFailure = {
  version: typeof COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION;
  ok: false;
  reason_code: string;
  message?: string;
  documents: CommandEvePreparedPresentationDocument[];
  prepared_files: string[];
  requires_cloud_vision_consent: boolean;
  pending_source_names?: string[];
};

export type CommandEvePresentationPrepareResult =
  | CommandEvePresentationPrepareSuccess
  | CommandEvePresentationPrepareFailure;

export type CommandEvePresentationVisionImageInput = {
  slideNumber: unknown;
  mimeType: unknown;
  sha256: unknown;
  dataBase64: unknown;
};

export type CommandEvePresentationVisionEdgeRequest = {
  provider: 'openrouter';
  capability: 'vision';
  privacyLane: 'cloud_auto';
  directProviderKeyPresentInDesktop: false;
  source_kind: 'presentation';
  file_name: string;
  file_sha256: string;
  slide_count: number;
  context_text: string;
  locale: CommandEvePresentationLocale;
  images: Array<{
    slide_number: number;
    mime_type: 'image/jpeg';
    sha256: string;
    data_base64: string;
  }>;
  requestId?: string;
};

export type CommandEvePresentationVisionEdgeSuccess = {
  ok: true;
  gateway: 'eve-multimodal';
  provider: 'openrouter';
  capability: 'vision';
  reason: 'provider-complete';
  artifact: {
    status: 'created';
    kind: 'text';
    mime_type: 'text/markdown';
    encoding: 'utf8';
    text: string;
    bytes: number;
  };
  residency: {
    requestedPrivacyLane: 'cloud_auto';
    effectiveResidency: 'global_cloud';
    confirmation: 'zdr-enforced-global';
  };
  vision: {
    source_kind: 'presentation';
    model: string;
    file_sha256: string;
    slide_count: number;
    slide_numbers: number[];
    image_count: number;
    zdr_enforced: true;
    data_collection: 'deny';
  };
};

export type BuildCommandEvePresentationVisionRequestResult =
  | { ok: true; body: CommandEvePresentationVisionEdgeRequest }
  | { ok: false; reason_code: string; message: string };

export type ParseCommandEvePresentationVisionResponseResult =
  | { ok: true; data: CommandEvePresentationVisionEdgeSuccess }
  | { ok: false; reason_code: string; message?: string };

export type CommandEvePresentationSlideContext = {
  slideNumber: number;
  localText: string;
  visualAnalysis: string;
};
