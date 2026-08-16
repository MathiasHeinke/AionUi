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
  toPortableEvidencePath,
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
    if (applied) return;
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
  await sleep(560);
  const closed = overlay
    ? await cdp.evaluate(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(OVERLAY_CANDIDATE_SELECTOR)})].find(
          (candidate) =>
            candidate.dataset.eveGauntletOverlayId === ${JSON.stringify(overlay.gauntletId)}
        );
        if (!element) return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return !(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden');
      })()`)
    : null;

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
