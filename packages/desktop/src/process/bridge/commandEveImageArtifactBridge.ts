/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — Main-process bridge for MANAGED IMAGE artifacts.
 *
 * The image counterpart of `commandEveVideoBridge.ts`, covering the four things
 * the staged-handle contract needs Main to own:
 *
 *   - BIND: the renderer read the staged handle out of the finished turn's tool
 *     output; this is where display authority is granted (staged -> active,
 *     conversation set, durable edit grant minted);
 *   - LIST/PREVIEW: the durable records the renderer merges into its artifact
 *     provider, and the private bytes behind them — by artifact id, never by
 *     path, with the SHA-256 re-verified on every read;
 *   - IMPORT: the one-time, strictly confined adoption of the pre-contract P1
 *     proof file;
 *   - EDIT: the paid lane. Handle + permit, mirroring `handleCommandEveVideoEdit`
 *     guard for guard, but the provider call goes through the MANAGED IMAGE
 *     service (receipt-verified, reference-capable tier resolved request-side)
 *     and the result is STAGED, not activated — the child binds through the
 *     same terminal flow as a fresh generation.
 *
 * What NEVER leaves this file: a filesystem path, provider bytes in clear, the
 * licence wire. The loopback payload names an artifact handle and a parent id
 * and nothing else.
 *
 * NAMED `commandEveImageArtifactBridge` because `commandEveImageBridge.ts`
 * already exists and owns the image-PREPARE (vision) lane — a different
 * feature on the same noun.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS,
  COMMAND_EVE_MANAGED_IMAGE_MAX_PROMPT_CHARS,
  COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES,
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS,
  type CommandEveImageGenerateRequest,
  type CommandEveImageGenerateResult,
  type CommandEveManagedImageAspectRatio,
  type CommandEveManagedImageResolution,
} from '@/common/config/eveManagedImageGenerationCore';
import {
  isCommandEveImageModelTierId,
  type CommandEveImageModelTierId,
} from '@/common/config/eveImageModelRegistryCore';
import { describeArtifactCapabilityRefusal } from '@/common/config/eveArtifactCapabilityHandleCore';
import { describeSpendPermitRefusal } from '@/common/config/eveVideoEditSpendPermitCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';
import { getDataPath } from '@process/utils/utils';
import { isAgentImageEditAdvertisingEnabled } from '@process/commandEve/agentImageEditFlag';
import {
  readArtifactCapabilityGrant,
  resolveImageEditCapability,
} from '@process/commandEve/artifactCapabilityHandleStore';
import {
  bindStagedImageArtifact,
  importLegacyImageArtifact,
  listActiveImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  readImageArtifactRecordByStagedHandle,
  type ImageArtifactBindResult,
  type ImageArtifactImportResult,
} from '@process/commandEve/imageArtifactStore';
import {
  executeCommandEveManagedImageGeneration,
  type CommandEveManagedImageGenerationOptions,
  type CommandEveManagedImageLocalResult,
} from '@process/commandEve/managedImageGenerationService';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import { readBoundedImageSource } from '@process/commandEve/document/imageIntelligenceService';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  getCommandEvePaidArtifactBlockReason,
  tryBeginCommandEvePaidArtifactOperation,
} from '@process/commandEve/seatContextCore';
import {
  acquireVideoEditInflightLock,
  consumeVideoEditSpendPermit,
  evaluateStoredVideoEditSpendPermit,
  isVideoEditSpendDenied,
  isVideoEditSpendStoreHealthy,
  readVideoEditSpendCompletion,
  readVideoEditSpendPermitRecord,
  recordVideoEditSpendCompletion,
  releaseVideoEditInflightLock,
} from '@process/commandEve/videoEditSpendPermitStore';

// ---------------------------------------------------------------------------
// BIND — display authority, granted at the end of the turn that produced it
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactBindRequest {
  conversationId?: string;
  handle?: string;
  toolCallId?: string;
}

export interface CommandEveImageArtifactBindDeps {
  getDataPath: typeof getDataPath;
  bind?: typeof bindStagedImageArtifact;
  /**
   * 1.820.3 same-turn insertion: invoked with the canonical conversation id
   * after a FRESH bind (never on alreadyBound/refusal) so Main can notify the
   * renderer — renderer-side turn events have proven unreliable on this lane
   * for triggering the render refresh, the store-level bind is the one
   * trigger that cannot be missed.
   */
  onFreshBind?: (conversationId: string) => void;
}

const productionBindDeps: CommandEveImageArtifactBindDeps = {
  getDataPath,
  bind: bindStagedImageArtifact,
};

/**
 * Bind a staged image to its conversation. Never throws and never blocks the
 * turn's `finish`: a refusal here costs the inline card, not the message.
 */
