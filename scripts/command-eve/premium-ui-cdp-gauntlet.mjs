#!/usr/bin/env bun

/**
 * Command EVE premium UI CDP gauntlet.
 *
 * Owner: desktop UI maintainers and release reviewers.
 * Run: after icon/control/theme/motion changes, against an isolated local dev
 * Electron profile with a CDP port. This harness never deploys or approves a
 * release.
 * Pass: every route renders in both themes without runtime errors or visible
 * 100-250ms interaction motion; opened overlays stay inside the viewport,
 * expose a bounded scroll surface, use the neutral scrollbar lane, and keep
 * menu icon/text centers within 2px.
 * Output: screenshots plus a JSON evidence report. A failure routes back to
 * the offending component/token, then the entire matrix is rerun.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  OVERLAY_CANDIDATE_SELECTOR,
  OVERLAY_EXPECTATIONS,
  selectOwnedOverlay,
  summarizeDisabledRowCoverage,
  toPortableEvidencePath,
  validateIconStateInheritance,
  validateOverlayEvidence,
  validateReducedMotionEvidence,
} from './premium-ui-cdp-gauntlet-core.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.replace(/^--/, '').split('=');
    return [key, value.join('=') || 'true'];
  })
);

const cdpBase = args.cdp || 'http://127.0.0.1:9230';
const outputDir = resolve(args.out || 'artifacts/design-qa/premium-ui/gauntlet');
const sourceReference = args['source-ref'] || 'working-tree';
const themes = (args.themes || 'light,dark').split(',').filter(Boolean);
const routes = (
  args.routes ||
  '/guid,/settings/appearance,/settings/authority,/settings/capabilities,/settings/system,/projects,/kanban,/scheduled,/test/components'
)
  .split(',')
  .filter(Boolean);

mkdirSync(outputDir, { recursive: true });

const sleep = (duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration));
const slug = (value) => value.replace(/^\//, '').replaceAll(/[^a-z0-9]+/gi, '-') || 'root';

class CdpClient {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      this.events.push(message);
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, reject) => {
      this.socket.onopen = resolveOpen;
      this.socket.onerror = reject;
    });
  }

  async send(method, params = {}) {
    const id = ++this.nextId;
    const response = await new Promise((resolveResponse) => {
      this.pending.set(id, resolveResponse);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const pages = await (await fetch(`${cdpBase}/json/list`)).json();
const page = pages.find((entry) => entry.type === 'page' && /^http:\/\/localhost:\d+\//.test(entry.url));
if (!page) throw new Error(`No Command EVE renderer page exposed by ${cdpBase}`);

const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');

const setViewport = async (width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
};

// Row auditing leaves the real pointer on the last hovered row. A menu opened
// afterwards inherits that hover, which makes a synthetic hover indistinguish-
// able from an already-open panel. Park the pointer so hover state has exactly
// one source.
const parkPointer = async () => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await sleep(200);
};

const VISIBLE_PANEL_COUNT_EXPRESSION = `[...document.querySelectorAll('.arco-menu-pop, .arco-dropdown-menu')].filter((panel) => {
  const rect = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}).length`;

// Menus are portaled to the body, so a hash change does not unmount them and a
// single dismissal only closes the innermost panel. Each scenario therefore has
// to hand a closed shell to the next one, and report it when it cannot.
const dismissOpenPanels = async (attempts = 4) => {
  // Parking comes first: a panel held open by hover reopens immediately after a
  // dismissal click, so the pointer has to leave before anything is counted.
  await parkPointer();
  let remaining = await cdp.evaluate(VISIBLE_PANEL_COUNT_EXPRESSION);
  for (let attempt = 0; attempt < attempts && remaining > 0; attempt += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', clickCount: 1 });
    await sleep(560);
    remaining = await cdp.evaluate(VISIBLE_PANEL_COUNT_EXPRESSION);
  }
  return remaining;
};

const navigate = async (route) => {
  await cdp.evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100);
    const ready = await cdp.evaluate(`({
      route: location.hash,
      ready: document.readyState === 'complete' && Boolean(document.querySelector('#root > *')),
      loading: Boolean(document.querySelector('[data-testid="app-loader"], .arco-spin-loading')),
    })`);
    if (ready.ready && !ready.loading && ready.route.includes(route.split('?')[0])) break;
  }
  await sleep(520);
};

const screenshot = async (name) => {
  const capture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = resolve(outputDir, `${name}.png`);
  writeFileSync(path, Buffer.from(capture.data, 'base64'));
  return toPortableEvidencePath(process.cwd(), path);
};

const setReducedMotion = async (reduced) => {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
  });
};

const THEME_TRANSITION_SETTLE_MS = 900;

const setTheme = async (theme) => {
  await navigate('/settings/appearance');
  const selector = `[data-testid="eve-appearance-mode-${theme}"]`;
  const clicked = await cdp.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLElement)) return false;
    control.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Theme control missing: ${theme}`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    const applied = await cdp.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
    if (applied) {
      // The theme attribute flips before the token transition has repainted.
      // Auditing during that window reads interpolated colors instead of the
      // settled token, so wait for the transition to finish.
      await sleep(THEME_TRANSITION_SETTLE_MS);
      return;
    }
  }
  throw new Error(`Theme did not settle: ${theme}`);
};

const auditReducedMotion = async () =>
  cdp.evaluate(`(() => {
    const probe = document.createElement('span');
    probe.className = 'eve-icon eve-phosphor-icon eve-icon--spin';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const root = getComputedStyle(document.documentElement);
    const evidence = {
      mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      feedbackMotion: root.getPropertyValue('--eve-motion-duration-feedback').trim(),
      stateMotion: root.getPropertyValue('--eve-motion-duration-state').trim(),
    };
    probe.remove();
    return evidence;
  })()`);

const auditSurface = async () =>
  cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const durationSeconds = (value) => value.split(',').map((part) => {
      const raw = part.trim();
      return raw.endsWith('ms') ? Number.parseFloat(raw) / 1000 : Number.parseFloat(raw);
    }).filter(Number.isFinite);
    const interactives = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],input,textarea,select')]
      .filter(visible);
    const fastMotion = interactives.flatMap((element) => {
      const style = getComputedStyle(element);
      const durations = [...durationSeconds(style.transitionDuration), ...durationSeconds(style.animationDuration)];
      const fast = durations.filter((duration) => duration >= 0.1 && duration <= 0.25);
      return fast.length ? [{
        label: element.getAttribute('aria-label') || element.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 80) || element.tagName,
        className: String(element.className || '').slice(0, 160),
        durations: fast,
      }] : [];
    });
    const smallTargets = interactives.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width >= 24 && rect.height >= 24) return [];
      return [{
        label: element.getAttribute('aria-label') || element.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 80) || element.tagName,
        size: [Math.round(rect.width), Math.round(rect.height)],
      }];
    });
    const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const scrollables = [...document.querySelectorAll('*')].filter((element) => {
      if (!visible(element)) return false;
      // Arco appends a hidden textarea clone to the body to measure autosize
      // height. It sits behind the page and keeps the token of the theme it was
      // created under, so auditing it reports drift the user can never see.
      if (Number.parseInt(getComputedStyle(element).zIndex, 10) < 0) return false;
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 1 && ['auto', 'scroll'].includes(style.overflowY);
    });
    const scrollbarToken = getComputedStyle(document.documentElement).scrollbarColor;
    const scrollbarDrift = scrollables.flatMap((element) => {
      const value = getComputedStyle(element).scrollbarColor;
      return value === scrollbarToken ? [] : [{ className: String(element.className || '').slice(0, 160), value }];
    });
    return {
      route: location.hash,
      theme: document.documentElement.dataset.theme,
      interactiveCount: interactives.length,
      fastMotion,
      smallTargets,
      scrollbarDrift,
      scrollableCount: scrollables.length,
      tokens: {
        action: token('--eve-action'),
        brand: token('--eve-brand-logo'),
        text: token('--eve-shell-text'),
        surface: token('--eve-shell-surface'),
        scrollbarThumb: token('--eve-scrollbar-thumb'),
        feedbackMotion: token('--eve-motion-duration-feedback'),
        stateMotion: token('--eve-motion-duration-state'),
      },
    };
  })()`);

const OVERLAY_DISMISSAL_TIMEOUT_MS = 4000;
const OVERLAY_DISMISSAL_POLL_MS = 200;

const waitForOverlayDismissal = async (gauntletId) => {
  const deadline = Date.now() + OVERLAY_DISMISSAL_TIMEOUT_MS;
  let dismissed = false;
  do {
    await sleep(OVERLAY_DISMISSAL_POLL_MS);
    dismissed = await cdp.evaluate(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(OVERLAY_CANDIDATE_SELECTOR)})].find(
        (candidate) => candidate.dataset.eveGauntletOverlayId === ${JSON.stringify(gauntletId)}
      );
      if (!element) return true;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden');
    })()`);
  } while (!dismissed && Date.now() < deadline);
  return dismissed;
};

const openAndAudit = async (expectation, label) => {
  const trigger = await cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const ensureGauntletId = (element) => {
      if (!element.dataset.eveGauntletOverlayId) {
        window.__evePremiumGauntletOverlayCounter = (window.__evePremiumGauntletOverlayCounter || 0) + 1;
        element.dataset.eveGauntletOverlayId = 'eve-gauntlet-' + window.__evePremiumGauntletOverlayCounter;
      }
      return element.dataset.eveGauntletOverlayId;
    };
    const candidates = [...document.querySelectorAll(${JSON.stringify(OVERLAY_CANDIDATE_SELECTOR)})];
    candidates.forEach(ensureGauntletId);
    const element = document.querySelector(${JSON.stringify(expectation.selector)});
    if (!(element instanceof HTMLElement)) {
      return { found: false, beforeVisibleIds: candidates.filter(visible).map(ensureGauntletId), controlledIds: [] };
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return { found: false, beforeVisibleIds: candidates.filter(visible).map(ensureGauntletId), controlledIds: [] };
    }
    const controlledIds = [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')]
      .filter(Boolean)
      .flatMap((value) => value.split(/\\s+/))
      .filter(Boolean);
    return {
      found: true,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      beforeVisibleIds: candidates.filter(visible).map(ensureGauntletId),
      controlledIds,
    };
  })()`);
  if (!trigger.found) {
    return {
      label,
      triggerFound: false,
      controlledIds: trigger.controlledIds,
      selectionError: 'missing-trigger',
      overlay: null,
      closed: null,
      screenshot: await screenshot(label),
    };
  }

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: trigger.x,
    y: trigger.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: trigger.x,
    y: trigger.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(560);

  const candidates = await cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const ensureGauntletId = (element) => {
      if (!element.dataset.eveGauntletOverlayId) {
        window.__evePremiumGauntletOverlayCounter = (window.__evePremiumGauntletOverlayCounter || 0) + 1;
        element.dataset.eveGauntletOverlayId = 'eve-gauntlet-' + window.__evePremiumGauntletOverlayCounter;
      }
      return element.dataset.eveGauntletOverlayId;
    };
    return [...document.querySelectorAll(${JSON.stringify(OVERLAY_CANDIDATE_SELECTOR)})]
      .filter(visible)
      .map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll('[role="menuitem"],[role="option"],button')]
          .filter(visible)
          .slice(0, 24)
          .map((row) => {
            const rowRect = row.getBoundingClientRect();
            const icon = row.querySelector('.eve-phosphor-icon,.arco-icon,svg');
            const text = row.querySelector('span:not(.eve-phosphor-icon):not(.arco-icon)');
            let centerDelta = null;
            if (icon && text) {
              const iconRect = icon.getBoundingClientRect();
              const textRect = text.getBoundingClientRect();
              centerDelta = Math.abs(
                iconRect.top + iconRect.height / 2 - (textRect.top + textRect.height / 2)
              );
            }
            return {
              x: rowRect.x + rowRect.width / 2,
              y: rowRect.y + rowRect.height / 2,
              label:
                row.getAttribute('aria-label') ||
                row.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 120),
              centerDelta,
            };
          });
        return {
          gauntletId: ensureGauntletId(element),
          domId: element.id || null,
          className: String(element.className || ''),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          maxHeight: style.maxHeight,
          overflowY: style.overflowY,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollbarColor: style.scrollbarColor,
          viewport: { width: innerWidth, height: innerHeight },
          rows,
        };
      });
  })()`);

  const selection = selectOwnedOverlay({
    candidates,
    beforeVisibleIds: trigger.beforeVisibleIds,
    controlledIds: trigger.controlledIds,
    expectation,
  });
  const overlay = selection.overlay;

  if (overlay) {
    for (const row of overlay.rows) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
      await sleep(320);
    }
  }

  const image = await screenshot(label);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: trigger.x,
    y: trigger.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: trigger.x,
    y: trigger.y,
    button: 'left',
    clickCount: 1,
  });
  // The dismissal animation is longer than a single feedback step on a loaded
  // renderer, so a fixed wait reports a still-animating overlay as "did not
  // close". Poll to the deadline and keep the last observation authoritative,
  // so a genuinely stuck overlay still fails.
  const closed = overlay ? await waitForOverlayDismissal(overlay.gauntletId) : null;

  return {
    label,
    triggerFound: true,
    controlledIds: trigger.controlledIds,
    identityStrategy: selection.identityStrategy,
    selectionError: selection.selectionError,
    expectedRowSignature: expectation.rowSignature.map((pattern) => pattern.source),
    overlay,
    dismissalStrategy: 'trigger-toggle',
    closed,
    screenshot: image,
  };
};

const report = {
  schema: 'command-eve-premium-ui-gauntlet/v2',
  generatedAt: new Date().toISOString(),
  sourceReference,
  sourcePage: page.url,
  artifactRoot: toPortableEvidencePath(process.cwd(), outputDir),
  routes: [],
  overlays: [],
  reducedMotion: [],
  capabilitySubmenu: [],
  failures: [],
};

const recordOverlay = async ({ theme, expectation, label, scenario = 'standard' }) => {
  const evidence = await openAndAudit(expectation, label);
  const entry = { theme, scenario, selector: expectation.selector, expectation: expectation.id, ...evidence };
  report.overlays.push(entry);
  report.failures.push(
    ...validateOverlayEvidence(evidence, expectation).map((failure) => ({
      theme,
      scenario,
      selector: expectation.selector,
      ...failure,
    }))
  );
  if (!evidence.overlay) return evidence;

  const { overlay } = evidence;
  const overflowsViewport =
    overlay.rect.x < 0 ||
    overlay.rect.y < 0 ||
    overlay.rect.x + overlay.rect.width > overlay.viewport.width + 1 ||
    overlay.rect.y + overlay.rect.height > overlay.viewport.height + 1;
  const cannotScroll =
    overlay.scrollHeight > overlay.clientHeight + 1 && !['auto', 'scroll'].includes(overlay.overflowY);
  const iconDrift = overlay.rows.filter((row) => row.centerDelta !== null && row.centerDelta > 2);
  if (overflowsViewport) {
    report.failures.push({
      theme,
      scenario,
      selector: expectation.selector,
      kind: 'overlay-outside-viewport',
      overlay,
    });
  }
  if (cannotScroll) {
    report.failures.push({ theme, scenario, selector: expectation.selector, kind: 'overlay-not-scrollable', overlay });
  }
  if (iconDrift.length) {
    report.failures.push({
      theme,
      scenario,
      selector: expectation.selector,
      kind: 'menu-icon-misalignment',
      items: iconDrift,
    });
  }
  return evidence;
};

/**
 * Opens the tools menu, walks into the capabilities submenu and reads each row
 * as the user sees it: the resolved color of the label next to the resolved
 * color of its glyph. A row that dims its text while the icon stays bright is
 * the exact regression this step exists to catch, so it is captured in both
 * themes and includes a disabled row.
 */
