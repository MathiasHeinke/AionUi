/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import {
  isCommandEvePresentationPath,
  mergeCommandEvePreparedPresentationFiles,
} from '@/common/config/evePresentationIntelligenceCore';
import { isCommandEveImagePath, mergeCommandEvePreparedImageFiles } from '@/common/config/eveImageIntelligenceCore';
import type { CommandEveCloudVisualPolicyReceipt } from '@/common/config/visual/cloudVisualPolicyCore';
import { scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';
import type { CommandEvePreparedContextInput } from '@/common/config/evePreparedContextCore';
import type { AcpDocumentPreparationState } from './AcpDocumentPreparationStatus';
import {
  groundingExpectationFromImage,
  type CommandEveAttachmentGroundingExpectation,
} from '@/common/config/eveAttachmentGroundingCore';

type SetPreparation = Dispatch<SetStateAction<AcpDocumentPreparationState | null>>;
export type CommandEveVisualPreparationResult = {
  files: string[];
  contexts: CommandEvePreparedContextInput[];
  attachmentGroundingEntries: CommandEveAttachmentGroundingExpectation[];
  requiresVisualPolicyReceipt: boolean;
};

export type CommandEveVisualPreparationAuthority = Readonly<{
  flowId: string;
  visualPolicyReceipt: CommandEveCloudVisualPolicyReceipt;
}>;

function resolvedLocale(i18n: { resolvedLanguage?: string; language?: string }): 'de-DE' | 'en-US' {
  return String(i18n.resolvedLanguage || i18n.language || 'de-DE')
    .toLowerCase()
    .startsWith('en')
    ? 'en-US'
    : 'de-DE';
}

export function useCommandEveVisualPreparation(input: {
  isEveConversation: boolean;
  workspacePath?: string;
  setDocumentPreparation: SetPreparation;
}) {
  const { t, i18n } = useTranslation();

  const preparePresentationFiles = useCallback(
    async (
      files: string[],
      authority?: CommandEveVisualPreparationAuthority
    ): Promise<CommandEveVisualPreparationResult | null> => {
      if (!input.isEveConversation)
        return { files, contexts: [], attachmentGroundingEntries: [], requiresVisualPolicyReceipt: false };
      const presentationFiles = files.filter(isCommandEvePresentationPath);
      if (presentationFiles.length === 0)
        return { files, contexts: [], attachmentGroundingEntries: [], requiresVisualPolicyReceipt: false };

      const startedAt = Date.now();
      const startedPreviewFiles: string[] = [];
      input.setDocumentPreparation({
        phase: 'reading_presentation_local',
        fileCount: presentationFiles.length,
        startedAt,
      });

      const invoke = () =>
        ipcBridge.commandEve.presentationPrepare.invoke({
          filePaths: presentationFiles,
          ...authority,
          privacyLane: 'cloud_auto',
          locale: resolvedLocale(i18n),
          requestId: `pptx-${Date.now().toString(36)}`,
        });

      try {
        let response = await invoke();
        let failure = response.data?.ok === false ? response.data : undefined;

        // OfficeCLI bootstrapping remains local and happens only after the safe
        // package inspection has identified the missing engine.
        if (failure?.reason_code === 'EVE_PRESENTATION_ENGINE_UNAVAILABLE') {
          const bootstrapFile = presentationFiles[0];
          const preview = await ipcBridge.pptPreview.start.invoke({
            file_path: bootstrapFile,
            ...(input.workspacePath ? { workspace: input.workspacePath } : {}),
          });
          if (preview.error || !preview.url) {
            input.setDocumentPreparation({
              phase: 'presentation_error',
              fileCount: presentationFiles.length,
              startedAt,
            });
            Message.error({ content: t('conversation.presentation.prepareFailed'), duration: 6000 });
            return null;
          }
          startedPreviewFiles.push(bootstrapFile);
          response = await invoke();
          failure = response.data?.ok === false ? response.data : undefined;
        }

        if (!response.success || !response.data?.ok) {
          if (failure?.reason_code === 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_REQUIRED' && authority === undefined) {
            input.setDocumentPreparation({
              phase: 'awaiting_cloud_vision',
              fileCount: presentationFiles.length,
              startedAt,
            });
            return {
              files: mergeCommandEvePreparedPresentationFiles(files, failure.documents),
              contexts: failure.documents.map((document) => ({
                kind: 'presentation',
                sourceName: document.source_name,
                markdown: document.prompt_context,
              })),
              attachmentGroundingEntries: [],
              requiresVisualPolicyReceipt: true,
            };
          }
          input.setDocumentPreparation({ phase: 'presentation_error', fileCount: presentationFiles.length, startedAt });
          // SCRUBBED (MAT-1749) AT THE READ, like the ACP PDF toasts.
          const failureText = scrubModelIdentifiers(failure?.message ?? '', CLOUD_MODEL_IDENTIFIERS);
          Message.error({ content: failureText || t('conversation.presentation.prepareFailed'), duration: 6000 });
          return null;
        }

        input.setDocumentPreparation({ phase: 'presentation_handoff', fileCount: presentationFiles.length, startedAt });
        return {
          files: mergeCommandEvePreparedPresentationFiles(files, response.data.documents),
          contexts: response.data.documents.map((document) => ({
            kind: 'presentation',
            sourceName: document.source_name,
            markdown: document.prompt_context,
          })),
          attachmentGroundingEntries: [],
          requiresVisualPolicyReceipt: false,
        };
      } catch (error) {
        console.error('[AcpSendBox] Presentation preparation failed:', error);
        input.setDocumentPreparation({ phase: 'presentation_error', fileCount: presentationFiles.length, startedAt });
        // SCRUBBED (MAT-1749): the builder's own fallback is the RAW upstream string.
        const presentationFailureText = scrubModelIdentifiers(
          getConversationRuntimeWorkspaceErrorMessage(error, t),
          CLOUD_MODEL_IDENTIFIERS
        );
        Message.error({
          content: presentationFailureText || t('conversation.presentation.prepareFailed'),
          duration: 6000,
        });
        return null;
      } finally {
        await Promise.allSettled(
          startedPreviewFiles.map((filePath) => ipcBridge.pptPreview.stop.invoke({ file_path: filePath }))
        );
      }
    },
    [i18n, input.isEveConversation, input.setDocumentPreparation, input.workspacePath, t]
  );

  const prepareImageFiles = useCallback(
    async (
      files: string[],
      authority?: CommandEveVisualPreparationAuthority
    ): Promise<CommandEveVisualPreparationResult | null> => {
      if (!input.isEveConversation)
        return { files, contexts: [], attachmentGroundingEntries: [], requiresVisualPolicyReceipt: false };
      const imageFiles = files.filter(isCommandEveImagePath);
      if (imageFiles.length === 0)
        return { files, contexts: [], attachmentGroundingEntries: [], requiresVisualPolicyReceipt: false };

      const startedAt = Date.now();
      input.setDocumentPreparation({ phase: 'reading_image_local', fileCount: imageFiles.length, startedAt });
      try {
        const response = await ipcBridge.commandEve.imagePrepare.invoke({
          filePaths: imageFiles,
          ...authority,
          privacyLane: 'cloud_auto',
          locale: resolvedLocale(i18n),
          requestId: `image-${Date.now().toString(36)}`,
        });
        if (!response.success || !response.data?.ok) {
          const failure = response.data?.ok === false ? response.data : undefined;
          if (failure?.reason_code === 'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED' && authority === undefined) {
            input.setDocumentPreparation({
              phase: 'awaiting_image_cloud_vision',
              fileCount: imageFiles.length,
              startedAt,
            });
            return {
              files: mergeCommandEvePreparedImageFiles(files, failure.documents),
              contexts: failure.documents.map((document) => ({
                kind: 'image',
                sourceName: document.source_name,
                markdown: document.prompt_context,
              })),
              attachmentGroundingEntries: failure.documents.map(groundingExpectationFromImage),
              requiresVisualPolicyReceipt: true,
            };
          }
          input.setDocumentPreparation({ phase: 'image_error', fileCount: imageFiles.length, startedAt });
          // SCRUBBED (MAT-1749) AT THE READ, like the ACP PDF toasts.
          const failureText = scrubModelIdentifiers(failure?.message ?? '', CLOUD_MODEL_IDENTIFIERS);
          Message.error({ content: failureText || t('conversation.image.prepareFailed'), duration: 6000 });
          return null;
        }

        input.setDocumentPreparation({ phase: 'image_handoff', fileCount: imageFiles.length, startedAt });
        return {
          files: mergeCommandEvePreparedImageFiles(files, response.data.documents),
          contexts: response.data.documents.map((document) => ({
            kind: 'image',
            sourceName: document.source_name,
            markdown: document.prompt_context,
          })),
          attachmentGroundingEntries: response.data.documents.map(groundingExpectationFromImage),
          requiresVisualPolicyReceipt: false,
        };
      } catch (error) {
        console.error('[AcpSendBox] Image preparation failed:', error);
        input.setDocumentPreparation({ phase: 'image_error', fileCount: imageFiles.length, startedAt });
        // SCRUBBED (MAT-1749): the builder's own fallback is the RAW upstream string.
        const imageFailureText = scrubModelIdentifiers(
          getConversationRuntimeWorkspaceErrorMessage(error, t),
          CLOUD_MODEL_IDENTIFIERS
        );
        Message.error({
          content: imageFailureText || t('conversation.image.prepareFailed'),
          duration: 6000,
        });
        return null;
      }
    },
    [i18n, input.isEveConversation, input.setDocumentPreparation, t]
  );

  return { preparePresentationFiles, prepareImageFiles };
}
