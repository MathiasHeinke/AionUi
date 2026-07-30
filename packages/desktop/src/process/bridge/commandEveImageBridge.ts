/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildCommandEveImageVisionRequest,
  COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION,
  COMMAND_EVE_IMAGE_MAX_CLOUD_RESPONSE_BYTES,
  parseCommandEveImageVisionResponse,
  type CommandEveImagePrepareRequest,
  type CommandEvePreparedImageDocument,
} from '@/common/config/eveImageIntelligenceCore';
import {
  COMMAND_EVE_MANAGED_VISION_ENABLED,
  COMMAND_EVE_MANAGED_VISION_GATEWAY_DEPLOYED,
  EVE_MULTIMODAL_FUNCTION_URL,
  resolveCommandEveMultimodalGate,
} from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import {
  CommandEveImagePreparationError,
  inspectLocalImage,
  prepareImageWithVision,
  type LocalImageInspection,
} from '@process/commandEve/document/imageIntelligenceService';
import { readCommandEveLimitedResponseText } from '@process/commandEve/limitedFetchResponse';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatContextRevision, getActiveSeatId, resolveSeatHome } from '@process/commandEve/seatContextCore';
import {
  readCommandEveCloudVisualPolicy,
  verifyCommandEveCloudVisualPolicyReceipt,
} from '@process/commandEve/visual/cloudVisualPolicyMain';
import { getDataPath } from '@process/utils/utils';

type CommandEveBridgeEnvelope<T> = { data?: T };

export type CommandEveImageBridgeDeps = {
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  resolveSeatHome: typeof resolveSeatHome;
  getDataPath: typeof getDataPath;
  areFileSelectionPathsGranted: typeof areCommandEveFileSelectionPathsGranted;
  readVisualPolicy: typeof readCommandEveCloudVisualPolicy;
  verifyVisualPolicyReceipt: typeof verifyCommandEveCloudVisualPolicyReceipt;
  fetch: typeof fetch;
};

const productionDeps: CommandEveImageBridgeDeps = {
  getActiveSeatId,
  getActiveSeatContextRevision,
  resolveSeatHome,
  getDataPath,
  areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
  readVisualPolicy: readCommandEveCloudVisualPolicy,
  verifyVisualPolicyReceipt: verifyCommandEveCloudVisualPolicyReceipt,
  fetch: (...args) => fetch(...args),
};

function unwrapRequest<T>(request?: T | CommandEveBridgeEnvelope<T>): T | undefined {
  if (request && typeof request === 'object' && 'data' in request) {
    return (request as CommandEveBridgeEnvelope<T>).data;
  }
  return request as T | undefined;
}