const recordCapabilitySubmenu = async ({ theme }) => {
  const label = `${theme}-guid-capabilities-submenu`;
  const stalePanels = await dismissOpenPanels();
  if (stalePanels > 0) {
    report.failures.push({ theme, scenario: 'capabilities-submenu', kind: 'stale-panel-before-submenu', stalePanels });
  }
  const opened = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const PANEL_SELECTOR = '.arco-menu-pop, .arco-dropdown-menu';
    const panelKey = (element) => {
      if (!element.dataset.eveGauntletPanelId) {
        window.__evePremiumGauntletPanelCounter = (window.__evePremiumGauntletPanelCounter || 0) + 1;
        element.dataset.eveGauntletPanelId = 'eve-panel-' + window.__evePremiumGauntletPanelCounter;
      }
      return element.dataset.eveGauntletPanelId;
    };

    const trigger = document.querySelector('[data-testid="work-product-tools-trigger"]');
    if (!(trigger instanceof HTMLElement)) return { reason: 'missing-tools-trigger' };
    trigger.click();
    await sleep(700);

    const headers = [...document.querySelectorAll('.arco-dropdown-menu-pop-header')].filter(visible);
    const header = headers.at(-1);
    if (!header) return { reason: 'missing-capabilities-submenu-header' };

    // The tools menu is already open, so its own panel must not be mistaken for
    // the submenu. Only a panel that appears through this hover counts.
    const panelsBefore = new Set([...document.querySelectorAll(PANEL_SELECTOR)].filter(visible).map(panelKey));
    header.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(900);

    const opened = [...document.querySelectorAll(PANEL_SELECTOR)]
      .filter(visible)
      .filter((candidate) => !panelsBefore.has(panelKey(candidate)));
    if (opened.length === 0) return { reason: 'submenu-did-not-open' };
    if (opened.length > 1) return { reason: 'ambiguous-capabilities-submenu' };
    const panel = opened[0];

    // Capability entries are themselves submenu headers, so the pop-header is a
    // row here just like an ordinary item.
    const rows = [
      ...panel.querySelectorAll(
        '[role="menuitem"], .arco-menu-item, .arco-dropdown-menu-item, .arco-dropdown-menu-pop-header, .arco-menu-inline-header'
      ),
    ]
      .filter(visible)
      .slice(0, 24)
      .filter((row) => row.querySelector('.eve-phosphor-icon'));

    const read = (row, hovered) => {
      const icon = row.querySelector('.eve-phosphor-icon');
      const textNode = [...row.querySelectorAll('span')].find(
        (node) => !node.classList.contains('eve-phosphor-icon') && node.textContent?.trim()
      );
      return {
        label: (row.getAttribute('aria-label') || row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
        hovered,
        disabled:
          row.classList.contains('arco-menu-item-disabled') ||
          row.classList.contains('arco-dropdown-menu-item-disabled') ||
          row.getAttribute('aria-disabled') === 'true',
        textColor: getComputedStyle(textNode ?? row).color,
        iconColor: icon ? getComputedStyle(icon).color : null,
        iconFillAttribute: icon ? icon.getAttribute('fill') : null,
      };
    };

    // Each row is read twice: at rest and while hovered. Both readings must
    // agree between glyph and label, which is what makes the state change and
    // not just the idle paint part of the evidence.
    const measured = [];
    for (const row of rows) {
      measured.push(read(row, false));
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(420);
      measured.push(read(row, true));
      row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      await sleep(180);
    }

    return { reason: null, panelClass: String(panel.className || ''), rows: measured };
  })()`);

  const screenshotPath = await screenshot(label);
  const evidence = {
    theme,
    label,
    screenshot: screenshotPath,
    ...opened,
    ...summarizeDisabledRowCoverage(opened.rows),
  };
  report.capabilitySubmenu.push(evidence);

  if (opened.reason) {
    report.failures.push({ theme, scenario: 'capabilities-submenu', kind: opened.reason });
  } else {
    report.failures.push(
      ...validateIconStateInheritance(evidence).map((failure) => ({
        theme,
        scenario: 'capabilities-submenu',
        ...failure,
      }))
    );
  }

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(420);
  const leftoverPanels = await dismissOpenPanels();
  if (leftoverPanels > 0) {
    report.failures.push({ theme, scenario: 'capabilities-submenu', kind: 'submenu-did-not-dismiss', leftoverPanels });
  }
  return evidence;
};

try {
  await setReducedMotion(false);
  await setViewport(1440, 1000);
  for (const theme of themes) {
    await setTheme(theme);
    for (const route of routes) {
      cdp.events.length = 0;
      await navigate(route);
      const surface = await auditSurface();
      const image = await screenshot(`${theme}-${slug(route)}`);
      const runtimeEvents = cdp.events
        .filter((event) => ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method))
        .filter(
          (event) => event.method !== 'Log.entryAdded' || ['error', 'warning'].includes(event.params?.entry?.level)
        )
        .map((event) => event.params);
      const expectedRuntimeErrors = runtimeEvents.filter((event) =>
        JSON.stringify(event).includes('Blocked founder-only adapter bridge event: app.get-cdp-status.')
      );
      const runtimeErrors = runtimeEvents.filter(
        (event) => !JSON.stringify(event).includes('Blocked founder-only adapter bridge event: app.get-cdp-status.')
      );
      const entry = { theme, route, screenshot: image, surface, runtimeErrors, expectedRuntimeErrors };
      report.routes.push(entry);
      if (surface.theme !== theme) report.failures.push({ theme, route, kind: 'theme-drift', actual: surface.theme });
      if (surface.fastMotion.length) {
        report.failures.push({ theme, route, kind: 'fast-motion', items: surface.fastMotion });
      }
      if (surface.scrollbarDrift.length) {
        report.failures.push({ theme, route, kind: 'scrollbar-drift', items: surface.scrollbarDrift });
      }
      if (runtimeErrors.length) report.failures.push({ theme, route, kind: 'runtime-errors', items: runtimeErrors });
    }

    await navigate('/guid');
    for (const expectation of [
      OVERLAY_EXPECTATIONS.tools,
      OVERLAY_EXPECTATIONS.authority,
      OVERLAY_EXPECTATIONS.workspace,
    ]) {
      await recordOverlay({
        theme,
        expectation,
        label: `${theme}-guid-${expectation.id}`,
      });
    }

    await recordCapabilitySubmenu({ theme });

    await setViewport(1440, 440);
    await navigate('/guid');
    const narrow = await recordOverlay({
      theme,
      expectation: OVERLAY_EXPECTATIONS.authority,
      label: `${theme}-guid-authority-narrow-scroll`,
      scenario: 'narrow',
    });
    if (
      narrow.overlay?.scrollHeight > narrow.overlay?.clientHeight + 1 &&
      !['auto', 'scroll'].includes(narrow.overlay.overflowY)
    ) {
      report.failures.push({
        theme,
        scenario: 'narrow',
        kind: 'authority-narrow-not-scrollable',
        overlay: narrow.overlay,
      });
    }
    if (narrow.overlay && narrow.overlay.rect.y < 56) {
      report.failures.push({
        theme,
        scenario: 'narrow',
        kind: 'authority-narrow-overlaps-titlebar',
        overlay: narrow.overlay,
      });
    }

    await setViewport(1440, 1000);
    await setReducedMotion(true);
    await navigate('/guid');
    const motion = await auditReducedMotion();
    const motionScreenshot = await screenshot(`${theme}-guid-reduced-motion`);
    report.reducedMotion.push({ theme, route: '/guid', screenshot: motionScreenshot, ...motion });
    report.failures.push(
      ...validateReducedMotionEvidence(motion).map((failure) => ({
        theme,
        route: '/guid',
        ...failure,
      }))
    );
    await setReducedMotion(false);
  }
} catch (error) {
  report.failures.push({
    kind: 'harness-error',
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  await setReducedMotion(false).catch(() => undefined);
  const resultPath = resolve(outputDir, 'premium-ui-gauntlet-report.json');
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  cdp.close();
  console.log(
    JSON.stringify(
      {
        status: report.failures.length ? 'FAIL' : 'PASS',
        routes: report.routes.length,
        overlays: report.overlays.length,
        reducedMotion: report.reducedMotion.length,
        capabilitySubmenu: report.capabilitySubmenu.length,
        failures: report.failures.length,
        report: toPortableEvidencePath(process.cwd(), resultPath),
        artifactDirectory: basename(outputDir),
      },
      null,
      2
    )
  );
  if (report.failures.length) process.exitCode = 1;
}
