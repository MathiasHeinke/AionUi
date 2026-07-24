/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Message, Modal } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import {
  isCommandEvePresentationPath,
  mergeCommandEvePreparedPresentationFiles,
} from '@/common/config/evePresentationIntelligenceCore';
import { isCommandEveImagePath, mergeCommandEvePreparedImageFiles } from '@/common/config/eveImageIntelligenceCore';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import type { CommandEvePreparedContextInput } from '@/common/config/evePreparedContextCore';
import type { AcpDocumentPreparationState } from './AcpDocumentPreparationStatus';

type SetPreparation = Dispatch<SetStateAction<AcpDocumentPreparationState | null>>;
export type CommandEveVisualPreparationResult = {
  files: string[];
  contexts: CommandEvePreparedContextInput[];
  cloudConsentGranted: boolean;
};

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
    async (files: string[]): Promise<CommandEveVisualPreparationResult | null> => {
      if (!input.isEveConversation) return { files, contexts: [], cloudConsentGranted: false };
      const presentationFiles = files.filter(isCommandEvePresentationPath);
      if (presentationFiles.length === 0) return { files, contexts: [], cloudConsentGranted: false };

      const startedAt = Date.now();
      const startedPreviewFiles: string[] = [];
      input.setDocumentPreparation({
        phase: 'reading_presentation_local',
        fileCount: presentationFiles.length,
        startedAt,
      });

      try {
        const invoke = (allowCloudVision: boolean) =>
          ipcBridge.commandEve.presentationPrepare.invoke({
            filePaths: presentationFiles,
            allowCloudVision,
            privacyLane: 'cloud_auto',
            locale: resolvedLocale(i18n),
            requestId: `pptx-${Date.now().toString(36)}`,
          });

        let response = await invoke(false);
        let initialFailure = response.data?.ok === false ? response.data : undefined;

        // The first inspect call validates the PPTX container, source path and
        // archive bounds before any OfficeCLI process sees it. Only when that
        // safe inspection reports a missing engine do we reuse the existing
        // signed Office preview bootstrap to install/start the small renderer.
        // Bootstrapping the first already-validated deck is sufficient because
        // OfficeCLI is shared by the following bounded inspection pass.
        if (initialFailure?.reason_code === 'EVE_PRESENTATION_ENGINE_UNAVAILABLE') {
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
          response = await invoke(false);
          initialFailure = response.data?.ok === false ? response.data : undefined;
        }

        if (response.success && response.data?.ok) {
          input.setDocumentPreparation({
            phase: 'presentation_handoff',
            fileCount: presentationFiles.length,
            startedAt,
          });
          return {
            files: mergeCommandEvePreparedPresentationFiles(files, response.data.documents),
            contexts: response.data.documents.map((document) => ({
              kind: 'presentation',
              sourceName: document.source_name,
              markdown: document.prompt_context,
            })),
            cloudConsentGranted: false,
          };
        }

        if (initialFailure?.requires_cloud_vision_consent !== true) {
          input.setDocumentPreparation({
            phase: 'presentation_error',
            fileCount: presentationFiles.length,
            startedAt,
          });
          Message.error({
            content: initialFailure?.message || t('conversation.presentation.prepareFailed'),
            duration: 6000,
          });
          return null;
        }

        input.setDocumentPreparation({
          phase: 'awaiting_cloud_vision',
          fileCount: presentationFiles.length,
          startedAt,
        });
        const approved = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: t('conversation.presentation.cloudVisionTitle'),
            content: t('conversation.presentation.cloudVisionDescription', {
              files:
                initialFailure.pending_source_names?.join(', ') || t('conversation.presentation.selectedDocuments'),
            }),
            okText: t('conversation.presentation.cloudVisionConfirm'),
            cancelText: t('common.cancel'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
            closable: true,
          });
        });
        if (!approved) {
          input.setDocumentPreparation(null);
          return null;
        }

        input.setDocumentPreparation({
          phase: 'reading_cloud_vision',
          fileCount: presentationFiles.length,
          startedAt,
        });
        response = await invoke(true);
        if (!response.success || !response.data?.ok) {
          input.setDocumentPreparation({
            phase: 'presentation_error',
            fileCount: presentationFiles.length,
            startedAt,
          });
          const cloudFailure = response.data?.ok === false ? response.data : undefined;
          Message.error({
            content: cloudFailure?.message || t('conversation.presentation.cloudVisionFailed'),
            duration: 6000,
          });
          return null;
        }
        input.setDocumentPreparation({
          phase: 'presentation_handoff',
          fileCount: presentationFiles.length,
          startedAt,
        });
        return {
          files: mergeCommandEvePreparedPresentationFiles(files, response.data.documents),
          contexts: response.data.documents.map((document) => ({
            kind: 'presentation',
            sourceName: document.source_name,
            markdown: document.prompt_context,
          })),
          cloudConsentGranted: true,
        };
      } catch (error) {
        console.error('[AcpSendBox] Presentation preparation failed:', error);
        input.setDocumentPreparation({
          phase: 'presentation_error',
          fileCount: presentationFiles.length,
          startedAt,
        });
        Message.error({
          content:
            getConversationRuntimeWorkspaceErrorMessage(error, t) || t('conversation.presentation.prepareFailed'),
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
    async (files: string[]): Promise<CommandEveVisualPreparationResult | null> => {
      if (!input.isEveConversation) return { files, contexts: [], cloudConsentGranted: false };
      const imageFiles = files.filter(isCommandEveImagePath);
      if (imageFiles.length === 0) return { files, contexts: [], cloudConsentGranted: false };

      const startedAt = Date.now();
      input.setDocumentPreparation({ phase: 'reading_image_local', fileCount: imageFiles.length, startedAt });
      const invoke = (allowCloudVision: boolean) =>
        ipcBridge.commandEve.imagePrepare.invoke({
          filePaths: imageFiles,
          allowCloudVision,
          privacyLane: 'cloud_auto',
          locale: resolvedLocale(i18n),
          requestId: `image-${Date.now().toString(36)}`,
        });

      try {
        let response = await invoke(false);
        if (response.success && response.data?.ok) {
          input.setDocumentPreparation({ phase: 'image_handoff', fileCount: imageFiles.length, startedAt });
          return {
            files: mergeCommandEvePreparedImageFiles(files, response.data.documents),
            contexts: response.data.documents.map((document) => ({
              kind: 'image',
              sourceName: document.source_name,
              markdown: document.prompt_context,
            })),
            cloudConsentGranted: false,
          };
        }

        const initialFailure = response.data?.ok === false ? response.data : undefined;
        if (initialFailure?.requires_cloud_vision_consent !== true) {
          input.setDocumentPreparation({ phase: 'image_error', fileCount: imageFiles.length, startedAt });
          Message.error({ content: initialFailure?.message || t('conversation.image.prepareFailed'), duration: 6000 });
          return null;
        }

        input.setDocumentPreparation({ phase: 'awaiting_image_cloud_vision', fileCount: imageFiles.length, startedAt });
        const approved = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: t('conversation.image.cloudVisionTitle'),
            content: t('conversation.image.cloudVisionDescription', {
              files: initialFailure.pending_source_names?.join(', ') || t('conversation.image.selectedImages'),
            }),
            okText: t('conversation.image.cloudVisionConfirm'),
            cancelText: t('common.cancel'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
            closable: true,
          });
        });
        if (!approved) {
          input.setDocumentPreparation(null);
          return null;
        }

        input.setDocumentPreparation({ phase: 'reading_image_cloud_vision', fileCount: imageFiles.length, startedAt });
        response = await invoke(true);
        if (!response.success || !response.data?.ok) {
          input.setDocumentPreparation({ phase: 'image_error', fileCount: imageFiles.length, startedAt });
          const cloudFailure = response.data?.ok === false ? response.data : undefined;
          Message.error({
            content: cloudFailure?.message || t('conversation.image.cloudVisionFailed'),
            duration: 6000,
          });
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
          cloudConsentGranted: true,
        };
      } catch (error) {
        console.error('[AcpSendBox] Image preparation failed:', error);
        input.setDocumentPreparation({ phase: 'image_error', fileCount: imageFiles.length, startedAt });
        Message.error({
          content: getConversationRuntimeWorkspaceErrorMessage(error, t) || t('conversation.image.prepareFailed'),
          duration: 6000,
        });
        return null;
      }
    },
    [i18n, input.isEveConversation, input.setDocumentPreparation, t]
  );

  return { preparePresentationFiles, prepareImageFiles };
}