export async function handleCommandEveImageArtifactBind(
  request?: CommandEveImageArtifactBindRequest,
  deps: CommandEveImageArtifactBindDeps = productionBindDeps
): Promise<ImageArtifactBindResult> {
  const conversationId = request?.conversationId;
  const toolCallId = request?.toolCallId;
  if (typeof conversationId !== 'string' || conversationId.length === 0)
    return { ok: false, reason: 'handle-malformed' };
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return { ok: false, reason: 'handle-malformed' };
  try {
    const result = (deps.bind ?? bindStagedImageArtifact)(deps.getDataPath(), {
      conversationId,
      handle: request?.handle,
      toolCallId,
    });
    if (result.ok && !result.alreadyBound) {
      // Best-effort, isolated: a throwing notifier must NEVER turn a
      // successful bind into `artifact-missing` — the record IS active, and a
      // retry would read alreadyBound and never notify again.
      try {
        deps.onFreshBind?.(conversationId);
      } catch {
        /* the bind stands; the render refresh has the terminal relay behind it */
      }
    }
    return result;
  } catch {
    return { ok: false, reason: 'artifact-missing' };
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactBind`. */
export async function handleCommandEveImageArtifactBindBridge(
  request?: CommandEveImageArtifactBindRequest,
  deps: CommandEveImageArtifactBindDeps = productionBindDeps
): Promise<{ success: true; data: ImageArtifactBindResult }> {
  return { success: true, data: await handleCommandEveImageArtifactBind(request, deps) };
}

// ---------------------------------------------------------------------------
// GENERATE — one explicit composer turn, staged and bound inside Main
// ---------------------------------------------------------------------------

const IMAGE_GENERATE_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const IMAGE_GENERATE_SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/;
const IMAGE_GENERATE_COMPLETION_TTL_MS = 10 * 60 * 1000;
const IMAGE_GENERATE_COMPLETION_MAX = 128;

type NormalizedImageGenerateRequest = {
  prompt: string;
  conversationId: string;
  requestId: string;
  tierId: CommandEveImageModelTierId;
  resolution: CommandEveManagedImageResolution;
  aspectRatio: CommandEveManagedImageAspectRatio;
  referenceImagePaths: string[];
};

function refuseImageGenerate(
  reasonCode: string,
  message: string,
  options: {
    requestId?: string;
    retryable?: boolean;
    artifactState?: Extract<CommandEveImageGenerateResult, { ok: false }>['artifactState'];
  } = {}
): CommandEveImageGenerateResult {
  return {
    ok: false,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    reasonCode,
    message,
    retryable: options.retryable ?? false,
    artifactState: options.artifactState ?? 'none',
  };
}

function normalizeImageGenerateRequest(
  request?: CommandEveImageGenerateRequest
): { ok: true; request: NormalizedImageGenerateRequest } | { ok: false; result: CommandEveImageGenerateResult } {
  const requestId = typeof request?.requestId === 'string' ? request.requestId : undefined;
  const prompt = typeof request?.prompt === 'string' ? request.prompt.replace(/\r\n?/g, '\n').trim() : '';
  if (!prompt || prompt.length > COMMAND_EVE_MANAGED_IMAGE_MAX_PROMPT_CHARS) {
    return {
      ok: false,
      result: refuseImageGenerate('image-generate-prompt-invalid', 'Beschreibe das gewünschte Bild etwas genauer.', {
        requestId,
      }),
    };
  }
  if (typeof request?.conversationId !== 'string' || !IMAGE_GENERATE_SAFE_ID.test(request.conversationId)) {
    return {
      ok: false,
      result: refuseImageGenerate(
        'image-generate-conversation-invalid',
        'Die Bildanfrage gehört zu keiner gültigen Unterhaltung.',
        { requestId }
      ),
    };
  }
  if (!requestId || !IMAGE_GENERATE_SAFE_REQUEST_ID.test(requestId)) {
    return {
      ok: false,
      result: refuseImageGenerate(
        'image-generate-request-id-invalid',
        'Die Bildanfrage hat keinen gültigen Schlüssel.'
      ),
    };
  }
  if (!isCommandEveImageModelTierId(request.tierId)) {
    return {
      ok: false,
      result: refuseImageGenerate('image-generate-tier-invalid', 'Das ausgewählte Bildmodell ist nicht gültig.', {
        requestId,
      }),
    };
  }
  if (!COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS.includes(request.resolution)) {
    return {
      ok: false,
      result: refuseImageGenerate('image-generate-resolution-invalid', 'Die ausgewählte Auflösung ist nicht gültig.', {
        requestId,
      }),
    };
  }
  if (!COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.includes(request.aspectRatio)) {
    return {
      ok: false,
      result: refuseImageGenerate(
        'image-generate-aspect-ratio-invalid',
        'Das ausgewählte Bildformat ist nicht gültig.',
        {
          requestId,
        }
      ),
    };
  }
  const rawPaths = request.referenceImagePaths ?? [];
  if (!Array.isArray(rawPaths) || rawPaths.length > COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES) {
    return {
      ok: false,
      result: refuseImageGenerate(
        'image-generate-references-invalid',
        'Es wurden zu viele Referenzbilder ausgewählt.',
        {
          requestId,
        }
      ),
    };
  }
  const referenceImagePaths: string[] = [];
  const uniquePaths = new Set<string>();
  for (const candidate of rawPaths) {
    if (
      typeof candidate !== 'string' ||
      !candidate ||
      candidate !== candidate.trim() ||
      candidate.includes('\0') ||
      !path.isAbsolute(candidate)
    ) {
      return {
        ok: false,
        result: refuseImageGenerate(
          'image-generate-reference-path-invalid',
          'Ein Referenzbild hat keinen gültigen lokalen Pfad.',
          { requestId }
        ),
      };
    }
    const normalizedPath = path.resolve(candidate);
    if (normalizedPath !== candidate || uniquePaths.has(normalizedPath)) {
      return {
        ok: false,
        result: refuseImageGenerate(
          'image-generate-reference-path-invalid',
          'Ein Referenzbild wurde doppelt oder mit einem uneindeutigen Pfad angegeben.',
          { requestId }
        ),
      };
    }
    uniquePaths.add(normalizedPath);
    referenceImagePaths.push(normalizedPath);
  }
  return {
    ok: true,
    request: {
      prompt,
      conversationId: request.conversationId,
      requestId,
      tierId: request.tierId,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      referenceImagePaths,
    },
  };
}

type CommandEveImageGenerateCoordinator = {
  run: (
    input: { conversationId: string; requestId: string; requestDigest: string },
    work: () => Promise<CommandEveImageGenerateResult>
  ) => Promise<CommandEveImageGenerateResult>;
};

/** Process-local response replay; the gateway request id remains the durable debit dedupe after restart. */
export function createCommandEveImageGenerateCoordinator(): CommandEveImageGenerateCoordinator {
  const inflightByRequest = new Map<
    string,
    { conversationId: string; requestDigest: string; promise: Promise<CommandEveImageGenerateResult> }
  >();
  const inflightByConversation = new Map<string, string>();
  const completed = new Map<
    string,
    { conversationId: string; requestDigest: string; result: CommandEveImageGenerateResult; expiresAt: number }
  >();

  const prune = (nowMs: number): void => {
    for (const [requestId, entry] of completed) {
      if (entry.expiresAt <= nowMs) completed.delete(requestId);
    }
    while (completed.size > IMAGE_GENERATE_COMPLETION_MAX) {
      const oldest = completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
  };

  return {
    async run(input, work) {
      prune(Date.now());
      const completedEntry = completed.get(input.requestId);
      if (completedEntry) {
        if (
          completedEntry.conversationId !== input.conversationId ||
          completedEntry.requestDigest !== input.requestDigest
        ) {
          return refuseImageGenerate(
            'image-generate-request-id-conflict',
            'Dieser Anfrage-Schlüssel gehört bereits zu einer anderen Bildanfrage.',
            { requestId: input.requestId }
          );
        }
        return completedEntry.result.ok ? { ...completedEntry.result, alreadyCompleted: true } : completedEntry.result;
      }

      const requestEntry = inflightByRequest.get(input.requestId);
      if (requestEntry) {
        if (
          requestEntry.conversationId !== input.conversationId ||
          requestEntry.requestDigest !== input.requestDigest
        ) {
          return refuseImageGenerate(
            'image-generate-request-id-conflict',
            'Dieser Anfrage-Schlüssel gehört bereits zu einer anderen Bildanfrage.',
            { requestId: input.requestId }
          );
        }
        return requestEntry.promise;
      }

      const conversationRequestId = inflightByConversation.get(input.conversationId);
      if (conversationRequestId) {
        return refuseImageGenerate(
          'image-generate-already-in-flight',
          'Für diese Unterhaltung wird bereits ein Bild erstellt.',
          { requestId: input.requestId, retryable: true }
        );
      }

      const promise = Promise.resolve()
        .then(work)
        .catch(() =>
          refuseImageGenerate('image-generate-failed', 'Die Bildanfrage ist unerwartet fehlgeschlagen.', {
            requestId: input.requestId,
            retryable: true,
            artifactState: 'creation_unverified',
          })
        )
        .then((result) => {
          // A refusal proven to have happened BEFORE creation remains
          // retryable with the same id after its cause clears. Successes and
          // any ambiguous/post-provider outcome are replayed so a retry cannot
          // accidentally buy the same visual twice.
          const shouldCache = result.ok === true ? true : result.artifactState !== 'none';
          if (shouldCache) {
            completed.set(input.requestId, {
              conversationId: input.conversationId,
              requestDigest: input.requestDigest,
              result,
              expiresAt: Date.now() + IMAGE_GENERATE_COMPLETION_TTL_MS,
            });
          }
          prune(Date.now());
          return result;
        })
        .finally(() => {
          inflightByRequest.delete(input.requestId);
          if (inflightByConversation.get(input.conversationId) === input.requestId) {
            inflightByConversation.delete(input.conversationId);
          }
        });
      inflightByRequest.set(input.requestId, {
        conversationId: input.conversationId,
        requestDigest: input.requestDigest,
        promise,
      });
      inflightByConversation.set(input.conversationId, input.requestId);
      return promise;
    },
  };
}

export interface CommandEveImageGenerateDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  areFileSelectionPathsGranted?: typeof areCommandEveFileSelectionPathsGranted;
  readImageSource?: typeof readBoundedImageSource;
  runManagedGeneration?: (
    input: Parameters<typeof executeCommandEveManagedImageGeneration>[0],
    options: CommandEveManagedImageGenerationOptions
  ) => Promise<CommandEveManagedImageLocalResult>;
  bind?: typeof bindStagedImageArtifact;
  acquireInflightLock?: typeof acquireVideoEditInflightLock;
  releaseInflightLock?: typeof releaseVideoEditInflightLock;
  coordinator?: CommandEveImageGenerateCoordinator;
  onFreshBind?: (conversationId: string) => void;
}

const productionImageGenerateCoordinator = createCommandEveImageGenerateCoordinator();

const productionImageGenerateDeps: CommandEveImageGenerateDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
  readImageSource: readBoundedImageSource,
  runManagedGeneration: executeCommandEveManagedImageGeneration,
  bind: bindStagedImageArtifact,
  acquireInflightLock: acquireVideoEditInflightLock,
  releaseInflightLock: releaseVideoEditInflightLock,
  coordinator: productionImageGenerateCoordinator,
};

function managedImageFailureResult(
  localResult: CommandEveManagedImageLocalResult,
  requestId: string
): CommandEveImageGenerateResult {
  const error =
    localResult.body.error && typeof localResult.body.error === 'object' && !Array.isArray(localResult.body.error)
      ? (localResult.body.error as Record<string, unknown>)
      : {};
  const reasonCode = typeof error.code === 'string' && error.code ? error.code : 'managed_image_failed';
  const message =
    typeof error.message === 'string' && error.message ? error.message : 'Das Bild konnte nicht erstellt werden.';
  const artifactState =
    reasonCode === 'managed_image_stage_failed'
      ? ('created_not_stored' as const)
      : localResult.status >= 500 &&
          !['image_model_registry_unavailable', 'image_generation_disabled', 'managed_image_disabled'].includes(
            reasonCode
          )
        ? ('creation_unverified' as const)
        : ('none' as const);
  return refuseImageGenerate(reasonCode, message, {
    requestId,
    retryable: artifactState === 'creation_unverified' || localResult.status === 429,
    artifactState,
  });
}

/**
 * Generate and bind an image without exposing the staged handle. The incoming
 * request id is both the turn-local dedupe key and the gateway idempotency key.
 */
export async function handleCommandEveImageGenerate(
  rawRequest?: CommandEveImageGenerateRequest,
  deps: CommandEveImageGenerateDeps = productionImageGenerateDeps
): Promise<CommandEveImageGenerateResult> {
  const normalized = normalizeImageGenerateRequest(rawRequest);
  if (normalized.ok === false) return normalized.result;
  const request = normalized.request;
  const requestDigest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        prompt: request.prompt,
        conversationId: request.conversationId,
        tierId: request.tierId,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        referenceImagePaths: request.referenceImagePaths,
      })
    )
    .digest('hex');
  const coordinator = deps.coordinator ?? productionImageGenerateCoordinator;

  return coordinator.run(
    { conversationId: request.conversationId, requestId: request.requestId, requestDigest },
    async () => {
      let dataPath: string;
      let capturedSeatId: string;
      let capturedSeatContextRevision: number;
      try {
        dataPath = deps.getDataPath();
        capturedSeatId = deps.getActiveSeatId();
        capturedSeatContextRevision = deps.getActiveSeatContextRevision();
      } catch {
        return refuseImageGenerate('image-generate-seat-unavailable', 'Der aktive Platz ist gerade nicht verfügbar.', {
          requestId: request.requestId,
          retryable: true,
        });
      }
      const seatStillMatches = (): boolean => {
        try {
          return (
            deps.getActiveSeatId() === capturedSeatId &&
            deps.getActiveSeatContextRevision() === capturedSeatContextRevision
          );
        } catch {
          return false;
        }
      };

      let lockHeld = false;
      try {
        lockHeld = (deps.acquireInflightLock ?? acquireVideoEditInflightLock)(dataPath, request.conversationId);
      } catch {
        lockHeld = false;
      }
      if (!lockHeld) {
        return refuseImageGenerate(
          'image-generate-already-in-flight',
          'Für diese Unterhaltung wird bereits ein Medienartefakt erstellt.',
          { requestId: request.requestId, retryable: true }
        );
      }

      try {
        if (!seatStillMatches()) {
          return refuseImageGenerate(
            'image-generate-seat-changed',
            'Der aktive Platz hat gewechselt. Bitte erneut senden.',
            {
              requestId: request.requestId,
              retryable: true,
            }
          );
        }

        const inputReferences: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
        if (request.referenceImagePaths.length > 0) {
          let granted = false;
          try {
            granted = (deps.areFileSelectionPathsGranted ?? areCommandEveFileSelectionPathsGranted)({
              filePaths: request.referenceImagePaths,
              seatId: capturedSeatId,
              purpose: 'read',
            });
          } catch {
            granted = false;
          }
          if (!granted) {
            return refuseImageGenerate(
              'image-generate-reference-not-granted',
              'Wähle das Referenzbild erneut aus, bevor es den Rechner verlässt.',
              { requestId: request.requestId }
            );
          }
          for (const referencePath of request.referenceImagePaths) {
            try {
              const source = (deps.readImageSource ?? readBoundedImageSource)(referencePath);
              inputReferences.push({
                type: 'image_url',
                image_url: { url: `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString('base64')}` },
              });
            } catch {
              return refuseImageGenerate(
                'image-generate-reference-unreadable',
                'Ein Referenzbild konnte nicht sicher gelesen werden. Wähle es erneut aus.',
                { requestId: request.requestId }
              );
            }
          }
        }

        if (!seatStillMatches()) {
          return refuseImageGenerate(
            'image-generate-seat-changed',
            'Der aktive Platz hat gewechselt. Bitte erneut senden.',
            {
              requestId: request.requestId,
              retryable: true,
            }
          );
        }
        const localResult = await (deps.runManagedGeneration ?? executeCommandEveManagedImageGeneration)(
          {
            model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
            prompt: request.prompt,
            n: 1,
            aspect_ratio: request.aspectRatio,
            resolution: request.resolution,
            input_references: inputReferences,
          },
          {
            dataPath,
            requestedTier: request.tierId,
            requestId: request.requestId,
            expectedSeat: { id: capturedSeatId, revision: capturedSeatContextRevision },
            getActiveSeatId: deps.getActiveSeatId,
            getActiveSeatContextRevision: deps.getActiveSeatContextRevision,
          }
        );
        if (!seatStillMatches()) {
          return refuseImageGenerate(
            'image-generate-seat-changed',
            'Der aktive Platz hat gewechselt. Bitte erneut senden.',
            {
              requestId: request.requestId,
              retryable: true,
              artifactState: localResult.status === 200 ? 'stored_not_bound' : 'creation_unverified',
            }
          );
        }
        if (localResult.status !== 200) return managedImageFailureResult(localResult, request.requestId);

        const first = Array.isArray(localResult.body.data) ? localResult.body.data[0] : undefined;
        const artifactHandle =
          first && typeof first === 'object' && !Array.isArray(first) && typeof first.artifact_handle === 'string'
            ? first.artifact_handle
            : '';
        if (!artifactHandle) {
          return refuseImageGenerate(
            'image-generate-stage-response-invalid',
            'Das Bild wurde erstellt, konnte aber keiner Unterhaltung zugeordnet werden.',
            { requestId: request.requestId, artifactState: 'stored_not_bound' }
          );
        }

        let bindResult: ImageArtifactBindResult;
        try {
          bindResult = (deps.bind ?? bindStagedImageArtifact)(dataPath, {
            conversationId: request.conversationId,
            handle: artifactHandle,
            toolCallId: `image-generate:${request.requestId}`,
          });
        } catch {
          bindResult = { ok: false, reason: 'artifact-missing' };
        }
        if (!bindResult.ok) {
          return refuseImageGenerate(
            'image-generate-bind-failed',
            'Das Bild wurde lokal gespeichert, konnte aber nicht in die Unterhaltung eingefügt werden.',
            { requestId: request.requestId, artifactState: 'stored_not_bound' }
          );
        }
        if (!bindResult.alreadyBound) {
          try {
            deps.onFreshBind?.(request.conversationId);
          } catch {
            /* binding is authoritative; a renderer refresh may recover through list */
          }
        }
        return {
          ok: true,
          requestId: request.requestId,
          artifact: bindResult.record,
          alreadyCompleted: false,
        };
      } finally {
        try {
          (deps.releaseInflightLock ?? releaseVideoEditInflightLock)(dataPath, request.conversationId);
        } catch {
          /* stale lock expires under the store TTL; never mask the generation result */
        }
      }
    }
  );
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageGenerate`. */
export async function handleCommandEveImageGenerateBridge(
  request?: CommandEveImageGenerateRequest,
  deps: CommandEveImageGenerateDeps = productionImageGenerateDeps
): Promise<{ success: true; data: CommandEveImageGenerateResult }> {
  return { success: true, data: await handleCommandEveImageGenerate(request, deps) };
}

// ---------------------------------------------------------------------------
// LIST — the durable records the renderer merges into its artifact provider
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactsListDeps {
  getDataPath: typeof getDataPath;
  listRecords?: typeof listActiveImageArtifacts;
  /**
   * 1.820.3 load recovery: a best-effort durable reconcile that binds any
   * staged handle the volatile renderer path missed (the R2 orphan class)
   * BEFORE the list is served. Optional so unit tests can isolate the list;
   * production wires the Main transcript reconcile from commandEveBridge.
   * Never throws into the list.
   */
  reconcileBeforeList?: (conversationId: string) => Promise<unknown>;
}

const productionListDeps: CommandEveImageArtifactsListDeps = {
  getDataPath,
  listRecords: listActiveImageArtifacts,
};

/**
 * Every ACTIVE managed image this desktop holds for a conversation. The payload
 * carries NO path by construction (`managedImageArtifactCore.ts`), so what the
 * renderer receives can be merged into its artifact provider verbatim.
 */
export async function handleCommandEveImageArtifactsList(
  request?: { conversationId?: string },
  deps: CommandEveImageArtifactsListDeps = productionListDeps
): Promise<CommandEveActiveImageArtifact[]> {
  if (!request || typeof request.conversationId !== 'string' || request.conversationId.length === 0) return [];
  try {
    // Load recovery first: an orphan staged child binds idempotently, then the
    // list below already contains it. A reconcile failure costs nothing here.
    if (deps.reconcileBeforeList) {
      await deps.reconcileBeforeList(request.conversationId).catch((): undefined => undefined);
    }
    return (deps.listRecords ?? listActiveImageArtifacts)(deps.getDataPath(), request.conversationId);
  } catch {
    return [];
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactsList`. */
export async function handleCommandEveImageArtifactsListBridge(
  request?: { conversationId?: string },
  deps: CommandEveImageArtifactsListDeps = productionListDeps
): Promise<{ success: true; data: CommandEveActiveImageArtifact[] }> {
  return { success: true, data: await handleCommandEveImageArtifactsList(request, deps) };
}

// ---------------------------------------------------------------------------
// PREVIEW — the private bytes, by artifact id, hash re-verified on every read
// ---------------------------------------------------------------------------

export type CommandEveImageArtifactPreview = {
  data_base64: string;
  mime_type: string;
  size: number;
};

export interface CommandEveImageArtifactPreviewDeps {
  getDataPath: typeof getDataPath;
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
}

const productionPreviewDeps: CommandEveImageArtifactPreviewDeps = {
  getDataPath,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
};

/**
 * The renderer's ONLY window onto the private blob. Three independent checks,
 * all cheap and all before a byte crosses the bridge: the record exists and is
 * ACTIVE, it belongs to the conversation the caller named, and the bytes read
 * back hash to exactly what the record claims — a blob that changed underneath
 * us is served to nobody.
 */
export async function handleCommandEveImageArtifactPreview(
  request?: { conversationId?: string; artifactId?: string },
  deps: CommandEveImageArtifactPreviewDeps = productionPreviewDeps
): Promise<CommandEveImageArtifactPreview | null> {
  const conversationId = request?.conversationId;
  const artifactId = request?.artifactId;
  if (typeof conversationId !== 'string' || typeof artifactId !== 'string' || !conversationId || !artifactId) {
    return null;
  }
  try {
    const dataPath = deps.getDataPath();
    const record = (deps.readRecord ?? readImageArtifactRecordById)(dataPath, artifactId);
    if (!record || record.status !== 'active' || record.conversation_id !== conversationId) return null;
    const bytes = (deps.readBytes ?? readImageArtifactBytes)(dataPath, artifactId);
    if (!bytes) return null;
    const observed = crypto.createHash('sha256').update(bytes).digest('hex');
    if (observed !== record.payload.sha256) return null;
    return {
      data_base64: bytes.toString('base64'),
      mime_type: record.payload.mime_type,
      size: bytes.length,
    };
  } catch {
    return null;
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactPreview`. */
export async function handleCommandEveImageArtifactPreviewBridge(
  request?: { conversationId?: string; artifactId?: string },
  deps: CommandEveImageArtifactPreviewDeps = productionPreviewDeps
): Promise<{ success: true; data: CommandEveImageArtifactPreview | null }> {
  return { success: true, data: await handleCommandEveImageArtifactPreview(request, deps) };
}

// ---------------------------------------------------------------------------
// LEGACY IMPORT — the one-time, strictly confined adoption of the P1 proof file
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactImportLegacyDeps {
  getDataPath: typeof getDataPath;
  /**
   * The legacy workspace root for a WORKSPACE FOLDER id. Injectable so tests
   * point at a temp fixture; production is the pre-contract image lane's one
   * save location, `~/Developer/conversations/<legacyWorkspaceId>`.
   */
  workspaceRootForLegacyId?: (legacyWorkspaceId: string) => string;
  importLegacy?: typeof importLegacyImageArtifact;
}

const productionImportDeps: CommandEveImageArtifactImportLegacyDeps = {
  getDataPath,
  workspaceRootForLegacyId: (legacyWorkspaceId) =>
    path.join(os.homedir(), 'Developer', 'conversations', legacyWorkspaceId),
  importLegacy: importLegacyImageArtifact,
};

/**
 * Adopt the pre-contract P1 proof file. `conversationId` is the CANONICAL
 * conversation the record binds to (and renders under); `legacyWorkspaceId`
 * is the Hermes workspace folder the file actually lives in, and the store
 * refuses anything but the exact `hermes-temp-<canonical>` shape.
 */
export async function handleCommandEveImageArtifactImportLegacy(
  request?: { conversationId?: string; legacyWorkspaceId?: string; expectedFileName?: string },
  deps: CommandEveImageArtifactImportLegacyDeps = productionImportDeps
): Promise<ImageArtifactImportResult> {
  const conversationId = request?.conversationId;
  const legacyWorkspaceId = request?.legacyWorkspaceId;
  const expectedFileName = request?.expectedFileName;
  if (
    typeof conversationId !== 'string' ||
    conversationId.length === 0 ||
    typeof legacyWorkspaceId !== 'string' ||
    legacyWorkspaceId.length === 0 ||
    typeof expectedFileName !== 'string' ||
    expectedFileName.length === 0
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  try {
    return (deps.importLegacy ?? importLegacyImageArtifact)(deps.getDataPath(), {
      conversationId,
      legacyWorkspaceId,
      expectedFileName,
      workspaceRoot: (deps.workspaceRootForLegacyId ?? productionImportDeps.workspaceRootForLegacyId!)(
        legacyWorkspaceId
      ),
    });
  } catch {
    return { ok: false, reason: 'file-unreadable' };
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactImportLegacy`. */
export async function handleCommandEveImageArtifactImportLegacyBridge(
  request?: { conversationId?: string; legacyWorkspaceId?: string; expectedFileName?: string },
  deps: CommandEveImageArtifactImportLegacyDeps = productionImportDeps
): Promise<{ success: true; data: ImageArtifactImportResult }> {
  return { success: true, data: await handleCommandEveImageArtifactImportLegacy(request, deps) };
}

// ---------------------------------------------------------------------------
// EDIT — the paid lane. Handle + permit; the child is STAGED, never activated
// ---------------------------------------------------------------------------

/** Mirrors the video lane's 2000-character instruction ceiling. */
export const MAX_IMAGE_EDIT_INSTRUCTION_CHARS = 2000;

export interface CommandEveImageEditRequest {
  handle?: string;
  permit?: string;
  instruction?: string;
  /** Optional fence only — never consulted as authority. */
  conversationId?: string;
}

export type CommandEveImageEditResult =
  | {
      ok: true;
      /** The STAGED handle of the child image — it binds via the same terminal flow as a generation. */
      artifactHandle: string;
      parentArtifactId: string;
    }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };

type ImageEditSpendCompletion = {
  artifact_id: string;
  source_artifact_id: string;
  conversation_id: string;
  instruction_sha256: string;
  artifact_sha256: string;
  completed_at_ms: number;
  artifact_handle?: unknown;
};

export interface CommandEveImageEditDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  getActiveSeatContextRevision?: typeof getActiveSeatContextRevision;
  getPaidArtifactBlockReason?: typeof getCommandEvePaidArtifactBlockReason;
  tryBeginPaidArtifactOperation?: typeof tryBeginCommandEvePaidArtifactOperation;
  isImageEditEnabled?: () => boolean;
  isSpendStoreHealthy?: typeof isVideoEditSpendStoreHealthy;
  isSpendDenied?: typeof isVideoEditSpendDenied;
  readGrant?: typeof readArtifactCapabilityGrant;
  resolveCapability?: typeof resolveImageEditCapability;
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
  readRecordByStagedHandle?: typeof readImageArtifactRecordByStagedHandle;
  readSpendPermitRecord?: typeof readVideoEditSpendPermitRecord;
  readSpendCompletion?: typeof readVideoEditSpendCompletion;
  evaluateSpendPermit?: typeof evaluateStoredVideoEditSpendPermit;
  consumeSpendPermit?: typeof consumeVideoEditSpendPermit;
  recordSpendCompletion?: typeof recordVideoEditSpendCompletion;
  acquireInflightLock?: typeof acquireVideoEditInflightLock;
  releaseInflightLock?: typeof releaseVideoEditInflightLock;
  /**
   * The managed image service call, injected so tests can spy on EXACTLY what
   * reaches the provider lane — and prove the refusal order by what the spy
   * never saw.
   */
  runManagedEdit?: (input: {
    instruction: string;
    referenceDataUrl: string;
    parentArtifactId: string;
    dataPath: string;
    expectedSeat: { id: string; revision: number };
    requestId: string;
  }) => Promise<CommandEveManagedImageLocalResult>;
}

const productionEditDeps: CommandEveImageEditDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  getPaidArtifactBlockReason: getCommandEvePaidArtifactBlockReason,
  tryBeginPaidArtifactOperation: tryBeginCommandEvePaidArtifactOperation,
  isImageEditEnabled: () => isAgentImageEditAdvertisingEnabled(getDataPath()),
  isSpendStoreHealthy: isVideoEditSpendStoreHealthy,
  isSpendDenied: isVideoEditSpendDenied,
  readGrant: readArtifactCapabilityGrant,
  resolveCapability: resolveImageEditCapability,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
  readRecordByStagedHandle: readImageArtifactRecordByStagedHandle,
  readSpendPermitRecord: readVideoEditSpendPermitRecord,
  readSpendCompletion: readVideoEditSpendCompletion,
  evaluateSpendPermit: evaluateStoredVideoEditSpendPermit,
  consumeSpendPermit: consumeVideoEditSpendPermit,
  recordSpendCompletion: recordVideoEditSpendCompletion,
  acquireInflightLock: acquireVideoEditInflightLock,
  releaseInflightLock: releaseVideoEditInflightLock,
  runManagedEdit: ({ instruction, referenceDataUrl, parentArtifactId, dataPath, expectedSeat, requestId }) =>
    executeCommandEveManagedImageGeneration(
      {
        model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        prompt: instruction,
        n: 1,
        input_references: [{ type: 'image_url', image_url: { url: referenceDataUrl } }],
      },
      {
        dataPath,
        expectedSeat,
        getActiveSeatId,
        getActiveSeatContextRevision,
        requestId,
        stagedParentArtifactId: parentArtifactId,
      }
    ),
};

function refuseEdit(reasonCode: string, message: string, retryable = false): CommandEveImageEditResult {
  return { ok: false, reasonCode, message, retryable };
}

/**
 * Edit a managed image the user already has.
 *
 * TWO credentials, exactly as on the video lane: the `handle` says WHICH image
 * (long-lived, envelope-borne, read authority), the `permit` says THIS PERSON
 * JUST ASKED, ONCE (ephemeral, turn-bound, single-use, consumed atomically
 * before the provider is called). The guard order is the video order:
 * flag -> STORE HEALTH -> instruction -> PERMIT PRESENT -> grant -> caller
 * conversation fence -> CONVERSATION DENY -> artifact -> bytes -> hash match ->
 * permit conversation fence -> permit judgement (operation `image_edit`,
 * CURRENT TURN, covered bytes, expiry) -> in-flight lock -> ATOMIC TURN +
 * PERMIT CONSUME -> managed service.
 *
 * The result is STAGED with `parent_artifact_id` set and its own fresh staged
 * handle; the source record and its bytes are never touched. The child becomes
 * visible through the SAME terminal bind as a fresh generation — Main does not
 * shortcut display authority just because it holds spend authority.
 */
export async function handleCommandEveImageEdit(
  request?: CommandEveImageEditRequest,
  deps: CommandEveImageEditDeps = productionEditDeps
): Promise<CommandEveImageEditResult> {
  // THE flag gate, in the shared handler rather than in one lane's wrapper —
  // the lesson the video lane learned the expensive way.
  const paidEnabled = (deps.isImageEditEnabled ?? (() => isAgentImageEditAdvertisingEnabled(deps.getDataPath())))();
  if (!paidEnabled) {
    return refuseEdit(
      'image-edit-disabled',
      'Das Bearbeiten von Bildern ist auf diesem Platz noch nicht freigeschaltet.'
    );
  }

  // THE PROCESS-WIDE STORE-HEALTH GATE — shared with the video lane, because a
  // live authority that outlived a restart is not a property of a medium.
  let storeProven = false;
  try {
    storeProven = (deps.isSpendStoreHealthy ?? isVideoEditSpendStoreHealthy)() === true;
  } catch {
    storeProven = false;
  }
  if (!storeProven) {
    return refuseEdit('image-edit-spend-store-unreconciled', describeSpendPermitRefusal('spend-store-unreconciled'));
  }

  const instruction = typeof request?.instruction === 'string' ? request.instruction.trim() : '';
  if (!request || instruction.length === 0 || instruction.length > MAX_IMAGE_EDIT_INSTRUCTION_CHARS) {
    return refuseEdit('image-edit-request-invalid', 'Sag kurz, was am Bild geändert werden soll.');
  }

  // The permit is REQUIRED and is checked BEFORE anything that costs work. A
  // missing permit is not repaired or defaulted — it is the one credential that
  // says "the user just asked", and everything after this line assumes it.
  const permit = typeof request.permit === 'string' ? request.permit : '';
  if (!permit) {
    return refuseEdit('image-edit-permit-missing', describeSpendPermitRefusal('permit-missing'));
  }

  const readSeatId = deps.getActiveSeatId ?? getActiveSeatId;
  const readSeatRevision = deps.getActiveSeatContextRevision ?? getActiveSeatContextRevision;
  let dataPath: string;
  let capturedSeatId: string;
  let capturedSeatContextRevision: number;
  try {
    dataPath = deps.getDataPath();
    capturedSeatId = readSeatId();
    capturedSeatContextRevision = readSeatRevision();
  } catch {
    return refuseEdit('image-edit-seat-unavailable', 'Der aktive Seed konnte nicht sicher bestimmt werden.', true);
  }
  const seatStillMatches = (): boolean => {
    try {
      return readSeatId() === capturedSeatId && readSeatRevision() === capturedSeatContextRevision;
    } catch {
      return false;
    }
  };
  const readGrant = deps.readGrant ?? readArtifactCapabilityGrant;
  const resolveCapability = deps.resolveCapability ?? resolveImageEditCapability;
  const readRecord = deps.readRecord ?? readImageArtifactRecordById;
  const readBytes = deps.readBytes ?? readImageArtifactBytes;
  const readStagedRecord = deps.readRecordByStagedHandle ?? readImageArtifactRecordByStagedHandle;
  const isDenied = deps.isSpendDenied ?? isVideoEditSpendDenied;
  const readPermitRecord = deps.readSpendPermitRecord ?? readVideoEditSpendPermitRecord;
  const readCompletion = deps.readSpendCompletion ?? readVideoEditSpendCompletion;
  const evaluatePermit = deps.evaluateSpendPermit ?? evaluateStoredVideoEditSpendPermit;
  const consumePermit = deps.consumeSpendPermit ?? consumeVideoEditSpendPermit;
  const recordCompletion = deps.recordSpendCompletion ?? recordVideoEditSpendCompletion;
  const acquireLock = deps.acquireInflightLock ?? acquireVideoEditInflightLock;
  const releaseLock = deps.releaseInflightLock ?? releaseVideoEditInflightLock;

  // The grant is read FIRST so the artifact identity comes from OUR record,
  // never from anything the caller supplied.
  const grant = readGrant(dataPath, request.handle);
  if (!grant) {
    return refuseEdit('image-edit-handle-unknown', describeArtifactCapabilityRefusal('handle-unknown'));
  }
  if (request.conversationId !== undefined && request.conversationId !== grant.conversation_id) {
    return refuseEdit('image-edit-conversation-mismatch', describeArtifactCapabilityRefusal('conversation-mismatch'));
  }

  // THE DENY GATE — checked by its own read of its own state, before the source
  // read, before the permit judgement, before the lock, before the consume and
  // before the provider. A throw reads as DENIED.
  let conversationRetired = true;
  try {
    conversationRetired = isDenied(dataPath, grant.conversation_id);
  } catch {
    conversationRetired = true;
  }
  if (conversationRetired) {
    return refuseEdit('image-edit-conversation-retired', describeSpendPermitRefusal('conversation-retired'));
  }

  const source = readRecord(dataPath, grant.artifact_id);
  if (!source || source.status !== 'active' || source.conversation_id !== grant.conversation_id) {
    return refuseEdit('image-edit-source-missing', 'Das Ausgangsbild ist nicht mehr vorhanden.');
  }

  const sourceBytes = readBytes(dataPath, source.id);
  if (!sourceBytes) {
    return refuseEdit('image-edit-source-unreadable', 'Die Bilddatei konnte nicht gelesen werden.');
  }

  // Hash what we ACTUALLY read, then judge the handle against that — the same
  // time-of-check/time-of-use discipline as the video lane.
  const observedArtifactSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const capability = resolveCapability(dataPath, {
    handle: request.handle,
    observedArtifactSha256,
    expectedConversationId: grant.conversation_id,
  });
  if (capability.ok === false) {
    return refuseEdit(`image-edit-${capability.reason}`, describeArtifactCapabilityRefusal(capability.reason));
  }

  const instructionSha256 = crypto.createHash('sha256').update(instruction).digest('hex');

  // THE permit conversation fence — record against record, before the judgement.
  const permitRecord = readPermitRecord(dataPath, permit);
  if (permitRecord && permitRecord.conversation_id !== grant.conversation_id) {
    return refuseEdit(
      'image-edit-permit-conversation-mismatch',
      describeSpendPermitRefusal('permit-conversation-mismatch')
    );
  }

  // A response can be lost after the managed service staged the child. The
  // same permit + source + instruction then answers from the durable receipt,
  // before permit judgement or consumption can charge or reject it again.
  const completion = readCompletion(dataPath, permit, {
    conversationId: grant.conversation_id,
    instructionSha256,
    artifactSha256: observedArtifactSha256,
  }) as ImageEditSpendCompletion | undefined;
  if (completion) {
    const recovered = readStagedRecord(dataPath, completion.artifact_handle);
    if (
      recovered?.id === completion.artifact_id &&
      completion.source_artifact_id === source.id &&
      recovered.payload.parent_artifact_id === source.id &&
      typeof completion.artifact_handle === 'string'
    ) {
      return {
        ok: true,
        artifactHandle: completion.artifact_handle,
        parentArtifactId: source.id,
      };
    }
    return refuseEdit(
      'image-edit-result-unavailable',
      'Diese Bearbeitung wurde bereits ausgeführt, das Ergebnis ist aber nicht mehr auffindbar. Es wurde nichts erneut berechnet.'
    );
  }

  // THE spend authority, judged with operation `image_edit`: a video permit
  // cannot buy an image edit, and a permit not covering THESE bytes buys none.
  const permitEvaluation = evaluatePermit(dataPath, {
    permit,
    conversationId: grant.conversation_id,
    observedArtifactSha256,
    operation: 'image_edit',
  });
  if (permitEvaluation.ok === false) {
    return refuseEdit(`image-edit-${permitEvaluation.reason}`, describeSpendPermitRefusal(permitEvaluation.reason));
  }

  if (!seatStillMatches()) {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wurde während der Vorbereitung gewechselt. Starte die Bildbearbeitung erneut.',
      true
    );
  }
  const paidArtifactBlockReason = (deps.getPaidArtifactBlockReason ?? getCommandEvePaidArtifactBlockReason)();
  if (paidArtifactBlockReason === 'seat_recovery_required') {
    return refuseEdit(
      'image-edit-seat-recovery-required',
      'Der letzte Seed-Wechsel wurde nicht abgeschlossen. Starte Command EVE neu, bevor du die Bildbearbeitung erneut versuchst.'
    );
  }
  if (paidArtifactBlockReason === 'seat_transition_in_progress') {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Bildbearbeitung danach erneut.',
      true
    );
  }
  const releasePaidArtifactOperation = (
    deps.tryBeginPaidArtifactOperation ?? tryBeginCommandEvePaidArtifactOperation
  )();
  if (!releasePaidArtifactOperation) {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Bildbearbeitung danach erneut.',
      true
    );
  }

  // At most ONE paid edit in flight per conversation — shared with the video
  // lane, because two tool calls in the same breath must not spend twice.
  let conversationLockAcquired = false;
  try {
    conversationLockAcquired = acquireLock(dataPath, grant.conversation_id);
  } catch {
    releasePaidArtifactOperation();
    return refuseEdit('image-edit-lock-unavailable', describeSpendPermitRefusal('edit-already-in-flight'), true);
  }
  if (!conversationLockAcquired) {
    releasePaidArtifactOperation();
    return refuseEdit('image-edit-already-in-flight', describeSpendPermitRefusal('edit-already-in-flight'), true);
  }

  try {
    // ATOMIC, and before the provider call. The turn claim is
    // operation-agnostic — one spend per turn across media.
    const consumption = consumePermit(dataPath, {
      permit,
      conversationId: grant.conversation_id,
      userTurnSha256: permitEvaluation.record.user_turn_sha256,
      instructionSha256,
      artifactSha256: observedArtifactSha256,
    });
    if (consumption.ok === false) {
      return refuseEdit(
        `image-edit-${consumption.reason}`,
        describeSpendPermitRefusal(consumption.reason),
        consumption.reason === 'permit-in-flight'
      );
    }

    const requestId = crypto
      .createHash('sha256')
      .update(`${grant.conversation_id}\n${source.id}\n${observedArtifactSha256}\n${instructionSha256}`)
      .digest('hex');

    const managed = await (deps.runManagedEdit ?? productionEditDeps.runManagedEdit!)({
      instruction,
      referenceDataUrl: `data:${source.payload.mime_type};base64,${sourceBytes.toString('base64')}`,
      parentArtifactId: source.id,
      dataPath,
      expectedSeat: { id: capturedSeatId, revision: capturedSeatContextRevision },
      requestId,
    });
    if (!seatStillMatches()) {
      return refuseEdit(
        'image-edit-seat-changed',
        'Der aktive Seed wurde während der Bildbearbeitung gewechselt. Das Ergebnis bleibt dem ursprünglichen Seed zugeordnet.',
        false
      );
    }
    if (managed.status !== 200) {
      const error = managed.body.error as { code?: unknown; message?: unknown } | undefined;
      const code = error && typeof error.code === 'string' ? error.code : 'managed_image_failed';
      const message =
        error && typeof error.message === 'string' ? error.message : 'Die Bildbearbeitung ist fehlgeschlagen.';
      // The durable permit was consumed before the managed service ran. The
      // same permit cannot honestly be advertised as retryable; a new user
      // turn may retry with the deterministic request id above.
      return refuseEdit(`image-edit-${code}`, message, false);
    }
    const data = Array.isArray(managed.body.data)
      ? (managed.body.data[0] as Record<string, unknown> | undefined)
      : undefined;
    const artifactHandle = data && typeof data.artifact_handle === 'string' ? data.artifact_handle : '';
    if (!artifactHandle) {
      return refuseEdit(
        'image-edit-stage-failed',
        'Das bearbeitete Bild wurde erstellt, konnte aber nicht lokal gespeichert werden.'
      );
    }
    const stagedChild = readStagedRecord(dataPath, artifactHandle);
    if (stagedChild?.payload.parent_artifact_id === source.id) {
      try {
        recordCompletion(dataPath, permit, {
          artifact_id: stagedChild.id,
          source_artifact_id: source.id,
          conversation_id: grant.conversation_id,
          instruction_sha256: instructionSha256,
          artifact_sha256: observedArtifactSha256,
          completed_at_ms: Date.now(),
          artifact_handle: artifactHandle,
        } as ImageEditSpendCompletion);
      } catch {
        /* staged and returnable; losing the receipt only costs free recovery */
      }
    }
    // PATH-FREE by construction: the staged handle and the parent id are the
    // whole answer. The child binds through the terminal flow, exactly like a
    // fresh generation.
    return { ok: true, artifactHandle, parentArtifactId: source.id };
  } finally {
    try {
      releaseLock(dataPath, grant.conversation_id);
    } finally {
      releasePaidArtifactOperation();
    }
  }
}
