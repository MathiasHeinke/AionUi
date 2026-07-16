import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const collectStringValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStringValues);
  return [];
};

const connectorSource = read('packages/desktop/src/renderer/pages/connectorCatalog/index.tsx');
const runtimeSource = read('packages/desktop/src/renderer/pages/localRuntime/index.tsx');
const teamSource = read('packages/desktop/src/renderer/components/team/DeinTeamPanel.tsx');
const projectedSpendSource = read('packages/desktop/src/renderer/components/team/ProjectedSpendMeter.tsx');
const modelSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx'
);
const firstStepsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ErsteSchritteModalContent.tsx'
);
const billingSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/BillingModalContent.tsx'
);
const skillsSettingsSource = read('packages/desktop/src/renderer/pages/settings/SkillsHubSettings.tsx');
const capabilitiesSettingsSource = read('packages/desktop/src/renderer/pages/settings/CapabilitiesSettings.tsx');
const toolsSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ToolsModalContent.tsx'
);
const mcpServerItemSource = read('packages/desktop/src/renderer/pages/settings/ToolsSettings/McpServerItem.tsx');
const petSettingsSource = read('packages/desktop/src/renderer/pages/settings/PetSettings.tsx');
const privacySettingsSource = read('packages/desktop/src/renderer/pages/settings/PrivacySettings.tsx');
const accountSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/AccountModalContent.tsx'
);
const companyBrainSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent.tsx'
);
const systemSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/SystemModalContent/index.tsx'
);
const systemDevSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/SystemModalContent/DevSettings.tsx'
);
const aboutSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/AboutModalContent.tsx'
);
const webuiSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/WebuiModalContent.tsx'
);
const channelSettingsSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx'
);
const channelItemSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/ChannelItem.tsx'
);
const channelHeaderSource = read(
  'packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/ChannelHeader.tsx'
);
const channelFormSources = ['Telegram', 'Lark', 'DingTalk', 'Weixin', 'Wecom'].map((channelName) =>
  read(`packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/${channelName}ConfigForm.tsx`)
);
const settingsSemanticsSource = read('packages/desktop/src/renderer/components/settings/settingsSemantics.ts');
const visualThemeSource = read('packages/desktop/src/renderer/styles/themes/command-eve-visual.css');

