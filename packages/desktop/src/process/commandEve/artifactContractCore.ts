/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE artifact-first contract (1.7.6 SG-04).
 *
 * Work-product requests must end in a visible artifact card or a visible failure
 * artifact. This core is pure and aligns its output with MessageGeneratedArtifact's
 * existing payload vocabulary.
 */

import type { SensitivityClass } from './runtimeGateCore';

export type GeneratedArtifactType = 'image' | 'video' | 'audio' | 'html' | 'file' | 'report' | 'failure';
export type RendererGeneratedArtifactType = 'image' | 'video' | 'audio' | 'html' | 'file';
export type GeneratedArtifactRoute = 'local' | 'openrouter' | 'xai' | 'claude' | 'hermes' | 'unknown';
export type GeneratedArtifactStatus = 'pending' | 'done' | 'failed' | 'blocked';
export type ArtifactPromptClass = 'work_product' | 'media' | 'audio' | 'plain_chat' | 'blocked_data';

export type GeneratedArtifactReceipt = {
  requestId: string;
  provider?: string;
  model?: string;
  route: GeneratedArtifactRoute;
  costLabel?: string;
  dataClass: SensitivityClass;
  humanGate: string;
  status: GeneratedArtifactStatus;
};

export type GeneratedArtifactPayload = {
  artifactType: GeneratedArtifactType;
  title: string;
  description?: string;
  path?: string;
  url?: string;
  mimeType?: string;
  content?: string;
  html?: string;
  error?: string;
  receipt: GeneratedArtifactReceipt;
};

export type RendererGeneratedArtifactPayload = {
  artifact_type: RendererGeneratedArtifactType;
  title: string;
  description?: string;
  path?: string;
  url?: string;
  mime_type?: string;
  content?: string;
  html?: string;
  error?: string;
  provider?: string;
  model?: string;
  request_id: string;
  receipt: GeneratedArtifactReceipt;
};

export type ArtifactGoldenEvalCase = {
  promptClass: ArtifactPromptClass;
  artifact?: GeneratedArtifactPayload;
};

export type ArtifactGoldenEvalResult = {
  eligibleCount: number;
  eligibleWithVisibleArtifact: number;
  eligibleArtifactRate: number;
  plainChatCount: number;
  plainChatForcedArtifactCount: number;
  plainChatForcedArtifactRate: number;
  blockedDataCount: number;
  blockedDataLeakCount: number;
  pass: boolean;
};

const DONE_SOURCE_TYPES: GeneratedArtifactType[] = ['image', 'video', 'audio', 'file', 'report'];

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function rendererArtifactType(type: GeneratedArtifactType, mimeType?: string): RendererGeneratedArtifactType {
  if (type === 'report') {
    return mimeType?.toLowerCase().includes('html') ? 'html' : 'file';
  }
  if (type === 'failure') {
    return 'file';
  }
  return type;
}

export function shouldForceArtifactForPromptClass(promptClass: ArtifactPromptClass): boolean {
  return (
    promptClass === 'work_product' ||
    promptClass === 'media' ||
    promptClass === 'audio' ||
    promptClass === 'blocked_data'
  );
}

export function visibleArtifactPresent(payload: GeneratedArtifactPayload | undefined): boolean {
  if (!payload || !nonEmpty(payload.title) || !nonEmpty(payload.receipt.requestId)) {
    return false;
  }

  if (
    payload.receipt.status === 'failed' ||
    payload.receipt.status === 'blocked' ||
    payload.artifactType === 'failure'
  ) {
    return nonEmpty(payload.error) || nonEmpty(payload.description);
  }

  if (payload.receipt.status !== 'done') {
    return false;
  }

  if (payload.artifactType === 'html') {
    return nonEmpty(payload.html) || nonEmpty(payload.content) || nonEmpty(payload.path) || nonEmpty(payload.url);
  }

  if (DONE_SOURCE_TYPES.includes(payload.artifactType)) {
    return nonEmpty(payload.path) || nonEmpty(payload.url) || nonEmpty(payload.content);
  }

  return false;
}

export function toRendererGeneratedArtifactPayload(
  payload: GeneratedArtifactPayload
): RendererGeneratedArtifactPayload {
  return {
    artifact_type: rendererArtifactType(payload.artifactType, payload.mimeType),
    title: payload.title,
    description: payload.description,
    path: payload.path,
    url: payload.url,
    mime_type: payload.mimeType,
    content: payload.content,
    html: payload.html,
    error: payload.error,
    provider: payload.receipt.provider,
    model: payload.receipt.model,
    request_id: payload.receipt.requestId,
    receipt: payload.receipt,
  };
}

export function buildFailureArtifact(input: {
  requestId: string;
  title: string;
  description?: string;
  error: string;
  dataClass: SensitivityClass;
  humanGate: string;
  route?: GeneratedArtifactRoute;
  provider?: string;
  model?: string;
  blocked?: boolean;
}): GeneratedArtifactPayload {
  return {
    artifactType: 'failure',
    title: input.title,
    description: input.description,
    error: input.error,
    receipt: {
      requestId: input.requestId,
      provider: input.provider,
      model: input.model,
      route: input.route || 'unknown',
      dataClass: input.dataClass,
      humanGate: input.humanGate,
      status: input.blocked ? 'blocked' : 'failed',
    },
  };
}

export function evaluateArtifactGoldenCases(cases: ArtifactGoldenEvalCase[]): ArtifactGoldenEvalResult {
  let eligibleCount = 0;
  let eligibleWithVisibleArtifact = 0;
  let plainChatCount = 0;
  let plainChatForcedArtifactCount = 0;
  let blockedDataCount = 0;
  let blockedDataLeakCount = 0;

  for (const item of cases) {
    const visible = visibleArtifactPresent(item.artifact);
    if (shouldForceArtifactForPromptClass(item.promptClass)) {
      eligibleCount += 1;
      if (visible) eligibleWithVisibleArtifact += 1;
    }

    if (item.promptClass === 'plain_chat') {
      plainChatCount += 1;
      if (visible) plainChatForcedArtifactCount += 1;
    }

    if (item.promptClass === 'blocked_data') {
      blockedDataCount += 1;
      if (!item.artifact || item.artifact.receipt.status !== 'blocked') {
        blockedDataLeakCount += 1;
      }
    }
  }

  const eligibleArtifactRate = eligibleCount === 0 ? 1 : eligibleWithVisibleArtifact / eligibleCount;
  const plainChatForcedArtifactRate = plainChatCount === 0 ? 0 : plainChatForcedArtifactCount / plainChatCount;

  return {
    eligibleCount,
    eligibleWithVisibleArtifact,
    eligibleArtifactRate,
    plainChatCount,
    plainChatForcedArtifactCount,
    plainChatForcedArtifactRate,
    blockedDataCount,
    blockedDataLeakCount,
    pass: eligibleArtifactRate >= 0.9 && plainChatForcedArtifactRate <= 0.1 && blockedDataLeakCount === 0,
  };
}
