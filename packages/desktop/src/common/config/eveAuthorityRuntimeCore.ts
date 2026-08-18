/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seat's grant, rendered into the few booleans the Hermes-side approval
 * patch is allowed to obey — and rendered by asking `grantAllows`, never by
 * re-deciding anything here.
 *
 * WHY THIS FILE EXISTS. `decideAuthority`/`grantAllows` were built, tested and
 * then never called by production code, so the product fell back to "always
 * ask" and the whole ladder above rung 3 stored a preference and changed
 * nothing. The fix is not to teach Python the policy — it is to make the
 * EXISTING decision function the one that answers, and to hand the answers
 * across the process boundary as data.
 *
 * So the split is deliberate and load-bearing:
 *   - TypeScript DECIDES (every field below comes out of `grantAllows`),
 *   - the emitted patch OBEYS (it reads booleans; it contains no rung numbers,
 *     no thresholds, and no second copy of the ladder).
 *
 * That is what keeps the two ends from drifting: there is only one place where
 * a rung means anything.
 */

import {
  EVE_SEALED_CAPABILITIES,
  grantAllows,
  type EveAuthorityGrant,
  type EveSealedCapability,
} from './eveAuthorityCore';

/**
 * The wheel's edit-approval vocabulary (whl:acp_adapter/edit_approval.py:200
 * `should_auto_approve_edit`):
 *   - `ask`               always prompt,
 *   - `workspace_session` auto-approve only under the session cwd (+ the real
 *                         temp dir); sensitive paths still prompt,
 *   - `session`           auto-approve anywhere.
 * These three are exactly the distinction the ladder already draws between
 * `workspace_edit` and `reversible_outside`, which is why the mapping below is
 * a lookup and not a judgement.
 */
export type EveEditApprovalPolicy = 'ask' | 'workspace_session' | 'session';

/** What the approval patch is handed. Booleans only — no policy, no numbers to compare. */
export interface EveAuthorityRuntime {
  /** Present for the receipt/diagnostics only. Nothing in the patch branches on it. */
  ladder: number;
  edit_policy: EveEditApprovalPolicy;
  /** A terminal command inside the session's working folder may run unasked. */
  workspace_command: boolean;
  /** …and outside it. */
  outside_workspace_command: boolean;
  /** Irreversible actions may run unasked (rung 5). */
  irreversible: boolean;
  /**
   * The user explicitly allowed the enumerated opaque Browser/Desktop last mile
   * to run without one-operation cards. False for old grants and below rung 4.
   */
  opaque_ui_autorun: boolean;
  /**
   * Per seal: may EVE use it unasked right now? `spend.money` remains false in
   * this boolean-only projection. A real money decision needs the operation's
   * amount plus atomically persisted spend-today state; neither can be reduced
   * to one reusable boolean without turning the configured ceiling into a blank
   * cheque.
   */
  seals: Record<EveSealedCapability, boolean>;
  /** The user-configured ceiling for display/future metered calls. 0 = none configured. */
  spend_daily_cents: number;
  /**
   * Opaque revision of this exact runtime projection plus its seat context.
   * Native approval rule keys fold it in so "always" cannot survive a grant,
   * seal, opaque-UI, seat, or context revision without a ladder change. It is
   * intentionally not policy: the Python patch never interprets it.
   */
  authority_revision?: string;
}

/**
 * Probe a seal WITHOUT accidentally riding rung 0's read exemption.
 *
 * `grantAllows` short-circuits rung 0 to "reads only" BEFORE it looks at the
 * seal, so probing with `class: 'read'` would report every open seal as usable
 * on the hard off-switch. Probing with `irreversible` cannot: rung 0 rejects it
 * outright, every other rung falls through to the seal branch, and the seal —
 * not the rung — decides. Rung 0 therefore closes everything, which is what
 * "change nothing" has to mean.
 *
 * Money is intentionally not probed here. Its grant is amount-dependent, while
 * this runtime object is reused across many operations. A positive ceiling is
 * therefore preserved as data but never projected as `spend.money=true`.
 */
function sealUsable(grant: EveAuthorityGrant, capability: EveSealedCapability): boolean {
  if (capability === 'spend.money') return false;
  return grantAllows({ class: 'irreversible', sealed: capability, amountCents: 0 }, grant);
}

/**
 * Render the grant for the Hermes side. EVERY field is an answer from
 * `grantAllows` — this function contains no rung literal on purpose.
 */
