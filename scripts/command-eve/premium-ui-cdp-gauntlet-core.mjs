import { isAbsolute, relative, sep } from 'node:path';

export const OVERLAY_CANDIDATE_SELECTOR =
  '.arco-dropdown-menu,.arco-select-popup,.arco-picker-container,.arco-menu-pop,[role="menu"],[role="listbox"],[class*="authorityMenu"],[class*="_menu_"]';

export const OVERLAY_EXPECTATIONS = Object.freeze({
  tools: Object.freeze({
    id: 'tools',
    selector: '[data-testid="work-product-tools-trigger"]',
    rowSignature: Object.freeze([
      /(?:Bild erstellen|Create image)/i,
      /(?:Video erstellen|Create video)/i,
      /(?:Präsentation erstellen|Create presentation)/i,
      /(?:PDF erstellen|Create PDF)/i,
    ]),
  }),
  authority: Object.freeze({
    id: 'authority',
    selector: '[data-testid="composer-authority-control"]',
    rowSignature: Object.freeze([
      /(?:Nur zusehen|Watch only)/i,
      /(?:Fragen|Ask me)/i,
      /Routine/i,
      /(?:Arbeiten|Working)/i,
      /(?:Selbstständig|Independent)/i,
      /(?:Voll|Full)/i,
    ]),
  }),
  workspace: Object.freeze({
    id: 'workspace',
    selector: '[data-testid="workspace-context-control"]',
    rowSignature: Object.freeze([
      /(?:Anderen Ordner auswählen|Choose a different folder)/i,
      /(?:Kein Projekt|No Project)/i,
    ]),
  }),
});

const labelFor = (row) =>
  String(row?.label ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function matchOverlayRowSignature(candidate, expectation) {
  const labels = (candidate?.rows ?? []).map(labelFor);
  const missing = expectation.rowSignature
    .filter((pattern) => !labels.some((label) => pattern.test(label)))
    .map((pattern) => pattern.source);
  return { matches: missing.length === 0, missing, labels };
}

export function selectOwnedOverlay({ candidates, beforeVisibleIds, controlledIds, expectation }) {
  const visibleCandidates = candidates ?? [];
  const controlled = new Set(controlledIds ?? []);
  const controlledMatches = visibleCandidates.filter((candidate) => candidate.domId && controlled.has(candidate.domId));
  if (controlledMatches.length === 1) {
    return { overlay: controlledMatches[0], identityStrategy: 'aria-controls', selectionError: null };
  }
  if (controlledMatches.length > 1) {
    return { overlay: null, identityStrategy: 'aria-controls', selectionError: 'ambiguous-controlled-overlay' };
  }

  const before = new Set(beforeVisibleIds ?? []);
  const newlyVisible = visibleCandidates.filter((candidate) => !before.has(candidate.gauntletId));
  const signatureMatches = newlyVisible.filter((candidate) => matchOverlayRowSignature(candidate, expectation).matches);
  if (signatureMatches.length === 1) {
    return {
      overlay: signatureMatches[0],
      identityStrategy: 'newly-visible-signature',
      selectionError: null,
    };
  }
  if (signatureMatches.length > 1) {
    return {
      overlay: null,
      identityStrategy: 'newly-visible-signature',
      selectionError: 'ambiguous-signature-overlay',
    };
  }
  if (newlyVisible.length === 1) {
    return { overlay: newlyVisible[0], identityStrategy: 'newly-visible', selectionError: null };
  }
  return {
    overlay: null,
    identityStrategy: 'newly-visible',
    selectionError: newlyVisible.length === 0 ? 'no-new-overlay' : 'ambiguous-new-overlay',
  };
}

export function validateOverlayEvidence(evidence, expectation) {
  const failures = [];
  if (evidence?.skipped === true) failures.push({ kind: 'overlay-skipped' });
  if (evidence?.triggerFound !== true) failures.push({ kind: 'missing-trigger' });
  if (evidence?.selectionError) {
    failures.push({ kind: 'overlay-identity-mismatch', reason: evidence.selectionError });
  }
  if (!evidence?.overlay) {
    failures.push({ kind: 'missing-overlay' });
    return failures;
  }
  const signature = matchOverlayRowSignature(evidence.overlay, expectation);
  if (!signature.matches) {
    failures.push({ kind: 'wrong-overlay-signature', missing: signature.missing, labels: signature.labels });
  }
  if (evidence.closed === false) failures.push({ kind: 'overlay-did-not-close' });
  return failures;
}

export function validateReducedMotionEvidence(evidence) {
  const failures = [];
  if (evidence?.mediaMatches !== true) failures.push({ kind: 'reduced-motion-media-not-active' });
  if (evidence?.animationName !== 'none') {
    failures.push({ kind: 'reduced-motion-icon-still-animates', animationName: evidence?.animationName });
  }
  if (evidence?.feedbackMotion !== '0ms' || evidence?.stateMotion !== '0ms') {
    failures.push({
      kind: 'reduced-motion-token-drift',
      feedbackMotion: evidence?.feedbackMotion,
      stateMotion: evidence?.stateMotion,
    });
  }
  return failures;
}

export function toPortableEvidencePath(repoRoot, absolutePath) {
  if (!isAbsolute(absolutePath))
    throw new Error(`Evidence path must be absolute before normalization: ${absolutePath}`);
  const portable = relative(repoRoot, absolutePath).split(sep).join('/');
  if (!portable || portable === '..' || portable.startsWith('../')) {
    throw new Error(`Evidence path escapes repository root: ${absolutePath}`);
  }
  return portable;
}
