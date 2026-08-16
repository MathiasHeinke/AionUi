import {
  describeArtifactCapabilityRefusal as describeLocalizedArtifactCapabilityRefusal,
  type ArtifactCapabilityOperation,
  type ArtifactCapabilityRefusal,
} from '@/common/config/eveArtifactCapabilityHandleCore';
import { DEFAULT_LANGUAGE } from '@/common/config/i18n';
import deDEConversation from '@renderer/services/i18n/locales/de-DE/conversation.json';
import enUSConversation from '@renderer/services/i18n/locales/en-US/conversation.json';
import { createInstance } from 'i18next';

const artifactCapabilityCopyI18n = createInstance();
const artifactCapabilityCopyReady = artifactCapabilityCopyI18n.init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  resources: {
    'de-DE': { translation: { conversation: deDEConversation } },
    'en-US': { translation: { conversation: enUSConversation } },
  },
  interpolation: { escapeValue: false },
});

export async function describeArtifactCapabilityRefusal(input: {
  operation: ArtifactCapabilityOperation;
  reason: ArtifactCapabilityRefusal;
}): Promise<string> {
  await artifactCapabilityCopyReady;
  return describeLocalizedArtifactCapabilityRefusal(artifactCapabilityCopyI18n.t, input);
}