export function renderEveAuthorityRuntime(grant: EveAuthorityGrant): EveAuthorityRuntime {
  const editsInWorkspace = grantAllows({ class: 'workspace_edit' }, grant);
  const editsOutside = grantAllows({ class: 'reversible_outside' }, grant);
  const seals = Object.fromEntries(
    EVE_SEALED_CAPABILITIES.map((capability) => [capability, sealUsable(grant, capability)])
  ) as Record<EveSealedCapability, boolean>;
  const configuredDailyCents = grant.limits?.['spend.money']?.dailyCents;
  const moneyConfigurationUsable = grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 0 }, grant);
  return {
    ladder: grant.ladder,
    edit_policy: editsOutside ? 'session' : editsInWorkspace ? 'workspace_session' : 'ask',
    workspace_command: grantAllows({ class: 'workspace_command' }, grant),
    outside_workspace_command: editsOutside,
    irreversible: grantAllows({ class: 'irreversible' }, grant),
    opaque_ui_autorun: grantAllows({ class: 'unclassified', opaqueUiAction: true }, grant),
    seals,
    spend_daily_cents:
      moneyConfigurationUsable && Number.isSafeInteger(configuredDailyCents) && configuredDailyCents > 0
        ? configuredDailyCents
        : 0,
  };
}

/**
 * Which seal a shell command would spend, or null.
 *
 * CONSERVATIVE BY CONSTRUCTION, and it has to be: this runs at the moment the
 * ladder would otherwise let a command through unasked, so a miss here is a
 * sealed capability spent without anyone deciding to. Every pattern below is
 * therefore broad, and anything it recognises falls back to asking unless that
 * exact seal is open.
 *
 * It is NOT a security boundary and must never be described as one — a
 * determined command can be spelled around any list of substrings. It is the
 * "do not let the everyday convenience setting quietly buy something else"
 * layer: the seals stay separate from the ladder, which is the whole reason
 * they are not rung 6.
 */
export function sealImplicatedByCommand(command: string): EveSealedCapability | null {
  const text = String(command ?? '').toLowerCase();
  if (!text.trim()) return null;
  // Money: anything that buys, tops up, or charges.
  if (/\b(stripe|checkout|purchase|billing)\b/.test(text)) return 'spend.money';
  // Outward publishing: it leaves this machine and other people can see it.
  if (/\b(npm|pnpm|yarn|bun)\s+publish\b/.test(text)) return 'publish.outward';
  if (/\bgit\s+push\b/.test(text)) return 'publish.outward';
  if (/\b(gh|hub)\s+(pr|release)\s+create\b/.test(text)) return 'publish.outward';
  if (/\btwine\s+upload\b/.test(text)) return 'publish.outward';
  // Production deploys.
  if (/\b(vercel|netlify|fly|heroku|wrangler)\s+deploy\b/.test(text)) return 'deploy.production';
  if (/\b(kubectl|helm)\b/.test(text)) return 'deploy.production';
  if (/\bsupabase\s+db\s+push\b/.test(text)) return 'deploy.production';
  // Credentials: reading them is the spend, not writing them.
  if (/(^|[\s;&|])(cat|less|more|head|tail|bat|strings)\s+[^\n;|&]*(\.env|\.npmrc|id_rsa|credentials|\.pem)/.test(text))
    return 'credentials.read';
  if (/\b(security\s+find-generic-password|keychain|gpg\s+--decrypt)\b/.test(text)) return 'credentials.read';
  // Deletion outside the working folder. `rm` alone is workspace_command; an
  // absolute or home-rooted target is the thing that is not.
  if (/\brm\s+(-[^\s]*\s+)*(~|\/)/.test(text)) return 'delete.outside';
  return null;
}

export type EveCommandApprovalVerdict = 'allow' | 'ask';

/**
 * The one decision the approval patch delegates back: may this terminal command
 * run without a card?
 *
 * Ordered so the answer can only ever narrow:
 *   1. an implicated seal must be OPEN — and it beats every rung, including 5;
 *   2. otherwise the rung's command class decides, split by where the command runs.
 *
 * Anything unresolved is `ask`. There is deliberately no branch that returns
 * `allow` for a reason other than these two.
 */
export function decideCommandApproval(
  input: { command: string; insideWorkspace: boolean },
  runtime: EveAuthorityRuntime
): EveCommandApprovalVerdict {
  const seal = sealImplicatedByCommand(input.command);
  if (seal) return runtime.seals[seal] === true ? 'allow' : 'ask';
  if (!input.insideWorkspace) return runtime.outside_workspace_command ? 'allow' : 'ask';
  return runtime.workspace_command ? 'allow' : 'ask';
}

