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
});
