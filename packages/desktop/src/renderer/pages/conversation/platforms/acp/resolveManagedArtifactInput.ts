/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandEveManagedArtifactInputRequest,
  CommandEveManagedArtifactInputResolution,
} from '@/common/config/managedArtifactInputCore';

type ArtifactInputResolveResponse = {
  success: boolean;
  data?: CommandEveManagedArtifactInputResolution;
};

type ArtifactInputResolveInvoke = (
  request: CommandEveManagedArtifactInputRequest
) => Promise<ArtifactInputResolveResponse>;

export type ManagedArtifactInputResult =
  | Readonly<{ status: 'ready'; agentFilePath: string }>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'unavailable' }>;

function isUsableAgentFilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
  );
}

const PDF_SOURCE_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'absolute_path',
  'absolutePath',
  'relative_path',
] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBoundedPdfSourcePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const sourcePath = value.trim();
  if (
    sourcePath.length === 0 ||
    sourcePath.length > 4096 ||
    sourcePath.includes('\0') ||
    !sourcePath.toLowerCase().endsWith('.pdf') ||
    /^file:/i.test(sourcePath)
  ) {
    return false;
  }
  return sourcePath.startsWith('/') || sourcePath.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');
}

/**
 * Extract a PDF source only from the currently selected exact artifact. The
 * path stays IPC-only; the renderer never adds it to user text or display
 * attachments, and Main re-validates it against the conversation authority.
 */
export function readSelectedPdfArtifactSourcePath(input: {
  artifact: unknown;
  conversationId: string;
  artifactId: string;
}): string | undefined {
  const artifact = recordOf(input.artifact);
  const payload = recordOf(artifact?.payload);
  if (
    !artifact ||
    !payload ||
    artifact.id !== input.artifactId ||
    artifact.conversation_id !== input.conversationId ||
    (artifact.status !== 'active' && artifact.status !== 'saved')
  ) {
    return undefined;
  }
  for (const key of PDF_SOURCE_PATH_KEYS) {
    const value = payload[key];
    if (isBoundedPdfSourcePath(value)) return value.trim();
  }
  return undefined;
}

export async function resolveManagedArtifactInput(input: {
  conversationId: string;
  artifactId: string;
  sourcePath?: string;
  isCurrent: () => boolean;
  invoke: ArtifactInputResolveInvoke;
}): Promise<ManagedArtifactInputResult> {
  if (!input.isCurrent()) return { status: 'stale' };

  try {
    const response = await input.invoke({
      conversationId: input.conversationId,
      artifactId: input.artifactId,
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    });
    if (!input.isCurrent()) return { status: 'stale' };
    const agentFilePath =
      response.success === true && response.data?.status === 'ready' ? response.data.agentFilePath : undefined;
    return isUsableAgentFilePath(agentFilePath) ? { status: 'ready', agentFilePath } : { status: 'unavailable' };
  } catch {
    return input.isCurrent() ? { status: 'unavailable' } : { status: 'stale' };
  }
}
