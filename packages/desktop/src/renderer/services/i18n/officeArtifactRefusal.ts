import type { CommandEveOfficeArtifactRefusalReason } from '@/common/types/office/artifactLineage';
import type { TFunction } from 'i18next';

export function describeOfficeArtifactRefusal(t: TFunction, reason: CommandEveOfficeArtifactRefusalReason): string {
  switch (reason) {
    case 'invalid-request':
      return t('conversation.workProduct.officeRefusal.invalidRequest');
    case 'backend-unavailable':
      return t('conversation.workProduct.officeRefusal.backendUnavailable');
    case 'conversation-unavailable':
      return t('conversation.workProduct.officeRefusal.conversationUnavailable');
    case 'artifact-unavailable':
      return t('conversation.workProduct.referenceUnavailable');
    case 'source-outside-workspace':
      return t('conversation.workProduct.officeRefusal.sourceOutsideWorkspace');
    case 'source-unsafe':
      return t('conversation.workProduct.officeRefusal.sourceUnsafe');
    case 'source-format-mismatch':
      return t('conversation.workProduct.officeRefusal.sourceFormatMismatch');
    case 'seat-changed':
      return t('conversation.workProduct.officeRefusal.seatChanged');
    case 'operation-conflict':
      return t('conversation.workProduct.officeRefusal.operationConflict');
  }
}