const HERMES_BROWSER_READ_TOOLS = new Set([
  'browser_snapshot',
  'browser_get_images',
  'browser_vision',
  'browser_console',
]);
const HERMES_BROWSER_NAVIGATION_TOOLS = new Set(['browser_navigate', 'browser_scroll', 'browser_back']);
const HERMES_BROWSER_OPAQUE_ACTION_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_cdp',
  'browser_dialog',
]);
const HERMES_COMPUTER_READ_ACTIONS = new Set(['capture', 'wait', 'list_apps', 'list_windows', 'cua_browser_state']);
// Mirrored from the bundled Hermes 0.20.0 wheel's finite
// tools/computer_use/tool.py::_DESTRUCTIVE_ACTIONS. A new upstream action does
// NOT inherit unattended authority merely because it shares the tool name.
const HERMES_COMPUTER_OPAQUE_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
  'focus_app',
  'cua_browser_prepare',
  'cua_browser_navigate',
  'cua_browser_click',
  'cua_browser_type',
  'cua_browser_pointer',
  'cua_browser_dialog',
  'cua_browser_set_input_files',
  'cua_browser_download',
]);
const HERMES_ALWAYS_READ_TOOLS = new Set([
  'browser_snapshot',
  'browser_get_images',
  'browser_vision',
  'browser_console',
  'clarify',
  'feishu_doc_read',
  'feishu_drive_list_comments',
  'feishu_drive_list_comment_replies',
  'focus_pane',
  'ha_get_state',
  'ha_list_entities',
  'ha_list_services',
  'kanban_attachments',
  'kanban_list',
  'kanban_show',
  'open_preview',
  'project_list',
  'read_preview',
  'read_terminal',
  'read_window_below',
  'session_search',
  'skill_view',
  'skills_list',
  'tool_describe',
  'tool_search',
  'video_analyze',
  'vision_analyze',
  'web_extract',
  'web_search',
  'x_search',
]);
const HERMES_PRODUCT_MANAGED_TOOLS = new Set([
  'image_generate',
  'text_to_speech',
  'video_generate',
  'xai_video_edit',
  'xai_video_extend',
]);
const HERMES_PROCESS_READ_ACTIONS = new Set(['list', 'poll', 'log', 'wait']);
const HERMES_DISCORD_READ_ACTIONS = new Set([
  'server_info',
  'list_guilds',
  'list_channels',
  'list_roles',
  'member_info',
  'search_members',
  'channel_info',
  'fetch_messages',
  'list_pins',
]);
const HERMES_OUTWARD_TOOLS = new Set([
  'feishu_drive_add_comment',
  'feishu_drive_reply_comment',
  'react_to_message',
  'yb_send_dm',
  'yb_send_sticker',
]);

/**
 * The two builtin product MCP servers arrive with Hermes' native
 * `mcp__<server>__<tool>` envelope, so the seat's authority decision has to
 * key on the inner tool name per server. The same doctrine as native tools
 * applies: reads and the typed-UI surface are open at every rung, and the
 * paid image/video calls stay popup-free because the product's credit
 * preflight (or the minted permit, for edits) is their authority seam.
 *
 * A NEW tool on a known builtin server — or a new aionui server — is NOT
 * covered by these tables and stays behind the one-operation card. Third-party
 * MCP servers (`mcp__github__…`, user-configured) are deliberately not matched
 * here at all: they fall through to the catch-all and ask.
 */
const HERMES_BUILTIN_MCP_TOOL_POLICIES: ReadonlyMap<
  string,
  { read: ReadonlySet<string>; surface: ReadonlySet<string>; productManaged: ReadonlySet<string> }
> = new Map([
  [
    'mcp__aionui_image_generation__',
    { read: new Set(), surface: new Set(), productManaged: new Set(['aionui_image_generation']) },
  ],
  [
    'mcp__aionui_eve_artifacts__',
    {
      read: new Set(['eve_artifact_get', 'eve_artifact_list']),
      surface: new Set(['eve_typed_ui_publish']),
      productManaged: new Set(['eve_image_edit', 'eve_video_edit', 'eve_video_generate']),
    },
  ],
]);

function classifyBuiltinMcpTool(toolName: string): EveCommandApprovalVerdict | null {
  if (!toolName.startsWith('mcp__aionui_')) return null;
  for (const [prefix, policy] of HERMES_BUILTIN_MCP_TOOL_POLICIES) {
    if (!toolName.startsWith(prefix)) continue;
    const inner = toolName.slice(prefix.length);
    if (policy.read.has(inner) || policy.surface.has(inner) || policy.productManaged.has(inner)) {
      return 'allow';
    }
    // Known builtin server, unknown tool: installed, but it never inherits
    // unattended authority from its neighbours.
    return 'ask';
  }
  return 'ask';
}

