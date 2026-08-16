import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OVERLAY_EXPECTATIONS,
  selectOwnedOverlay,
  summarizeDisabledRowCoverage,
  toPortableEvidencePath,
  validateIconStateInheritance,
  validateOverlayEvidence,
  validateReducedMotionEvidence,
} from '../../../scripts/command-eve/premium-ui-cdp-gauntlet-core.mjs';

const overlay = (gauntletId: string, labels: string[], domId: string | null = null) => ({
  gauntletId,
  domId,
  rows: labels.map((label) => ({ label })),
});

const workspaceLabels = ['Choose a different folder', 'No Project'];
const authorityLabels = ['Watch only', 'Ask me', 'Routine', 'Working', 'Independent', 'Full'];

describe('premium UI overlay identity', () => {
  it('prefers the overlay owned through aria-controls', () => {
    const result = selectOwnedOverlay({
      candidates: [
        overlay('stale-authority', authorityLabels, 'authority-popup'),
        overlay('workspace', workspaceLabels, 'workspace-popup'),
      ],
      beforeVisibleIds: ['stale-authority'],
      controlledIds: ['workspace-popup'],
      expectation: OVERLAY_EXPECTATIONS.workspace,
    });

    expect(result.identityStrategy).toBe('aria-controls');
    expect(result.overlay?.gauntletId).toBe('workspace');
  });

  it('uses the newly visible row signature when a stale larger overlay remains visible', () => {
    const result = selectOwnedOverlay({
      candidates: [overlay('stale-authority', authorityLabels), overlay('workspace', workspaceLabels)],
      beforeVisibleIds: ['stale-authority'],
      controlledIds: [],
      expectation: OVERLAY_EXPECTATIONS.workspace,
    });

    expect(result.identityStrategy).toBe('newly-visible-signature');
    expect(result.overlay?.gauntletId).toBe('workspace');
  });

  it('fails closed when multiple newly visible overlays share the expected signature', () => {
    const result = selectOwnedOverlay({
      candidates: [overlay('workspace-a', workspaceLabels), overlay('workspace-b', workspaceLabels)],
      beforeVisibleIds: [],
      controlledIds: [],
      expectation: OVERLAY_EXPECTATIONS.workspace,
    });

    expect(result.overlay).toBeNull();
    expect(result.selectionError).toBe('ambiguous-signature-overlay');
  });
});

describe('premium UI overlay evidence gate', () => {
  it('treats a missing or skipped trigger as a failure', () => {
    const failures = validateOverlayEvidence(
      { skipped: true, triggerFound: false, overlay: null },
      OVERLAY_EXPECTATIONS.workspace
    );

    expect(failures.map((failure) => failure.kind)).toEqual(['overlay-skipped', 'missing-trigger', 'missing-overlay']);
  });

  it('rejects a wrong overlay even when a trigger and overlay both exist', () => {
    const failures = validateOverlayEvidence(
      {
        triggerFound: true,
        overlay: overlay('authority', authorityLabels),
        selectionError: null,
        closed: true,
      },
      OVERLAY_EXPECTATIONS.workspace
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('wrong-overlay-signature');
  });

  it('accepts an owned overlay with the expected rows and verified close', () => {
    const failures = validateOverlayEvidence(
      {
        triggerFound: true,
        overlay: overlay('workspace', workspaceLabels),
        selectionError: null,
        closed: true,
      },
      OVERLAY_EXPECTATIONS.workspace
    );

    expect(failures).toEqual([]);
  });
});

describe('premium UI reduced-motion and evidence portability', () => {
  it('accepts disabled icon motion and zero-duration semantic tokens', () => {
    expect(
      validateReducedMotionEvidence({
        mediaMatches: true,
        animationName: 'none',
        feedbackMotion: '0ms',
        stateMotion: '0ms',
      })
    ).toEqual([]);
  });

  it('rejects a reduced-motion run that still animates', () => {
    const failures = validateReducedMotionEvidence({
      mediaMatches: true,
      animationName: 'eve-phosphor-icon-spin',
      feedbackMotion: '300ms',
      stateMotion: '400ms',
    });

    expect(failures.map((failure) => failure.kind)).toEqual([
      'reduced-motion-icon-still-animates',
      'reduced-motion-token-drift',
    ]);
  });

  it('normalizes repository evidence paths and rejects paths outside the repository', () => {
    const root = resolve('/repo');
    expect(toPortableEvidencePath(root, resolve(root, 'artifacts/report.json'))).toBe('artifacts/report.json');
    expect(() => toPortableEvidencePath(root, resolve('/elsewhere/report.json'))).toThrow(
      'Evidence path escapes repository root'
    );
  });
});

describe('capabilities submenu icon state inheritance', () => {
  const row = (overrides = {}) => ({
    label: 'Skills',
    hovered: false,
    disabled: false,
    textColor: 'rgb(17, 24, 39)',
    iconColor: 'rgb(17, 24, 39)',
    iconFillAttribute: 'currentColor',
    ...overrides,
  });

  it('accepts a submenu whose glyphs carry the color of their own row at rest and on hover', () => {
    const failures = validateIconStateInheritance({
      rows: [
        row(),
        row({ hovered: true, textColor: 'rgb(37, 99, 235)', iconColor: 'rgb(37, 99, 235)' }),
        row({ label: 'MCP' }),
      ],
    });

    expect(failures).toEqual([]);
  });

  it('fails a hovered row that recolors its text while the icon stays behind', () => {
    const failures = validateIconStateInheritance({
      rows: [row(), row({ hovered: true, textColor: 'rgb(37, 99, 235)', iconColor: 'rgb(17, 24, 39)' })],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'icon-color-does-not-follow-text' });
  });

  it('fails a disabled row that dims its text while the icon stays bright', () => {
    const failures = validateIconStateInheritance({
      rows: [
        row({ hovered: true }),
        row({ label: 'Empty', disabled: true, textColor: 'rgba(89, 98, 115, 0.56)', iconColor: 'rgb(17, 24, 39)' }),
      ],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'icon-color-does-not-follow-text', label: 'Empty' });
  });

  it('accepts the inheriting fill attribute but fails a pinned color', () => {
    expect(validateIconStateInheritance({ rows: [row({ hovered: true })] })).toEqual([]);

    const failures = validateIconStateInheritance({
      rows: [row({ hovered: true, iconFillAttribute: 'var(--text-primary)' })],
    });

    expect(failures.map((failure) => failure.kind)).toContain('icon-carries-pinned-fill-attribute');
  });

  it('fails closed when the submenu never opened or never reached a hovered state', () => {
    expect(validateIconStateInheritance({ rows: [] })).toEqual([{ kind: 'submenu-has-no-rows' }]);
    expect(validateIconStateInheritance({ rows: [row()] })).toEqual([{ kind: 'submenu-missing-hovered-row' }]);
  });

  it('reports disabled-row coverage truthfully instead of implying it was exercised', () => {
    expect(summarizeDisabledRowCoverage([row({ hovered: true })])).toEqual({
      disabledRowsObserved: 0,
      disabledRowsInherit: true,
    });
    expect(
      summarizeDisabledRowCoverage([
        row({ label: 'Empty', disabled: true, textColor: 'rgba(89, 98, 115, 0.56)', iconColor: 'rgb(17, 24, 39)' }),
      ])
    ).toEqual({ disabledRowsObserved: 1, disabledRowsInherit: false });
  });
});