describe('Command EVE settings migration contract', () => {
  it('routes connectors and local AI through the shared settings shell', () => {
    expect(connectorSource).toContain("<SettingsPageWrapper contentClassName='max-w-1120px'>");
    expect(runtimeSource).toContain("<SettingsPageWrapper contentClassName='max-w-1280px'>");
    expect(connectorSource).not.toContain('useLayoutContext');
    expect(runtimeSource).not.toContain('useLayoutContext');
    expect(runtimeSource).not.toContain("className='size-full overflow-y-auto bg-bg-1'");
  });

  it('keeps technical connector and runtime truth founder-gated', () => {
    expect(connectorSource).toContain('founderBuild: showTechnicalDetails');
    expect(connectorSource).toContain('showTechnicalDetails && preflightStatus.audit_event_path');
    expect(runtimeSource).toContain('founderBuild: showTechnicalDetails');
    expect(runtimeSource).toMatch(/showTechnicalDetails \? \([\s\S]{0,400}model\.hermes\.package/);
  });

  it('does not use purple or brand orange as connector/runtime status colors', () => {
    for (const source of [connectorSource, runtimeSource, teamSource]) {
      expect(source).not.toMatch(/color=['"]purple['"]/);
      expect(source).not.toMatch(/color=['"]orange['"]/);
      expect(source).not.toContain("return 'purple'");
      expect(source).not.toContain("return 'orange'");
    }
  });

  it('keeps internal worker routing out of the public team surface', () => {
    expect(teamSource).not.toMatch(/Claude-CLI|Codex-CLI|role-worker-select|role-lane-state/);
    expect(teamSource).not.toContain("status='warning'");
    expect(teamSource).not.toContain('<Card');
    expect(teamSource).toContain('deinTeam.skills.${skill}');
    expect(teamSource).not.toContain('{skill}\n              </Tag>');
  });

  it('uses provider-neutral public connector and local-AI copy', () => {
    const publicLocaleFiles = [
      'packages/desktop/src/renderer/services/i18n/locales/de-DE/connectorCatalog.json',
      'packages/desktop/src/renderer/services/i18n/locales/en-US/connectorCatalog.json',
      'packages/desktop/src/renderer/services/i18n/locales/de-DE/localRuntime.json',
      'packages/desktop/src/renderer/services/i18n/locales/en-US/localRuntime.json',
    ];

    for (const file of publicLocaleFiles) {
      const locale = JSON.parse(read(file)) as Record<string, unknown>;
      const publicCopy = collectStringValues({
        title: locale.title,
        subtitle: locale.subtitle,
        blocked: locale.blocked,
        warnings: locale.warnings,
        cardDescriptions: locale.cardDescriptions,
        publicNames: locale.publicNames,
        security: locale.security,
        secretHandling: locale.secretHandling,
        setupStates: locale.setupStates,
        setupActions: locale.setupActions,
        statusNote: locale.statusNote,
        setupModal: locale.setupModal,
        tierDescriptions: locale.tierDescriptions,
        receiptStatus: locale.receiptStatus,
        receiptNextAction: locale.receiptNextAction,
        errors: locale.errors,
        empty: locale.empty,
      }).join(' ');
      expect(publicCopy).not.toMatch(
        /AionUI|Company\.OS|Hermes|Gemma|Ollama|kanban\.db|Preflight|HumanGate|MCP|Dispatcher/i
      );
    }
  });

  it('keeps public connector and local-AI status copy out of raw runtime fields', () => {
    expect(connectorSource).toContain('connectorCatalog.values.checkPassed');
    expect(connectorSource).toContain('connectorCatalog.setupModal.security');
    expect(runtimeSource).toContain('localRuntime.receiptStatus.${normalizeReceiptStatus(model.receipt.status)}');
    expect(runtimeSource).toContain('localRuntime.receiptNextAction.${normalizeReceiptStatus(model.receipt.status)}');
    expect(runtimeSource).not.toContain("<span className='text-t-secondary'>{model.receipt.status}</span>");
  });

  it('keeps founder-only connector setup gated and public errors translated', () => {
    expect(connectorSource).toContain('const canUseGuidedAuth = isGuidedAuth && showTechnicalDetails');
    expect(connectorSource).toContain('canRunPreflight || canUseGuidedAuth');
    expect(connectorSource).toContain('connectorCatalog.setupModal.storedSuccess');
    expect(connectorSource).toContain('connectorCatalog.setupModal.setupFailed');
    expect(connectorSource).not.toContain("Message.success('Connector credential stored securely.')");
  });

  it('provides safe runtime fallbacks and preserves the full projected-cost value', () => {
    expect(runtimeSource).toContain("defaultValue: t('localRuntime.tierDescriptions.unknown')");
    expect(runtimeSource).toContain('normalizeReceiptStatus(model.receipt.status)');
    expect(projectedSpendSource).toContain('shrink-0 whitespace-nowrap');
    expect(projectedSpendSource).toContain("t('deinTeam.budget.title')");
  });

  it('keeps public settings copy provider-neutral and local paths private', () => {
    expect(modelSettingsSource).not.toContain('>{tier.label}</div>');
    expect(modelSettingsSource).not.toContain('>{tier.modelId}</div>');
    expect(modelSettingsSource).toContain('t(`settings.commandEveLocalRuntimeLane.${tier.lane}`)');
    expect(firstStepsSource).not.toContain('deine Claude-CLI');
    expect(skillsSettingsSource).toContain("t('settings.commandEveSkillStorage'");
    expect(skillsSettingsSource).toContain('COMMAND_EVE_SHELL_ENABLED ? undefined : skillPaths.user_skills_dir');

    for (const localeName of ['de-DE', 'en-US']) {
      const locale = JSON.parse(
        read(`packages/desktop/src/renderer/services/i18n/locales/${localeName}/settings.json`)
      ) as Record<string, unknown>;
      const publicCopy = collectStringValues({
        appDescription: locale.appDescription,
        commandEveAppDescription: locale.commandEveAppDescription,
        commandEveManagedSkillsNote: locale.commandEveManagedSkillsNote,
        commandEveRuntimeStatusDesc: locale.commandEveRuntimeStatusDesc,
        commandEveModelWarmupDesc: locale.commandEveModelWarmupDesc,
        commandEveModelSupportNote: locale.commandEveModelSupportNote,
        commandEveLocalRuntimeDesc: locale.commandEveLocalRuntimeDesc,
        commandEveLocalRuntimeBackend: locale.commandEveLocalRuntimeBackend,
        commandEveLocalRuntimeStatusUnknown: locale.commandEveLocalRuntimeStatusUnknown,
        commandEveLocalRuntimeRestartNote: locale.commandEveLocalRuntimeRestartNote,
        ersteSchritteStep: locale.ersteSchritteStep,
      }).join(' ');
      expect(publicCopy).not.toMatch(
        /AionUI|AionUi|Hermes|Claude|Codex|Gemma|Gemini|Ollama|custom:command-eve|\/Users\//i
      );
    }
  });

  it('renders model settings as humanized EVE sections instead of nested legacy panels', () => {
    expect(modelSettingsSource).toContain('SettingsPageHeader');
    expect(modelSettingsSource).toContain('SettingsSection');
    expect(modelSettingsSource).toContain("className='eve-model-tier'");
    expect(modelSettingsSource).not.toContain("className='flex flex-col bg-2 rd-16px");
    expect(modelSettingsSource).not.toContain('rounded-14px border border-solid');
    expect(modelSettingsSource).not.toMatch(/color=['"]orange['"]/);
    expect(modelSettingsSource).not.toMatch(/✅|❌/);
  });

  it('centralizes settings semantics without purple or orange status colors', () => {
    expect(settingsSemanticsSource).toContain("attention: 'gold'");
    expect(settingsSemanticsSource).not.toMatch(/purple|pink/i);
    expect(skillsSettingsSource).toContain('EVE_SETTINGS_TAG_COLOR');
    expect(skillsSettingsSource).not.toMatch(/#722ED1|#F5319D|#F77234/);
    expect(visualThemeSource).toContain('--eve-static-white: #ffffff');
    expect(visualThemeSource).toContain(".eve-settings-page [class*='transition-']");
  });

  it('keeps the simple settings routes on one unframed EVE section level', () => {
    for (const source of [
      petSettingsSource,
      privacySettingsSource,
      accountSettingsSource,
      companyBrainSettingsSource,
    ]) {
      expect(source).toContain('SettingsPageHeader');
      expect(source).toContain('SettingsSection');
      expect(source).not.toContain('<Card');
      expect(source).not.toContain('bg-2 rd-16px');
    }

    expect(companyBrainSettingsSource).not.toContain("color='purple'");
    expect(companyBrainSettingsSource).not.toContain('<button');
  });

  it('flattens onboarding and billing without hiding native controls in labels', () => {
    for (const source of [firstStepsSource, billingSettingsSource]) {
      expect(source).toContain('SettingsPageHeader');
      expect(source).toContain('SettingsSection');
      expect(source).not.toContain('<Card');
    }

    expect(firstStepsSource).not.toContain('<a');
    expect(billingSettingsSource).not.toContain("type='file'");
    expect(billingSettingsSource).toContain('<Upload');
  });

  it('keeps system and about routes on the shared unframed EVE contract', () => {
    for (const source of [systemSettingsSource, systemDevSettingsSource, aboutSettingsSource]) {
      expect(source).toContain('SettingsSection');
      expect(source).not.toContain('bg-2 rd-16px');
      expect(source).not.toContain('<Card');
    }

    expect(systemSettingsSource).toContain('SettingsPageHeader');
    expect(systemSettingsSource).not.toContain('<Collapse');
    expect(aboutSettingsSource).toContain('SettingsPageHeader');
    expect(aboutSettingsSource).not.toContain('<Typography');
    expect(aboutSettingsSource).not.toMatch(/<div[^>]+onClick=/);
  });

  it('renders capabilities as an unframed EVE library without internal worker inventory', () => {
    expect(capabilitiesSettingsSource).toContain('SettingsPageHeader');
    expect(capabilitiesSettingsSource).toContain('eve-settings-tabs');
    expect(skillsSettingsSource).toContain('SettingsSection');
    expect(skillsSettingsSource).toContain('<Input');
    expect(skillsSettingsSource).not.toContain('<button');
    expect(skillsSettingsSource).not.toContain('<input');
    expect(skillsSettingsSource).not.toContain('bg-base rd-16px');
    expect(skillsSettingsSource).not.toContain('connector.name || connector.id');
    expect(skillsSettingsSource).not.toContain('skill.name || skill.id');
  });

  it('flattens connected tools, image generation, and speech controls', () => {
    expect(toolsSettingsSource).toContain('SettingsSection');
    expect(toolsSettingsSource).toContain('toolsConnectedToolsTitle');
    expect(toolsSettingsSource).toContain("navigate('/settings/connectors')");
    expect(toolsSettingsSource).not.toContain('bg-2 rd-12px');
    expect(toolsSettingsSource).not.toContain("shape='round'");
    expect(mcpServerItemSource).toContain('eve-mcp-server-item');

    for (const localeName of ['de-DE', 'en-US']) {
      const locale = JSON.parse(
        read(`packages/desktop/src/renderer/services/i18n/locales/${localeName}/settings.json`)
      ) as Record<string, unknown>;
      const publicCopy = collectStringValues({
        capabilitiesPageDescription: locale.capabilitiesPageDescription,
        skillsHub: locale.skillsHub,
        speechToTextDescription: locale.speechToTextDescription,
        speechToTextProviderGroqHint: locale.speechToTextProviderGroqHint,
        toolsConnectedToolsTitle: locale.toolsConnectedToolsTitle,
        toolsConnectedToolsDescription: locale.toolsConnectedToolsDescription,
      }).join(' ');
      expect(publicCopy).not.toMatch(/AionUI|AionUi|Hermes|Codex CLI|Claude Code CLI|~\//i);
    }
  });

  it('renders Remote as an unframed EVE surface with accessible browser controls', () => {
    expect(webuiSettingsSource).toContain('SettingsPageHeader');
    expect(webuiSettingsSource).toContain('SettingsSection');
    expect(webuiSettingsSource).toContain('eve-settings-tabs eve-remote-tabs');
    expect(webuiSettingsSource).toContain('marginSize={4}');
    expect(webuiSettingsSource).not.toContain('CHANNEL_LOGOS');
    expect(webuiSettingsSource).not.toContain('bg-2 rd-16px');
    expect(webuiSettingsSource).not.toContain('<button');
    expect(webuiSettingsSource).not.toContain("<h2 className='text-20px");
  });

  it('keeps messaging channels public while EVE manages agent and model routing internally', () => {
    expect(channelSettingsSource).toContain('SettingsSection');
    expect(channelSettingsSource).toContain("bodyClassName='eve-channel-list'");
    expect(channelSettingsSource).not.toContain('Chat with AionUi');
    expect(channelSettingsSource).not.toContain('企微回调地址说明');
    expect(channelItemSource).toContain("className='eve-channel-item'");
    expect(channelHeaderSource).toContain('eve-channel-header__description');

    for (const source of channelFormSources) {
      expect(source).toContain('!COMMAND_EVE_SHELL_ENABLED');
      expect(source).not.toMatch(/<(?:div|span)\b[^>]*role=['"]button['"]/);
      expect(source).not.toContain('bg-fill-1 rd-12px');
      expect(source).not.toMatch(/bg-(?:blue|green|red|yellow)-(?:50|100)/);
    }

    expect(channelFormSources[3]).toContain('marginSize={4}');
  });
});
