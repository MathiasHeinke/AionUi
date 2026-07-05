import { describe, expect, it } from 'vitest';
import { COMMAND_EVE_ASSISTANT_ID } from '@/common/config/commandEveShell';
import {
  COMMAND_EVE_ASSISTANT_RULE_DE,
  COMMAND_EVE_ASSISTANT_RULE_EN,
  COMMAND_EVE_ASSISTANT_RULE_FOUNDER_DE,
  COMMAND_EVE_ASSISTANT_RULE_FOUNDER_EN,
  COMMAND_EVE_ASSISTANT_SKILL_DE,
  COMMAND_EVE_ASSISTANT_SKILL_EN,
  COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_DE,
  COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_EN,
  buildCommandEveAssistantFirstRunContext,
  buildCommandEveAssistant,
  buildCommandEveAssistantContext,
  buildCommandEveAssistantSkill,
  getCommandEveAssistantRule,
  selectCommandEvePresetAgentType,
  unwrapCommandEveApiData,
} from '@/process/commandEve/assistantBootstrapCore';

describe('Command EVE assistant bootstrap core', () => {
  it('binds EVE to Hermes when a verified Hermes agent is detected', () => {
    expect(
      selectCommandEvePresetAgentType([
        { backend: 'codex', available: true },
        { backend: 'hermes', available: true },
      ])
    ).toBe('hermes');
  });

  it('binds EVE to Hermes even when only NON-EVE backends are online (never aionrs)', () => {
    // The Jun-2026 freeze: hermes was not online at seed time, so the selector
    // fell through to aionrs and 1.2.7 froze that binding → "kein Modell
    // ausgewählt". EVE has no model wiring on aionrs, so a non-online hermes must
    // still bind to hermes (durable config, attached once the runtime is up).
    expect(
      selectCommandEvePresetAgentType([
        { backend: 'codex', available: true },
        { backend: 'claude', available: true },
      ])
    ).toBe('hermes');
  });

  it('binds EVE to Hermes when NOTHING is online yet (never aionrs)', () => {
    expect(selectCommandEvePresetAgentType([{ backend: 'codex', available: false }])).toBe('hermes');
    expect(selectCommandEvePresetAgentType([])).toBe('hermes');
  });

  it('unwraps backend API envelopes before runtime selection', () => {
    const agents = unwrapCommandEveApiData({
      success: true,
      data: [{ backend: 'codex', available: true }],
    });

    expect(selectCommandEvePresetAgentType(agents)).toBe('hermes');
  });

  it('builds the canonical EVE preset assistant (operator-facing by default)', () => {
    const assistant = buildCommandEveAssistant('codex');
    expect(assistant.id).toBe(COMMAND_EVE_ASSISTANT_ID);
    expect(assistant.name).toBe('EVE');
    expect(assistant.preset_agent_type).toBe('codex');
    // Avatar is RELATIVE ('./') so it resolves under the packaged file:// HashRouter
    // (an absolute '/...' hits the filesystem root → broken image).
    expect(assistant.avatar).toBe('./command-eve-logo.svg');
    // The shipped operator assistant is "The Operator", never the internal founder persona.
    expect(assistant.description).not.toContain('Chief-of-Staff');
    expect(assistant.description).toMatch(/Geldverdienen|making money/);
    expect(assistant.description_i18n?.['de-DE']).not.toContain('Chief-of-Staff');
    expect(assistant.description_i18n?.['en-US']).toMatch(/making money/);
    expect(assistant.disabled_builtin_skills).toEqual([
      'aionui-skills',
      'cron',
      'skill-creator',
      'moltbook',
      'story-roleplay',
      'openclaw-setup',
      'star-office-helper',
      'xiaohongshu-recruiter',
      'weixin-file-send',
      'x-recruiter',
      'aionui-webui-setup',
    ]);
    expect(assistant.disabled_builtin_skills).not.toContain('officecli');
    expect(assistant.disabled_builtin_skills).not.toContain('pdf');
  });

  it('attaches imported Command EVE managed custom skills to EVE', () => {
    const assistant = buildCommandEveAssistant('hermes', [
      'first-run-company-discovery',
      'goal-materialization',
      'first-run-company-discovery',
      '',
    ]);

    expect(assistant.enabled_skills).toEqual(['first-run-company-discovery', 'goal-materialization']);
    expect(assistant.custom_skill_names).toEqual(['first-run-company-discovery', 'goal-materialization']);
  });

  it('keeps execution backends separate from EVE identity', () => {
    expect(buildCommandEveAssistantContext('1.0.0-alpha.5')).toContain('Execution backends are tools, not identity');
  });

  it('codifies operator boundaries (invisible delivery, per-client isolation, secrets) in both languages', () => {
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('Unsichtbare Lieferung');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('Kunden-Isolation');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('sprichst du Deutsch und per Du');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('Passwoertern');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('Invisible delivery');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('per-client isolation');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('informal "Du"');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('raw tokens');
  });

  it('keeps the internal founder orchestration boundaries ONLY in the founder build', () => {
    // The founder build (COMMAND_EVE_FOUNDER_BUILD=1) keeps the Chief-of-Staff layer;
    // the shipped operator default never carries it. getCommandEveAssistantRule selects.
    expect(COMMAND_EVE_ASSISTANT_RULE_FOUNDER_DE).toContain('Du setzt keine Plane-Items auf Done');
    expect(COMMAND_EVE_ASSISTANT_RULE_FOUNDER_EN).toContain('You do not set Plane items to Done');
    // getCommandEveAssistantRule selects the right variant AND appends the standing
    // model-identity rule (the hard "never name a model" guarantee), so it CONTAINS
    // the selected base rather than equalling it.
    expect(getCommandEveAssistantRule('de-DE', false)).toContain(COMMAND_EVE_ASSISTANT_RULE_DE);
    expect(getCommandEveAssistantRule('de-DE', false)).not.toContain('Du setzt keine Plane-Items auf Done');
    expect(getCommandEveAssistantRule('de-DE', true)).toContain(COMMAND_EVE_ASSISTANT_RULE_FOUNDER_DE);
    expect(getCommandEveAssistantRule('en-US', true)).toContain(COMMAND_EVE_ASSISTANT_RULE_FOUNDER_EN);
    // The standing model-identity rule is appended to every variant.
    expect(getCommandEveAssistantRule('de-DE', false)).toContain('Modell-Identitaet');
    expect(getCommandEveAssistantRule('en-US', false)).toContain('Model identity');
    // The founder persona must contain Chief-of-Staff; the operator one must not.
    const founder = buildCommandEveAssistant('hermes', [], true);
    expect(founder.description).toContain('Chief-of-Staff');
  });

  it('GUARD: no internal Company.OS / founder vocabulary leaks into the operator-facing surfaces', () => {
    const operatorSurfaces = [
      COMMAND_EVE_ASSISTANT_RULE_DE,
      COMMAND_EVE_ASSISTANT_RULE_EN,
      COMMAND_EVE_ASSISTANT_SKILL_DE,
      COMMAND_EVE_ASSISTANT_SKILL_EN,
      buildCommandEveAssistant('hermes').description ?? '',
      buildCommandEveAssistant('hermes').description_i18n?.['en-US'] ?? '',
      (buildCommandEveAssistant('hermes').prompts ?? []).join(' '),
    ].join('\n');
    for (const token of ['Chief-of-Staff', 'Founder Intent', 'CEO Delegation', 'CEO-Delegation', 'Worker Contract', 'C-Level', 'C-level', 'Plane', 'Company.OS', 'Codex CLI', 'Claude Code CLI']) {
      expect(operatorSurfaces).not.toContain(token);
    }
    expect(operatorSurfaces).not.toMatch(/HG-[0-9]/);
  });

  it('teaches EVE to route secrets into a local .env instead of chat (proactive guardrail)', () => {
    // Founder 2026-06-26: EVE must KNOW secrets don't belong in chat and proactively
    // offer a local .env (like Claude Code reminds), not just decline to ask for them.
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toMatch(/\.env/);
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toMatch(/lokale[\s\S]{0,40}\.env/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toMatch(/rotier/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toMatch(/local[\s\S]{0,40}\.env/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toMatch(/rotat/i);
  });

  it('bootstraps EVE with the operator first-run skill + connector catalog', () => {
    // Operator skill: real product skills + honest connector status, no internal orchestration.
    expect(COMMAND_EVE_ASSISTANT_SKILL_DE).toContain('business-diagnostic');
    expect(COMMAND_EVE_ASSISTANT_SKILL_DE).toContain('blog-writer');
    expect(COMMAND_EVE_ASSISTANT_SKILL_EN).toContain('business-diagnostic');
    expect(COMMAND_EVE_ASSISTANT_SKILL_EN).toContain('connected only when a preflight/receipt proves it');
    // The internal Chief-of-Staff skill (content-machine / Codex CLI) lives only in the founder build.
    expect(COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_DE).toContain('Codex CLI');
    expect(COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_EN).toContain('Claude Code CLI');
    expect(buildCommandEveAssistantSkill('de-DE', undefined, false)).toBe(COMMAND_EVE_ASSISTANT_SKILL_DE);
    expect(buildCommandEveAssistantSkill('en-US', undefined, true)).toContain('Claude Code CLI');
  });

  it('renders local runtime, identity, skill and connector status into EVE first-run context', () => {
    const context = buildCommandEveAssistantFirstRunContext(
      {
        appVersion: '1.0.0-alpha.5',
        profile: {
          founder_name: 'Mathias Heinke',
          company_name: 'FYN Labs',
          source: 'macos_full_name',
          confidence: 'needs_confirmation',
          needs_confirmation: true,
        },
        receipt: {
          status: 'ready',
          provider: 'ollama',
          default_model: 'gemma4:12b',
          next_action: 'Runtime ready for EVE first session.',
          capabilities: { skills: 10, connectors: 11 },
          stages: [{ id: 'model', status: 'pass' }],
        },
        capabilityPack: {
          skills: [
            { id: 'first-run-company-discovery', default_state: 'active' },
            { id: 'content-machine', default_state: 'available' },
          ],
          connectors: [
            { id: 'local-command-eve-runtime', default_state: 'installed' },
            { id: 'codex-cli', default_state: 'unverified' },
            { id: 'github-gitnexus', default_state: 'needs_auth' },
            { id: 'marketing-publishing-stack', default_state: 'gated' },
          ],
        },
      },
      'de-DE'
    );

    expect(context).toContain('Runtime: ready');
    expect(context).toContain('Sprich Deutsch und per Du');
    expect(context).toContain('Founder-Seed: Mathias Heinke (vom User bestaetigen lassen)');
    expect(context).toContain('Aktive Skills: first-run-company-discovery');
    expect(context).toContain('Connector unverified: codex-cli');
    expect(context).toContain('Connector gated: marketing-publishing-stack');
  });

  it('appends first-run context to the persisted EVE skill', () => {
    const skill = buildCommandEveAssistantSkill('en-US', {
      appVersion: '1.0.0-alpha.5',
      receipt: {
        status: 'blocked',
        default_model: 'gemma4:12b',
        provider: 'ollama',
        stages: [{ id: 'model', status: 'blocked', code: 'MODEL_NOT_FETCHED' }],
      },
      capabilityPack: {
        skills: [{ id: 'security-fortress-review', default_state: 'gated' }],
        connectors: [{ id: 'github-gitnexus', default_state: 'needs_auth' }],
      },
    });

    expect(skill).toContain('# Command EVE First-Run Skill');
    expect(skill).toContain('Local First-Run Context');
    expect(skill).toContain('model:MODEL_NOT_FETCHED');
    expect(skill).toContain('Connectors needs_auth: github-gitnexus');
  });

  it('cloud Betriebsmodus is model-free; local Betriebsmodus NAMES the on-device model (EVE stops claiming Gemma on cloud)', () => {
    const context = buildCommandEveAssistantFirstRunContext(
      {
        appVersion: '1.2.9',
        receipt: { status: 'ready', provider: 'ollama', default_model: 'command-eve-gemma4-e4b-64k:latest' },
        inferenceSelection: 'command-eve-inference:eve-max',
      },
      'de-DE'
    );
    // The model-free Betriebsmodus line replaces the old "Modell: <gemma ref>" leak.
    expect(context).toContain('Betriebsmodus: EVE-Cloud');
    // The OLD inline "Runtime … Modell: <gemma>" leak is gone. The shim id may now
    // appear ONLY in the explicitly-fenced "Lokale Runtime (Fallback-Warmup …)"
    // line ("lokales Modell:"), never as the described ACTIVE lane.
    const laneLine = context.split('\n').find((l) => l.includes('Aktive Inferenz-Lane'));
    expect(laneLine).toBeDefined();
    expect(laneLine).not.toContain('command-eve-gemma4-e4b-64k');
    expect(laneLine?.toLowerCase()).not.toMatch(/gemma/);

    // Local selection → honest "lokal & privat" mode that NAMES the on-device model
    // (founder 2026-06-28: offline models are named; only cloud stays abstract).
    const local = buildCommandEveAssistantFirstRunContext(
      {
        appVersion: '1.2.9',
        receipt: { status: 'ready', provider: 'ollama', default_model: 'command-eve-gemma4-e4b-64k:latest' },
        inferenceSelection: 'command-eve-local:local-standard',
      },
      'de-DE'
    );
    expect(local).toMatch(/Betriebsmodus: lokal/i);
    expect(local).toMatch(/Gemma 4 E4B/);
  });

  // -------------------------------------------------------------------------
  // HONEST SELF-DESCRIPTION of the ACTIVE lane (Task #50 closeout for cloud
  // lanes — ported from the AionUi self-knowledge fix). The regression: on an
  // EVE cloud lane the system-prompt receipt line surfaced the local Ollama
  // warm-up (provider:ollama, default_model:<shim id>) so EVE answered "local
  // Gemma E4B via Ollama" while actually routing GLM via EVE Cloud Max. The
  // self-description must follow the ACTIVE lane (the picker selection the
  // router uses, read from the BACKEND store), never the shim model id.
  // -------------------------------------------------------------------------
  describe('honest active-lane self-description', () => {
    const SHIM = 'command-eve-gemma4-e4b-64k';

    const ollamaReceipt = {
      status: 'ready' as const,
      provider: 'ollama',
      // The bundled local warm-up shim model — this is what leaked before.
      default_model: 'command-eve-gemma4-e4b-64k:latest',
      next_action: 'Runtime ready for EVE first session.',
    };

    it('EVE Cloud Max selection → describes the active CLOUD tier, never the shim model (DE)', () => {
      const context = buildCommandEveAssistantFirstRunContext(
        {
          appVersion: '1.2.20',
          receipt: ollamaReceipt,
          inferenceSelection: 'command-eve-inference:eve-max',
        },
        'de-DE'
      );

      expect(context).toContain('Aktive Inferenz-Lane: EVE Cloud, Maximum-Stufe');
      expect(context).toContain('maximales Reasoning, höchste Qualität');
      expect(context).not.toContain(`Aktive Inferenz-Lane: ${SHIM}`);
      // The local warm-up line is explicitly framed as the fallback, not "the model".
      expect(context).toContain('Lokale Runtime (Fallback-Warmup, nur auf der lokalen Lane aktiv)');
      // The standing self-description rule is present.
      expect(context).toContain('Selbstbeschreibung:');
    });

    it('EVE Cloud Max selection → describes the active CLOUD tier (EN)', () => {
      const context = buildCommandEveAssistantFirstRunContext(
        {
          appVersion: '1.2.20',
          receipt: ollamaReceipt,
          inferenceSelection: 'command-eve-inference:eve-max',
        },
        'en-US'
      );

      expect(context).toContain('Active inference lane: EVE Cloud, Maximum tier');
      expect(context).toContain('maximum reasoning, top quality');
      expect(context).not.toContain(`Active inference lane: ${SHIM}`);
      expect(context).toContain('Self-description:');
    });

    it('LOCAL selection → honestly names the local model (DE)', () => {
      const context = buildCommandEveAssistantFirstRunContext(
        {
          appVersion: '1.2.20',
          receipt: ollamaReceipt,
          inferenceSelection: 'command-eve-local:local-standard',
        },
        'de-DE'
      );

      expect(context).toContain('Aktive Inferenz-Lane: Lokal · Gemma 4 E4B (privat, läuft auf deinem Mac)');
      // It does NOT claim EVE Cloud on the local lane.
      expect(context).not.toContain('Aktive Inferenz-Lane: EVE Cloud');
    });

    it('absent selection → defaults to the EVE cloud lane (the router default), not the local shim', () => {
      const context = buildCommandEveAssistantFirstRunContext(
        {
          appVersion: '1.2.20',
          receipt: ollamaReceipt,
          // No selection persisted yet — fresh user.
        },
        'en-US'
      );

      expect(context).toContain('Active inference lane: EVE Cloud, Standard tier');
      expect(context).not.toContain(`Active inference lane: ${SHIM}`);
    });

    it('the cloud-lane ACTIVE-lane line NEVER leaks the raw shim model id', () => {
      for (const locale of ['de-DE', 'en-US'] as const) {
        const context = buildCommandEveAssistantFirstRunContext(
          {
            appVersion: '1.2.20',
            receipt: ollamaReceipt,
            inferenceSelection: 'command-eve-inference:eve-max',
          },
          locale
        );
        // The shim id may appear ONLY in the explicitly-fenced local-fallback line,
        // never as the described active lane. Assert the active-lane line is clean.
        const laneLine = context
          .split('\n')
          .find((l) => l.includes('Aktive Inferenz-Lane') || l.includes('Active inference lane'));
        expect(laneLine).toBeDefined();
        expect(laneLine).not.toContain(SHIM);
        expect(laneLine?.toLowerCase()).not.toContain('ollama');
      }
    });
  });
});
