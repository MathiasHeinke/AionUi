/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedUIEnvelope, TypedUIProvenanceArtifactRef } from './types';

export const TYPED_UI_PUBLISH_TOOL_NAME = 'eve_typed_ui_publish' as const;
export const TYPED_UI_TOOL_ARTIFACT_PREFIX = 'tool-artifact-' as const;
export const TYPED_UI_HOST_PROVIDER_CLAIM = 'command-eve' as const;
export const TYPED_UI_HOST_MODEL_CLAIM = 'verified-private-route' as const;

const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,109}$/;

export function typedUIArtifactIdForToolCall(toolCallId: unknown): string | undefined {
  if (typeof toolCallId !== 'string' || !TOOL_CALL_ID.test(toolCallId)) return undefined;
  return `${TYPED_UI_TOOL_ARTIFACT_PREFIX}${toolCallId}`;
}

export function typedUIToolCallIdFromArtifactId(artifactId: unknown): string | undefined {
  if (typeof artifactId !== 'string' || !artifactId.startsWith(TYPED_UI_TOOL_ARTIFACT_PREFIX)) return undefined;
  const toolCallId = artifactId.slice(TYPED_UI_TOOL_ARTIFACT_PREFIX.length);
  return TOOL_CALL_ID.test(toolCallId) ? toolCallId : undefined;
}

/**
 * Replace model-authored routing claims with deterministic host correlation.
 *
 * The provider response remains sealed by its private raw-envelope hash. The
 * renderable envelope deliberately contains no actual provider/model name and
 * cannot claim its own conversation, message, clock, or request identity.
 */
export function bindTypedUIEnvelopeToArtifact(
  envelope: TypedUIEnvelope,
  artifact: TypedUIProvenanceArtifactRef
): TypedUIEnvelope {
  return {
    ...envelope,
    provenance: {
      provider: TYPED_UI_HOST_PROVIDER_CLAIM,
      model: TYPED_UI_HOST_MODEL_CLAIM,
      request_id: artifact.artifact_id,
      generated_at: new Date(artifact.created_at).toISOString(),
      source_message_id: artifact.source_message_id,
    },
  };
}
