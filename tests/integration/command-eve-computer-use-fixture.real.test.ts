import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareHermesWheelOverlay } from './helpers/hermesWheelOverlay';

const python = process.env.COMMAND_EVE_HERMES_PYTHON || '';
const hermesWheel = process.env.COMMAND_EVE_HERMES_WHEEL || '';
const runReal = Boolean(python && fs.existsSync(python) && hermesWheel && fs.existsSync(hermesWheel));

const fixtureScript = String.raw`
import json
import threading

from tools.computer_use import tool as cu
from tools.computer_use.backend import ActionResult, CaptureResult, ComputerUseBackend, UIElement

class FixtureApp(ComputerUseBackend):
    def __init__(self):
        self.calls = []
        self.text = ""
        self.scroll_position = 0
        self.clicked = False

    def start(self): pass
    def stop(self): pass
    def is_available(self): return True
    def capture(self, mode="som", app=None, pid=None, window_id=None):
        self.calls.append("capture")
        return CaptureResult(
            mode=mode,
            width=480,
            height=320,
            app=app or "Command EVE Computer Use Fixture",
            window_title="Command EVE Computer Use Fixture",
            elements=[UIElement(index=1, role="AXButton", label="Local fixture button", bounds=(20, 20, 120, 32))],
        )
    def click(self, **kwargs):
        self.calls.append("click")
        self.clicked = True
        return ActionResult(ok=True, action="click", verified=True, effect="confirmed", path="fixture")
    def drag(self, **kwargs):
        self.calls.append("drag")
        return ActionResult(ok=True, action="drag", verified=True, effect="confirmed", path="fixture")
    def scroll(self, **kwargs):
        self.calls.append("scroll")
        self.scroll_position += int(kwargs.get("amount", 0))
        return ActionResult(ok=True, action="scroll", verified=True, effect="confirmed", path="fixture")
    def type_text(self, text, **kwargs):
        self.calls.append("type")
        self.text += text
        return ActionResult(ok=True, action="type", verified=True, effect="confirmed", path="fixture")
    def key(self, keys, **kwargs):
        self.calls.append("key")
        return ActionResult(ok=True, action="key", verified=True, effect="confirmed", path="fixture")
    def list_apps(self): return [{"name": "Command EVE Computer Use Fixture"}]
    def list_windows(self): return [{"title": "Command EVE Computer Use Fixture", "window_id": 1}]
    def focus_app(self, app, raise_window=False):
        self.calls.append("focus_app")
        return ActionResult(ok=True, action="focus_app", verified=True, effect="confirmed", path="fixture")
    def set_value(self, value, element=None):
        self.calls.append("set_value")
        self.text = value
        return ActionResult(ok=True, action="set_value", verified=True, effect="confirmed", path="fixture")

session_id = "fixture-session-known"
backend = FixtureApp()
cu.reset_backend_for_tests()
cu._backends[session_id] = backend
cu._backend_call_locks[session_id] = threading.RLock()
cu._backend_permission_modes[session_id] = "standard"

capture = json.loads(cu.handle_computer_use(
    {"action": "capture", "mode": "ax", "app": "Command EVE Computer Use Fixture"},
    session_id=session_id,
))

cu.set_approval_callback(lambda action, args, summary: "deny")
denied = json.loads(cu.handle_computer_use(
    {"action": "click", "coordinate": [40, 40]},
    session_id=session_id,
))

cu.set_approval_callback(lambda action, args, summary: "approve_once")
clicked = json.loads(cu.handle_computer_use(
    {"action": "click", "coordinate": [40, 40]},
    session_id=session_id,
))
typed = json.loads(cu.handle_computer_use(
    {"action": "type", "text": "provider-free"},
    session_id=session_id,
))
scrolled = json.loads(cu.handle_computer_use(
    {"action": "scroll", "direction": "down", "amount": 3},
    session_id=session_id,
))
unknown = json.loads(cu.handle_computer_use({"action": "future_unknown_action"}, session_id=session_id))

print(json.dumps({
    "capture": capture,
    "denied": denied,
    "clicked": clicked,
    "typed": typed,
    "scrolled": scrolled,
    "unknown": unknown,
    "calls": backend.calls,
    "state": {"clicked": backend.clicked, "text": backend.text, "scroll_position": backend.scroll_position},
}))
`;

describe.skipIf(!runReal)('native Hermes 0.20 Computer Use fixture integration', () => {
  it('captures and gates click/type/scroll against a provider-free local fixture', () => {
    const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-computer-use-fixture-'));
    const overlay = prepareHermesWheelOverlay(python, hermesWheel);
    try {
      const stdout = childProcess.execFileSync(python, ['-c', fixtureScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
          HERMES_DESKTOP: '1',
          CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
          PYTHONPATH: overlay.pythonPath,
        },
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const result = JSON.parse(stdout) as {
        capture: Record<string, unknown>;
        denied: Record<string, unknown>;
        clicked: Record<string, unknown>;
        typed: Record<string, unknown>;
        scrolled: Record<string, unknown>;
        unknown: { error: string };
        calls: string[];
        state: { clicked: boolean; text: string; scroll_position: number };
      };

      expect(result.capture).toMatchObject({ mode: 'ax', app: 'Command EVE Computer Use Fixture' });
      expect(result.denied).toMatchObject({ error: 'denied by user', action: 'click' });
      expect(result.clicked).toMatchObject({ ok: true, action: 'click', verified: true, effect: 'confirmed' });
      expect(result.typed).toMatchObject({ ok: true, action: 'type', verified: true, effect: 'confirmed' });
      expect(result.scrolled).toMatchObject({ ok: true, action: 'scroll', verified: true, effect: 'confirmed' });
      expect(result.unknown.error).toContain('unknown action');
      expect(result.calls).toEqual(['capture', 'click', 'type', 'scroll']);
      expect(result.state).toEqual({ clicked: true, text: 'provider-free', scroll_position: 3 });
    } finally {
      overlay.dispose();
      fs.rmSync(hermesHome, { recursive: true, force: true });
    }
  });
});
