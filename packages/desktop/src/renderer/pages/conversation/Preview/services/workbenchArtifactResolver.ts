/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedUIArtifactKind } from '@/common/typedUI';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const RESOLVER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;

export interface WorkbenchArtifactReference {
  kind: TypedUIArtifactKind;
  artifactId: string;
  conversationId: string;
}

export interface WorkbenchArtifactResolver {
  id: string;
  priority?: number;
  canResolve(reference: WorkbenchArtifactReference): boolean;
  open(reference: WorkbenchArtifactReference): Promise<void> | void;
}

const resolvers = new Map<string, WorkbenchArtifactResolver>();

function validateReference(reference: WorkbenchArtifactReference): void {
  if (!['chat', 'file', 'browser', 'goal', 'worker'].includes(reference.kind)) {
    throw new Error('artifact_reference_kind_invalid');
  }
  if (!SAFE_ID.test(reference.artifactId) || !SAFE_ID.test(reference.conversationId)) {
    throw new Error('artifact_reference_identity_invalid');
  }
}

/**
 * Register one pane owner. The highest-priority exact resolver wins; no
 * renderer fallback may reinterpret an unresolved id as a path or URL.
 */
export function registerWorkbenchArtifactResolver(resolver: WorkbenchArtifactResolver): () => void {
  if (!RESOLVER_ID.test(resolver.id) || resolvers.has(resolver.id)) {
    throw new Error('artifact_resolver_identity_invalid');
  }
  resolvers.set(resolver.id, resolver);
  return () => {
    if (resolvers.get(resolver.id) === resolver) resolvers.delete(resolver.id);
  };
}

export function canResolveWorkbenchArtifact(reference: WorkbenchArtifactReference): boolean {
  try {
    validateReference(reference);
  } catch {
    return false;
  }
  return Array.from(resolvers.values()).some((resolver) => {
    try {
      return resolver.canResolve(reference);
    } catch {
      return false;
    }
  });
}

export async function openWorkbenchArtifact(reference: WorkbenchArtifactReference): Promise<void> {
  validateReference(reference);
  const candidates = Array.from(resolvers.values())
    .filter((resolver) => {
      try {
        return resolver.canResolve(reference);
      } catch {
        return false;
      }
    })
    .toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  const resolver = candidates[0];
  if (!resolver) throw new Error('artifact_not_resolved');
  await resolver.open(reference);
}

/** Test-only reset for isolated renderer unit suites. */
export function resetWorkbenchArtifactResolversForTest(): void {
  resolvers.clear();
}