export async function handleCommandEveImagePrepare(
  request?: CommandEveImagePrepareRequest | CommandEveBridgeEnvelope<CommandEveImagePrepareRequest>,
  deps: CommandEveImageBridgeDeps = productionDeps
) {
  const payload = unwrapRequest<CommandEveImagePrepareRequest>(request);
  let capturedSeatId: string;
  let capturedSeatContextRevision: number;
  let hermesHome: string;
  try {
    capturedSeatId = deps.getActiveSeatId();
    capturedSeatContextRevision = deps.getActiveSeatContextRevision();
    hermesHome = deps.resolveSeatHome(deps.getDataPath(), capturedSeatId).hermesHome;
  } catch {
    return {
      success: false,
      msg: 'EVE_IMAGE_SEAT_UNAVAILABLE',
      data: {
        version: COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION,
        ok: false as const,
        reason_code: 'EVE_IMAGE_SEAT_UNAVAILABLE',
        documents: [],
        prepared_files: [],
        requires_cloud_vision_consent: false,
      },
    };
  }
  const seatStillMatches = (): boolean =>
    deps.getActiveSeatId() === capturedSeatId && deps.getActiveSeatContextRevision() === capturedSeatContextRevision;
  const filePaths = Array.from(
    new Set((Array.isArray(payload?.filePaths) ? payload.filePaths : []).filter((value) => typeof value === 'string'))
  );
  const selectedFilesStillGranted = (): boolean =>
    seatStillMatches() &&
    deps.areFileSelectionPathsGranted({
      filePaths,
      seatId: capturedSeatId,
      purpose: 'read',
    });
  const readyDocuments: CommandEvePreparedImageDocument[] = [];
  const preparedFiles = (): string[] => readyDocuments.map((document) => document.sidecar_path);
  const failure = (
    reasonCode: string,
    message?: string,
    options?: { requiresConsent?: boolean; pendingNames?: string[]; suppressDocuments?: boolean }
  ) => ({
    success: false,
    msg: reasonCode,
    data: {
      version: COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION,
      ok: false as const,
      reason_code: reasonCode,
      ...(message ? { message } : {}),
      documents: options?.suppressDocuments === true ? [] : readyDocuments,
      prepared_files: options?.suppressDocuments === true ? [] : preparedFiles(),
      requires_cloud_vision_consent: options?.requiresConsent === true,
      ...(options?.pendingNames?.length ? { pending_source_names: options.pendingNames } : {}),
    },
  });

  if (filePaths.length === 0 || filePaths.length > 5) {
    return failure('EVE_IMAGE_BAD_FILE_COUNT', 'Select between one and five JPEG, PNG or WebP images per message.');
  }
  if (!selectedFilesStillGranted()) {
    return failure(
      'EVE_IMAGE_SOURCE_NOT_USER_SELECTED',
      'For your safety, select the image again before EVE reads or uploads it.'
    );
  }

  const inspections: LocalImageInspection[] = [];
  for (const filePath of filePaths) {
    try {
      const inspection = inspectLocalImage({ filePath, hermesHome });
      inspections.push(inspection);
      if (inspection.cachedDocument) readyDocuments.push(inspection.cachedDocument);
    } catch (error) {
      const reasonCode =
        error instanceof CommandEveImagePreparationError ? error.reasonCode : 'EVE_IMAGE_LOCAL_EXTRACTION_FAILED';
      return failure(reasonCode, error instanceof Error ? error.message.slice(0, 300) : undefined);
    }
  }

  const pending = inspections.filter((inspection) => !inspection.cachedDocument);
  if (pending.length > 0) {
    const receipt = deps.verifyVisualPolicyReceipt(payload?.visualPolicyReceipt, payload?.flowId ?? '');
    if (!receipt.ok) {
      return failure(
        'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED',
        'Image analysis requires a fresh visual-policy receipt.',
        {
          pendingNames: pending.map((inspection) => inspection.sourceName),
          suppressDocuments: true,
        }
      );
    }
    if (
      receipt.seatId !== capturedSeatId ||
      receipt.seatContextRevision !== capturedSeatContextRevision ||
      !selectedFilesStillGranted()
    ) {
      return failure('EVE_IMAGE_SEAT_CHANGED', 'The active seat changed. Select the image again and retry.');
    }
    if (!COMMAND_EVE_MANAGED_VISION_ENABLED) return failure('EVE_IMAGE_CLOUD_VISION_NOT_ENABLED');
    const privacyLane = payload?.privacyLane ?? 'cloud_auto';
    const wireResult = readLicenseWire(deps.getDataPath());
    const gate = resolveCommandEveMultimodalGate({
      provider: 'openrouter',
      capability: 'vision',
      privacyLane,
      hasServerGateway: Boolean(EVE_MULTIMODAL_FUNCTION_URL) && COMMAND_EVE_MANAGED_VISION_GATEWAY_DEPLOYED,
      hasLicense: Boolean(wireResult.ok && wireResult.wire),
      directProviderKeyPresentInDesktop: false,
    });
    if (gate.ok === false) {
      return failure(`EVE_IMAGE_${gate.reason.toUpperCase().replace(/-/g, '_')}`, gate.message);
    }
    if (!wireResult.ok || !wireResult.wire) return failure(wireResult.reason_code || 'EVE_IMAGE_NO_BEARER');

    for (const [index, inspection] of pending.entries()) {
      try {
        const document = await prepareImageWithVision({
          inspection,
          hermesHome,
          locale: payload?.locale === 'en-US' ? 'en-US' : 'de-DE',
          requestId: `${payload?.requestId || `image-${Date.now().toString(36)}`}-${index + 1}`,
          assertPersistenceAllowed: () => {
            if (!selectedFilesStillGranted()) {
              throw new CommandEveImagePreparationError(
                'EVE_IMAGE_SEAT_CHANGED',
                'The active seat changed before the prepared image could be saved.'
              );
            }
          },
          analyze: async (input) => {
            const built = buildCommandEveImageVisionRequest({
              fileName: input.fileName,
              fileSha256: input.fileSha256,
              imageSha256: input.image.sha256,
              imageDataBase64: Buffer.from(input.image.bytes).toString('base64'),
              locale: input.locale,
              privacyLane,
              requestId: input.requestId,
            });
            if (built.ok === false) {
              throw new CommandEveImagePreparationError(built.reason_code, built.message);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90_000);
            try {
              if (!selectedFilesStillGranted()) {
                throw new CommandEveImagePreparationError(
                  'EVE_IMAGE_VISUAL_POLICY_STALE',
                  'Image analysis authorization is stale for the active seat.'
                );
              }
              const policy = await deps.readVisualPolicy();
              if (policy.status !== 'enabled' || policy.seatId !== capturedSeatId || !selectedFilesStillGranted()) {
                throw new CommandEveImagePreparationError(
                  policy.status === 'disabled'
                    ? 'EVE_IMAGE_CLOUD_VISUAL_POLICY_DISABLED'
                    : 'EVE_IMAGE_CLOUD_VISUAL_POLICY_UNAVAILABLE',
                  'Cloud image analysis is not enabled for the active seat.'
                );
              }
              const response = await deps.fetch(gate.functionUrl, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${wireResult.wire}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                redirect: 'error',
                cache: 'no-store',
                body: JSON.stringify(built.body),
                signal: controller.signal,
              });
              const responseText = await readCommandEveLimitedResponseText(
                response,
                COMMAND_EVE_IMAGE_MAX_CLOUD_RESPONSE_BYTES
              );
              if (!selectedFilesStillGranted()) {
                throw new CommandEveImagePreparationError(
                  'EVE_IMAGE_SEAT_CHANGED',
                  'The active seat changed before the prepared image could be saved.'
                );
              }
              if (responseText.ok === false) {
                throw new CommandEveImagePreparationError(
                  'EVE_IMAGE_VISION_RESPONSE_TOO_LARGE',
                  'Cloud image analysis returned too much data.'
                );
              }
              let raw: unknown = null;
              try {
                raw = JSON.parse(responseText.text);
              } catch {
                raw = null;
              }
              const parsed = parseCommandEveImageVisionResponse(raw);
              if (!response.ok || parsed.ok === false) {
                throw new CommandEveImagePreparationError(
                  parsed.ok === false ? parsed.reason_code : `EVE_IMAGE_VISION_HTTP_${response.status}`,
                  parsed.ok === false
                    ? parsed.message || 'Cloud image analysis failed.'
                    : 'Cloud image analysis failed.'
                );
              }
              if (
                parsed.data.vision.file_sha256 !== input.fileSha256 ||
                parsed.data.vision.source_kind !== 'image' ||
                parsed.data.vision.slide_count !== 1 ||
                parsed.data.vision.slide_numbers[0] !== 1
              ) {
                throw new CommandEveImagePreparationError(
                  'EVE_IMAGE_VISION_RECEIPT_MISMATCH',
                  'Cloud image analysis returned a mismatched source receipt.'
                );
              }
              return { markdown: parsed.data.artifact.text, model: parsed.data.vision.model };
            } catch (error) {
              if (error instanceof CommandEveImagePreparationError) throw error;
              const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
              throw new CommandEveImagePreparationError(
                name === 'AbortError' ? 'EVE_IMAGE_VISION_TIMEOUT' : 'EVE_IMAGE_VISION_FAILED',
                name === 'AbortError' ? 'Cloud image analysis timed out.' : 'Cloud image analysis failed.'
              );
            } finally {
              clearTimeout(timer);
            }
          },
        });
        readyDocuments.push(document);
      } catch (error) {
        const reasonCode =
          error instanceof CommandEveImagePreparationError ? error.reasonCode : 'EVE_IMAGE_VISION_FAILED';
        return failure(reasonCode, error instanceof Error ? error.message.slice(0, 300) : undefined);
      }
    }
  }

  return {
    success: true,
    data: {
      version: COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION,
      ok: true as const,
      documents: readyDocuments,
      prepared_files: preparedFiles(),
      cloud_vision_used: pending.length > 0,
      requires_cloud_vision_consent: false as const,
    },
  };
}
