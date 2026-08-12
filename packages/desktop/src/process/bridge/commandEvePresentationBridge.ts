/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildCommandEvePresentationVisionRequest,
  COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
  COMMAND_EVE_PRESENTATION_MAX_CLOUD_RESPONSE_BYTES,
  parseCommandEvePresentationVisionResponse,
  type CommandEvePreparedPresentationDocument,
  type CommandEvePresentationPrepareRequest,
} from '@/common/config/evePresentationIntelligenceCore';
import {
  COMMAND_EVE_MANAGED_VISION_ENABLED,
  COMMAND_EVE_MANAGED_VISION_GATEWAY_DEPLOYED,
  commandEveMediaSeedAttribution,
  EVE_MULTIMODAL_FUNCTION_URL,
  resolveCommandEveMultimodalGate,
} from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import {
  CommandEvePresentationPreparationError,
  inspectLocalPresentation,
  preparePresentationWithVision,
  type LocalPresentationInspection,
} from '@process/commandEve/document/presentationIntelligenceService';
import { readCommandEveLimitedResponseText } from '@process/commandEve/limitedFetchResponse';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatContextRevision, getActiveSeatId, resolveSeatHome } from '@process/commandEve/seatContextCore';
import {
  readCommandEveCloudVisualPolicy,
  verifyCommandEveCloudVisualPolicyReceipt,
} from '@process/commandEve/visual/cloudVisualPolicyMain';
import { getDataPath } from '@process/utils/utils';

type CommandEveBridgeEnvelope<T> = { data?: T };

export type CommandEvePresentationBridgeDeps = {
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  resolveSeatHome: typeof resolveSeatHome;
  getDataPath: typeof getDataPath;
  areFileSelectionPathsGranted: typeof areCommandEveFileSelectionPathsGranted;
  readVisualPolicy: typeof readCommandEveCloudVisualPolicy;
  verifyVisualPolicyReceipt: typeof verifyCommandEveCloudVisualPolicyReceipt;
  fetch: typeof fetch;
};