/**
 * Decide whether a structured native Hermes action may run without a card.
 * This is deliberately separate from terminal command classification: native
 * tools have structured names/actions and must not be reverse-engineered into
 * pretend shell strings.
 *
 * Reads remain available at every rung. Local planning/delegation follows the
 * workspace-command grant, safe browser navigation follows reversible
 * outside-work, and outward/deleting actions obey their independent seals.
 * Opaque browser/Desktop interactions stay installed. Their exact enumerated
 * action set may auto-run only when the user enabled the separate opaque UI
 * override; that warning is honest that a click can indirectly cross any of the
 * five effect seals. Unknown future tools never inherit that override.
 * Product-managed image/video/voice calls remain popup-free because the
 * product's credit preflight is their authority seam.
 *
 * The Hermes tool's own hard blocks remain the survival floor after this
 * decision; this function can only add a user gate, never bypass an upstream
 * hard block.
 */
export function decideHermesToolApproval(
  input: { toolName: string; action?: string },
  runtime: EveAuthorityRuntime
): EveCommandApprovalVerdict {
  const toolName = String(input.toolName ?? '').trim();
  const action = String(input.action ?? '')
    .trim()
    .toLowerCase();

  const builtinMcpVerdict = classifyBuiltinMcpTool(toolName);
  if (builtinMcpVerdict) return builtinMcpVerdict;

  if (HERMES_ALWAYS_READ_TOOLS.has(toolName)) return 'allow';
  if (HERMES_PRODUCT_MANAGED_TOOLS.has(toolName) || toolName.startsWith('bfl_flux3_')) return 'allow';
  // The Tool-Search bridge executes the underlying tool with the Hermes hook
  // skipped, so the shim hook resolves and classifies the UNDERLYING name
  // before this point. A bare `tool_call` reaching here resolved to nothing —
  // it must never become an unattended backdoor into the deferred catalog.
  if (toolName === 'tool_call') return 'ask';
  if (HERMES_BROWSER_READ_TOOLS.has(toolName)) return 'allow';
  if (HERMES_BROWSER_NAVIGATION_TOOLS.has(toolName)) {
    return runtime.outside_workspace_command ? 'allow' : 'ask';
  }
  if (HERMES_BROWSER_OPAQUE_ACTION_TOOLS.has(toolName)) {
    if (toolName === 'browser_dialog' && action === 'dismiss') {
      return runtime.outside_workspace_command ? 'allow' : 'ask';
    }
    return runtime.opaque_ui_autorun ? 'allow' : 'ask';
  }
  // A new browser_* tool is not automatically a click/type equivalent. It
  // remains available behind the one-operation card until explicitly classified.
  if (toolName.startsWith('browser_')) return 'ask';
  if (toolName === 'computer_use') {
    if (HERMES_COMPUTER_READ_ACTIONS.has(action)) return 'allow';
    if (!action) return 'ask';
    if (!HERMES_COMPUTER_OPAQUE_ACTIONS.has(action)) return 'ask';
    return runtime.opaque_ui_autorun ? 'allow' : 'ask';
  }
  if (toolName === 'todo') {
    if (action === 'read') return 'allow';
    return runtime.workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'process') {
    if (HERMES_PROCESS_READ_ACTIONS.has(action)) return 'allow';
    if (!action) return 'ask';
    return runtime.workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'project_create' || toolName === 'project_switch' || toolName === 'delegate_task') {
    return runtime.workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'execute_code' || toolName === 'close_terminal' || toolName.startsWith('kanban_')) {
    return runtime.workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'memory') {
    if (action === 'remove') return runtime.irreversible ? 'allow' : 'ask';
    return action && runtime.outside_workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'skill_manage') {
    if (action === 'delete' || action === 'remove_file') {
      return runtime.seals['delete.outside'] ? 'allow' : 'ask';
    }
    return action && runtime.outside_workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'cronjob') {
    if (action === 'list') return 'allow';
    if (action === 'remove') return runtime.irreversible ? 'allow' : 'ask';
    return action && runtime.outside_workspace_command ? 'allow' : 'ask';
  }
  if (toolName === 'ha_call_service') return runtime.irreversible ? 'allow' : 'ask';
  if (toolName === 'discord' || toolName === 'discord_admin') {
    if (HERMES_DISCORD_READ_ACTIONS.has(action)) return 'allow';
    if (action === 'delete_message') return runtime.seals['delete.outside'] ? 'allow' : 'ask';
    return action && runtime.seals['publish.outward'] ? 'allow' : 'ask';
  }
  if (HERMES_OUTWARD_TOOLS.has(toolName)) return runtime.seals['publish.outward'] ? 'allow' : 'ask';

  // Capability-open means a new upstream Hermes tool remains installed and can
  // be used after the existing one-operation approval. It does not inherit
  // unattended authority until it declares enough metadata to identify the
  // concrete effect and the relevant independent seal.
  return 'ask';
}