const productionDeps: CommandEvePresentationBridgeDeps = {
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

export async function handleCommandEvePresentationPrepare(
  request?: CommandEvePresentationPrepareRequest | CommandEveBridgeEnvelope<CommandEvePresentationPrepareRequest>,
  deps: CommandEvePresentationBridgeDeps = productionDeps
) {
  const payload = unwrapRequest<CommandEvePresentationPrepareRequest>(request);
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
      msg: 'EVE_PRESENTATION_SEAT_UNAVAILABLE',
      data: {
        version: COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
        ok: false as const,
        reason_code: 'EVE_PRESENTATION_SEAT_UNAVAILABLE',
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
  const readyDocuments: CommandEvePreparedPresentationDocument[] = [];
  const preparedFiles = (): string[] => readyDocuments.map((document) => document.sidecar_path);
  const failure = (
    reasonCode: string,
    message?: string,
    options?: { requiresConsent?: boolean; pendingNames?: string[]; suppressDocuments?: boolean }
  ) => ({
    success: false,
    msg: reasonCode,
    data: {
      version: COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
      ok: false as const,
      reason_code: reasonCode,
      ...(message ? { message } : {}),
      documents: options?.suppressDocuments === true ? [] : readyDocuments,
      prepared_files: options?.suppressDocuments === true ? [] : preparedFiles(),
      requires_cloud_vision_consent: options?.requiresConsent === true,
      ...(options?.pendingNames?.length ? { pending_source_names: options.pendingNames } : {}),
    },
  });

  if (filePaths.length === 0 || filePaths.length > 3) {
    return failure('EVE_PRESENTATION_BAD_FILE_COUNT', 'Select between one and three PPTX files per message.');
  }
  if (!selectedFilesStillGranted()) {
    return failure(
      'EVE_PRESENTATION_SOURCE_NOT_USER_SELECTED',
      'For your safety, select the presentation again before EVE reads or uploads it.'
    );
  }

  const inspections: LocalPresentationInspection[] = [];
  for (const filePath of filePaths) {
    try {
      const inspection = await inspectLocalPresentation({ filePath, hermesHome });
      inspections.push(inspection);
      if (inspection.cachedDocument) readyDocuments.push(inspection.cachedDocument);
    } catch (error) {
      const reasonCode =
        error instanceof CommandEvePresentationPreparationError
          ? error.reasonCode
          : 'EVE_PRESENTATION_LOCAL_EXTRACTION_FAILED';
      return failure(reasonCode, error instanceof Error ? error.message.slice(0, 300) : undefined);
    }
  }

  if (inspections.reduce((sum, inspection) => sum + inspection.slideCount, 0) > 200) {
    return failure('EVE_PRESENTATION_TOO_MANY_SLIDES', 'A single message can analyze at most 200 presentation slides.');
  }
  const pending = inspections.filter((inspection) => !inspection.cachedDocument);
  if (pending.length > 0) {
    const receipt = deps.verifyVisualPolicyReceipt(payload?.visualPolicyReceipt, payload?.flowId ?? '');
    if (!receipt.ok) {
      return failure(
        'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_REQUIRED',
        'Presentation analysis requires a fresh visual-policy receipt.',
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
      return failure(
        'EVE_PRESENTATION_SEAT_CHANGED',
        'The active seat changed. Select the presentation again and retry.'
      );
    }
    if (!COMMAND_EVE_MANAGED_VISION_ENABLED) return failure('EVE_PRESENTATION_CLOUD_VISION_NOT_ENABLED');
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
      return failure(`EVE_PRESENTATION_${gate.reason.toUpperCase().replace(/-/g, '_')}`, gate.message);
    }
    if (!wireResult.ok || !wireResult.wire) return failure(wireResult.reason_code || 'EVE_PRESENTATION_NO_BEARER');

    for (const inspection of pending) {
      try {
        const document = await preparePresentationWithVision({
          inspection,
          hermesHome,
          locale: payload?.locale === 'en-US' ? 'en-US' : 'de-DE',
          requestId: payload?.requestId || `pptx-${Date.now().toString(36)}`,
          assertPersistenceAllowed: () => {
            if (!selectedFilesStillGranted()) {
              throw new CommandEvePresentationPreparationError(
                'EVE_PRESENTATION_SEAT_CHANGED',
                'The active seat changed before the prepared presentation could be saved.'
              );
            }
          },
          analyzeBatch: async (batch) => {
            const built = buildCommandEvePresentationVisionRequest({
              fileName: batch.fileName,
              fileSha256: batch.fileSha256,
              slideCount: batch.slideCount,
              contextText: batch.contextText,
              locale: batch.locale,
              images: batch.images.map((image) => ({
                slideNumber: image.slideNumber,
                mimeType: image.mimeType,
                sha256: image.sha256,
                dataBase64: Buffer.from(image.bytes).toString('base64'),
              })),
              privacyLane,
              requestId: batch.requestId,
            });
            if (built.ok === false) {
              throw new CommandEvePresentationPreparationError(built.reason_code, built.message);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90_000);
            try {
              if (!selectedFilesStillGranted()) {
                throw new CommandEvePresentationPreparationError(
                  'EVE_PRESENTATION_VISUAL_POLICY_STALE',
                  'Presentation analysis authorization is stale for the active seat.'
                );
              }
              const policy = await deps.readVisualPolicy();
              if (policy.status !== 'enabled' || policy.seatId !== capturedSeatId || !selectedFilesStillGranted()) {
                throw new CommandEvePresentationPreparationError(
                  policy.status === 'disabled'
                    ? 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_DISABLED'
                    : 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_UNAVAILABLE',
                  'Cloud presentation analysis is not enabled for the active seat.'
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
                body: JSON.stringify({
                  ...built.body,
                  ...commandEveMediaSeedAttribution(capturedSeatId),
                }),
                signal: controller.signal,
              });
              const responseText = await readCommandEveLimitedResponseText(
                response,
                COMMAND_EVE_PRESENTATION_MAX_CLOUD_RESPONSE_BYTES
              );
              if (!selectedFilesStillGranted()) {
                throw new CommandEvePresentationPreparationError(
                  'EVE_PRESENTATION_SEAT_CHANGED',
                  'The active seat changed before the prepared presentation could be saved.'
                );
              }
              if (responseText.ok === false) {
                throw new CommandEvePresentationPreparationError(
                  'EVE_PRESENTATION_VISION_RESPONSE_TOO_LARGE',
                  'Cloud presentation analysis returned too much data.'
                );
              }
              let raw: unknown = null;
              try {
                raw = JSON.parse(responseText.text);
              } catch {
                raw = null;
              }
              const parsed = parseCommandEvePresentationVisionResponse(raw);
              if (!response.ok || parsed.ok === false) {
                throw new CommandEvePresentationPreparationError(
                  parsed.ok === false ? parsed.reason_code : `EVE_PRESENTATION_VISION_HTTP_${response.status}`,
                  parsed.ok === false
                    ? parsed.message || 'Cloud presentation analysis failed.'
                    : 'Cloud presentation analysis failed.'
                );
              }
              if (
                parsed.data.vision.file_sha256 !== batch.fileSha256 ||
                parsed.data.vision.slide_count !== batch.slideCount ||
                parsed.data.vision.slide_numbers.length !== batch.images.length ||
                parsed.data.vision.slide_numbers.some(
                  (slideNumber, index) => slideNumber !== batch.images[index]?.slideNumber
                )
              ) {
                throw new CommandEvePresentationPreparationError(
                  'EVE_PRESENTATION_VISION_RECEIPT_MISMATCH',
                  'Cloud presentation analysis returned a mismatched source or slide receipt.'
                );
              }
              return {
                markdown: parsed.data.artifact.text,
                model: parsed.data.vision.model,
                slideNumbers: parsed.data.vision.slide_numbers,
              };
            } catch (error) {
              if (error instanceof CommandEvePresentationPreparationError) throw error;
              const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
              throw new CommandEvePresentationPreparationError(
                name === 'AbortError' ? 'EVE_PRESENTATION_VISION_TIMEOUT' : 'EVE_PRESENTATION_VISION_FAILED',
                name === 'AbortError' ? 'Cloud presentation analysis timed out.' : 'Cloud presentation analysis failed.'
              );
            } finally {
              clearTimeout(timer);
            }
          },
        });
        readyDocuments.push(document);
      } catch (error) {
        const reasonCode =
          error instanceof CommandEvePresentationPreparationError ? error.reasonCode : 'EVE_PRESENTATION_VISION_FAILED';
        return failure(reasonCode, error instanceof Error ? error.message.slice(0, 300) : undefined);
      }
    }
  }

  return {
    success: true,
    data: {
      version: COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
      ok: true as const,
      documents: readyDocuments,
      prepared_files: preparedFiles(),
      cloud_vision_used: pending.length > 0,
      requires_cloud_vision_consent: false as const,
    },
  };
}
