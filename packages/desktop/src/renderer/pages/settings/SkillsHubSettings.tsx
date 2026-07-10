import { ipcBridge } from '@/common';
import { Button, Message, Modal, Spin, Tag, Typography } from '@arco-design/web-react';
import { Delete, FolderOpen, Info, Lightning, Puzzle, Search, Refresh } from '@icon-park/react';
import { bridge } from '@office-ai/platform';
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import MarkdownView from '@renderer/components/Markdown';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';

// ─────────────────────────────────────────────────────────────────────────────
// 1.2.18 STEP 4 — Unified skill surface.
//
// Settings→Fähigkeiten is now the SINGLE place that shows every skill the
// standalone Skill Library page shows (the ~18 reconciliation cards WITH a
// `state` from `command-eve.skill-library`), PLUS custom imports + builtin/
// extension entries from `/api/skills`, PLUS EVE-learned skills (from
// `command-eve.learned-skills`). Each row carries a colored state badge, a source
// label, and click-to-read of its SKILL.md (read-only) via
// `command-eve.skill-content` with a fallback to the existing builtin-skill
// endpoint. Custom + learned rows stay importable / deletable.
// ─────────────────────────────────────────────────────────────────────────────

type SkillState = 'executable' | 'prompt_label' | 'gated' | 'disabled';

type SkillSource = 'builtin' | 'custom' | 'extension' | 'learned' | 'library';

// Skill 信息类型 / Skill info type
interface SkillInfo {
  name: string;
  description: string;
  location: string;
  /**
   * Relative location under the builtin-skills corpus (e.g.
   * `auto-inject/cron/SKILL.md`). Present only for `source=builtin`; the
   * export-to-external-source flow still uses absolute `location` paths.
   */
  relative_location?: string;
  is_custom: boolean;
  source?: SkillSource;
}

// ── Skill Library bridge (reconciliation cards w/ state) — same provider the
// standalone pages/skillLibrary/index.tsx page uses. ─────────────────────────
type BridgeResponse<D = unknown> = {
  success: boolean;
  msg?: string;
  data?: D;
};

type SkillLibraryCard = {
  id: string;
  name: string;
  source: string;
  state: SkillState;
  executable: boolean;
};

type SkillLibraryModel = {
  schema_version: 'command-eve-skill-library/v0';
  generated_at: string;
  read_only: true;
  source: {
    runtime_reconciliation_path: string;
    capability_pack_path?: string;
    managed_skill_dir?: string;
  };
  summary: Record<SkillState, number>;
  skills: SkillLibraryCard[];
  connector_ids: string[];
  blocked_external_mcp_transports: string[];
  kanban: {
    dispatch_in_gateway: false;
    auto_decompose: false;
  };
  warnings: string[];
};

type SkillLibraryResult = {
  version: 'command-eve-skill-library/v0';
  status: 'ready' | 'blocked' | 'failed';
  ok: boolean;
  reason_code?: string;
  message?: string;
  model?: SkillLibraryModel;
  source: {
    runtime_reconciliation_path?: string;
    capability_pack_path?: string;
    generated_by: 'command-eve-skill-library-core';
  };
};

const skillLibraryBridge = bridge.buildProvider<
  BridgeResponse<SkillLibraryResult>,
  { runtimeReconciliationPath?: string; capabilityPackPath?: string } | undefined
>('command-eve.skill-library');

// ── EVE-learned skills bridge ({cronSkillsDir}/{job_id}/SKILL.md) ────────────
type LearnedSkillCard = {
  job_id: string;
  name: string;
  description: string;
  path: string;
  source: 'learned';
};

const learnedSkillsBridge = bridge.buildProvider<
  { success: boolean; msg?: string; data: { ok: boolean; skills: LearnedSkillCard[] } },
  undefined
>('command-eve.learned-skills');

// ── Read-only SKILL.md body bridge (click-to-read) ───────────────────────────
type SkillContentResult = {
  ok: boolean;
  read_only: true;
  markdown?: string;
  path?: string;
  reason_code?: 'INVALID_INPUT' | 'PATH_DENIED' | 'NOT_FOUND' | 'READ_FAILED';
};

const skillContentBridge = bridge.buildProvider<
  { success: boolean; msg?: string; data: SkillContentResult },
  { skill_id?: string; skill_path?: string }
>('command-eve.skill-content');

// ── Merged row shape: one normalized entry per unique skill. ─────────────────
interface MergedSkillRow {
  /** Normalized dedupe key (lowercased id/name). */
  key: string;
  /** Display name. */
  name: string;
  /** Display description. */
  description: string;
  /** Reconciliation state (when a library card matched), else undefined. */
  state?: SkillState;
  /** Whether the skill is executable (from the library card; defaults false). */
  executable: boolean;
  /** Where this row came from (drives badge + delete affordance). */
  source: SkillSource;
  /** On-disk SKILL.md path when known (custom/learned) — used for click-to-read. */
  path?: string;
}

// Normalize a skill id/name into a stable dedupe key.
const normalizeKey = (value: string): string => (value || '').trim().toLowerCase();

// Curation of aioncore's OWN backend builtin skills (1.2.18, founder mandate): the
// upstream AionUi runtime ships skills that do NOT serve the Command EVE product
// (e.g. an AI-agent social network, WeChat file-send, Chinese-language recruiter
// flows, the raw AionUi self-config). Those are NOISE in the operator's curated
// "Fähigkeiten" surface and are HIDDEN. The few we genuinely use are KEPT and
// RENAMED to fit Command EVE (German, operator-facing). This applies ONLY to rows
// whose source is a pure backend `builtin` (NOT our reconciliation `library`
// cards, custom imports, EVE-learned, or user extensions — those always show).
//
// Policy: a `builtin` row is shown ONLY if its key is in this keep-map, and then
// under the mapped display name. Everything else `builtin` is dropped. Founder can
// extend this map as new aioncore builtins surface.
const AIONCORE_BUILTIN_KEEP: Record<string, string> = {
  // Scheduling is genuinely useful to the operator's agent — keep, German name.
  cron: 'Geplante Aufgaben',
  // Image generation is a content-creation capability we use.
  'image-gen': 'Bildgenerierung',
  'builtin-image-gen': 'Bildgenerierung',
};

// Normalize skill name for data-testid usage
const normalizeTestId = (name: string): string => {
  return name.replace(/[:/\s<>"'|?*]/g, '-');
};

const getAvatarColorClass = (name: string) => {
  if (!name) return 'bg-[#165DFF] text-white';
  const colors = [
    'bg-[#165DFF] text-white', // Blue
    'bg-[#00B42A] text-white', // Green
    'bg-[#722ED1] text-white', // Purple
    'bg-[#F5319D] text-white', // Pink
    'bg-[#F77234] text-white', // Orange
    'bg-[#14C9C9] text-white', // Cyan
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

// State badge color — maps to Arco Tag colors.
const stateTagColor = (state: SkillState): 'green' | 'purple' | 'orange' | 'gray' => {
  if (state === 'executable') return 'green';
  if (state === 'prompt_label') return 'purple';
  if (state === 'gated') return 'orange';
  return 'gray';
};

interface SkillsHubSettingsProps {
  /** When false, renders without SettingsPageWrapper — useful for embedding in a tab */
  withWrapper?: boolean;
}

type CommandEveCapability = {
  id: string;
  name?: string;
  tier?: string;
  default_state?: string;
};

type CommandEveCapabilityPack = {
  skills?: CommandEveCapability[];
  connectors?: CommandEveCapability[];
};

type FilterChip = 'all' | SkillState;

const SkillsHubSettings: React.FC<SkillsHubSettingsProps> = ({ withWrapper = true }) => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightName = searchParams.get('highlight');
  const [highlightedSkill, setHighlightedSkill] = useState<string | null>(null);
  const skillRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [loading, setLoading] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [libraryModel, setLibraryModel] = useState<SkillLibraryModel | null>(null);
  const [learnedSkills, setLearnedSkills] = useState<LearnedSkillCard[]>([]);
  const [skillPaths, setSkillPaths] = useState<{ user_skills_dir: string; builtin_skills_dir: string } | null>(null);
  const [search_query, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterChip>('all');
  const [builtinAutoSkills, setBuiltinAutoSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [commandEveCapabilityPack, setCommandEveCapabilityPack] = useState<CommandEveCapabilityPack | null>(null);

  // ── Click-to-read modal state ──────────────────────────────────────────────
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerTitle, setReaderTitle] = useState('');
  const [readerMarkdown, setReaderMarkdown] = useState('');
  const [readerError, setReaderError] = useState<string | null>(null);

  // The auto-injected builtins remain a separate informational section (they are
  // not part of the reconciliation surface and have no on-disk SKILL.md path).
  const visibleBuiltinAutoSkills = COMMAND_EVE_SHELL_ENABLED ? [] : builtinAutoSkills;

  // ── Merge: library cards + /api/skills + learned, keyed by normalized id. ──
  // Prefer the library card's `state`/`executable`; carry an on-disk path from
  // custom/learned rows for click-to-read.
  const mergedSkills = useMemo<MergedSkillRow[]>(() => {
    const byKey = new Map<string, MergedSkillRow>();

    // 1) Reconciliation cards (the ~18 with state) — the primary list.
    // Give each an EXACT on-disk path from the managed skills dir + the card's ID
    // (the dir name is the kebab-case ID, NOT the display name), so click-to-read
    // resolves the right SKILL.md. A backend-only builtin whose id has no file
    // under managed_skill_dir simply yields NOT_FOUND → the readBuiltinSkill
    // fallback in openReader handles it. Without this, openReader fell back to
    // skill_id=display-name ("Content Machine") which never matches the dir.
    const managedSkillDir = libraryModel?.source?.managed_skill_dir;
    for (const card of libraryModel?.skills ?? []) {
      const key = normalizeKey(card.id || card.name);
      if (!key) continue;
      byKey.set(key, {
        key,
        name: card.name || card.id,
        description: '',
        state: card.state,
        executable: !!card.executable,
        source: 'library',
        ...(managedSkillDir && card.id ? { path: `${managedSkillDir}/${card.id}/SKILL.md` } : {}),
      });
    }

    // 2) /api/skills (builtin / custom / extension). When a library card already
    // covers this skill, only enrich it (description, source override for
    // custom/extension, on-disk path); otherwise add a fresh row.
    for (const s of availableSkills) {
      const key = normalizeKey(s.name);
      if (!key) continue;
      const existing = byKey.get(key);
      const apiSource: SkillSource = s.source ?? (s.is_custom ? 'custom' : 'builtin');
      if (existing) {
        if (!existing.description && s.description) existing.description = s.description;
        // A custom/extension import is a stronger source signal than a generic
        // library 'builtin' card — it gates the delete affordance + path read.
        if (apiSource === 'custom' || apiSource === 'extension') existing.source = apiSource;
        if (!existing.path && s.location) existing.path = s.location;
      } else {
        byKey.set(key, {
          key,
          name: s.name,
          description: s.description || '',
          executable: false,
          source: apiSource,
          path: s.location || undefined,
        });
      }
    }

    // 3) EVE-learned skills — always show, with their on-disk path.
    for (const card of learnedSkills) {
      const key = normalizeKey(card.name || card.job_id);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.source = 'learned';
        if (!existing.description && card.description) existing.description = card.description;
        if (!existing.path && card.path) existing.path = card.path;
      } else {
        byKey.set(key, {
          key,
          name: card.name || card.job_id,
          description: card.description || '',
          executable: false,
          source: 'learned',
          path: card.path,
        });
      }
    }

    // Curate aioncore's own backend builtins: hide the ones that don't serve
    // Command EVE, rename the few we keep. Our curated `library` cards + custom +
    // learned + extensions always pass through untouched.
    return Array.from(byKey.values())
      .filter((row) => row.source !== 'builtin' || row.key in AIONCORE_BUILTIN_KEEP)
      .map((row) =>
        row.source === 'builtin' && AIONCORE_BUILTIN_KEEP[row.key]
          ? { ...row, name: AIONCORE_BUILTIN_KEEP[row.key] }
          : row
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [libraryModel, availableSkills, learnedSkills]);

  // Filter-chip counts: prefer the reconciliation summary; fall back to deriving
  // from the merged rows so the chips stay honest even if the library bridge is
  // unavailable.
  const summaryCounts = useMemo<Record<SkillState, number>>(() => {
    if (libraryModel?.summary) return libraryModel.summary;
    const counts: Record<SkillState, number> = { executable: 0, prompt_label: 0, gated: 0, disabled: 0 };
    for (const row of mergedSkills) {
      if (row.state) counts[row.state] += 1;
    }
    return counts;
  }, [libraryModel, mergedSkills]);

  const filteredSkills = useMemo(() => {
    let rows = mergedSkills;
    if (activeFilter !== 'all') {
      rows = rows.filter((s) => s.state === activeFilter);
    }
    const q = search_query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q))
      );
    }
    return rows;
  }, [mergedSkills, activeFilter, search_query]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const skills = await ipcBridge.fs.listAvailableSkills.invoke();
      setAvailableSkills(skills as SkillInfo[]);

      const paths = await ipcBridge.fs.getSkillPaths.invoke();
      setSkillPaths(paths);

      // Builtin-auto skills are HIDDEN under the Command EVE shell
      // (visibleBuiltinAutoSkills returns [] when COMMAND_EVE_SHELL_ENABLED). The
      // shipped aioncore backend 405s on GET /api/skills/builtin-auto, so calling it
      // in the OUTER try would THROW and abort the entire skill load — which is why
      // the unified surface used to collapse to custom-only (~5) instead of the full
      // reconciled set (~18). Skip it under the shell; keep it non-fatal otherwise.
      if (!COMMAND_EVE_SHELL_ENABLED) {
        try {
          const autoSkills = await ipcBridge.fs.listBuiltinAutoSkills.invoke();
          setBuiltinAutoSkills(autoSkills);
        } catch (autoError) {
          console.warn('Failed to load builtin-auto skills (non-fatal):', autoError);
          setBuiltinAutoSkills([]);
        }
      }

      // Reconciliation cards (the ~18 with state) — same provider the standalone
      // Skill Library page uses. Non-fatal on failure.
      try {
        const libResponse = await skillLibraryBridge.invoke(undefined);
        setLibraryModel(libResponse?.data?.model ?? null);
      } catch (libError) {
        console.warn('Failed to load skill library reconciliation:', libError);
        setLibraryModel(null);
      }

      // EVE-learned skills. Non-fatal on failure.
      try {
        const learnedResponse = await learnedSkillsBridge.invoke();
        setLearnedSkills(learnedResponse?.data?.ok ? learnedResponse.data.skills : []);
      } catch (learnedError) {
        console.warn('Failed to load EVE-learned skills:', learnedError);
        setLearnedSkills([]);
      }

      if (COMMAND_EVE_SHELL_ENABLED) {
        try {
          const response = await fetch('command-eve-capabilities.json', { cache: 'no-store' });
          if (response.ok) {
            setCommandEveCapabilityPack((await response.json()) as CommandEveCapabilityPack);
          }
        } catch (capabilityError) {
          console.warn('Failed to load Command EVE capability pack:', capabilityError);
        }
      }
    } catch (error) {
      console.error('Failed to fetch skills:', error);
      Message.error(t('settings.skillsHub.fetchError', { defaultValue: 'Failed to fetch skills' }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Scroll to and highlight a skill when navigated with ?highlight=skillName
  useEffect(() => {
    if (!highlightName || loading) return;
    const el = skillRefs.current[highlightName];
    if (el) {
      // Small delay to ensure layout is settled
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedSkill(highlightName);
        // Clear highlight after animation
        const timer = setTimeout(() => setHighlightedSkill(null), 2000);
        // Clean up the search param so refreshing won't re-highlight
        setSearchParams({}, { replace: true });
        return () => clearTimeout(timer);
      });
    }
  }, [highlightName, loading, mergedSkills, setSearchParams]);

  // ── Click-to-read: open the SKILL.md in a read-only modal. ─────────────────
  const openReader = useCallback(
    async (row: MergedSkillRow) => {
      setReaderOpen(true);
      setReaderLoading(true);
      setReaderError(null);
      setReaderMarkdown('');
      setReaderTitle(row.name);
      try {
        // Prefer the on-disk reader (custom / learned / managed strategy).
        const response = await skillContentBridge.invoke(row.path ? { skill_path: row.path } : { skill_id: row.name });
        const data = response?.data;
        if (data?.ok && typeof data.markdown === 'string' && data.markdown.trim().length > 0) {
          setReaderMarkdown(data.markdown);
          return;
        }
        // Fallback for pure backend builtins not present on a managed root:
        // the existing /api/skills/builtin-skill endpoint returns the markdown
        // string. Resolve a file_name from the relative_location/location when we
        // have one (it ends in .../SKILL.md), else from "<name>/SKILL.md".
        if (data?.reason_code === 'NOT_FOUND' || data?.reason_code === 'PATH_DENIED' || !data?.ok) {
          const source = availableSkills.find((s) => normalizeKey(s.name) === row.key);
          const fileName = source?.relative_location || `${row.name}/SKILL.md`;
          try {
            const markdown = await ipcBridge.fs.readBuiltinSkill.invoke({ file_name: fileName });
            if (typeof markdown === 'string' && markdown.trim().length > 0) {
              setReaderMarkdown(markdown);
              return;
            }
          } catch (builtinError) {
            console.warn('readBuiltinSkill fallback failed:', builtinError);
          }
          setReaderError(
            t('settings.skillsHub.readNotFound', {
              defaultValue: 'Could not read this skill (no readable SKILL.md found).',
            })
          );
          return;
        }
        setReaderError(t('settings.skillsHub.readError', { defaultValue: 'Could not read this skill.' }));
      } catch (error) {
        console.error('Failed to read SKILL.md:', error);
        setReaderError(t('settings.skillsHub.readError', { defaultValue: 'Could not read this skill.' }));
      } finally {
        setReaderLoading(false);
      }
    },
    [availableSkills, t]
  );

  const handleImport = async (skillPath: string) => {
    try {
      const result = await ipcBridge.fs.importSkillWithSymlink.invoke({ skill_path: skillPath });
      const importedNames = result.skill_names?.length
        ? result.skill_names
        : result.skill_name
          ? [result.skill_name]
          : [];
      const count = importedNames.length;
      const names = importedNames.join(', ');
      Message.success(
        t('settings.skillsHub.importSuccessDetailed', {
          count,
          names,
          defaultValue: count > 1 ? `Imported ${count} skills: ${names}` : `Imported skill: ${names}`,
        })
      );
      setSearchQuery('');
      void fetchData();
    } catch (error) {
      console.error('Failed to import skill:', error);
      Message.error(t('settings.skillsHub.importError', { defaultValue: 'Error importing skill' }));
    }
  };

  const handleDelete = async (skillName: string) => {
    try {
      await ipcBridge.fs.deleteSkill.invoke({ skill_name: skillName });
      Message.success(t('settings.skillsHub.deleteSuccess', { defaultValue: 'Skill deleted' }));
      void fetchData();
    } catch (error) {
      console.error('Failed to delete skill:', error);
      Message.error(t('settings.skillsHub.deleteError', { defaultValue: 'Error deleting skill' }));
    }
  };

  const handleManualImport = async () => {
    try {
      const result = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'Skill folders or zip archives', extensions: ['zip'] }],
      });
      if (result && result.length > 0) {
        await handleImport(result[0]);
      }
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
    }
  };

  // ── Source badge per row. ──────────────────────────────────────────────────
  const renderSourceBadge = (source: SkillSource) => {
    if (source === 'learned') {
      return (
        <span className='bg-[rgba(var(--purple-6),0.08)] text-purple-6 border border-[rgba(var(--purple-6),0.2)] text-11px px-6px py-1px rd-4px font-medium'>
          {t('settings.skillsHub.learnedBadge', { defaultValue: 'Von EVE gelernt' })}
        </span>
      );
    }
    if (source === 'custom') {
      return (
        <span className='bg-[rgba(var(--orange-6),0.08)] text-orange-6 border border-[rgba(var(--orange-6),0.2)] text-11px px-6px py-1px rd-4px font-medium'>
          {t('settings.skillsHub.custom', { defaultValue: 'Custom' })}
        </span>
      );
    }
    if (source === 'extension') {
      return (
        <span className='bg-[rgba(var(--primary-6),0.08)] text-primary-6 border border-[rgba(var(--primary-6),0.2)] text-11px px-6px py-1px rd-4px font-medium'>
          {t('settings.extensionSkillsBadge', { defaultValue: 'Extension' })}
        </span>
      );
    }
    return (
      <span className='bg-[rgba(var(--blue-6),0.08)] text-blue-6 border border-[rgba(var(--blue-6),0.2)] text-11px px-6px py-1px rd-4px font-medium'>
        {t('settings.skillsHub.builtin', { defaultValue: 'Built-in' })}
      </span>
    );
  };

  const filterChips: Array<{ id: FilterChip; label: string; count?: number }> = [
    { id: 'all', label: t('settings.skillState.all', { defaultValue: 'Alle' }), count: mergedSkills.length },
    {
      id: 'executable',
      label: t('settings.skillState.executable', { defaultValue: 'Ausführbar' }),
      count: summaryCounts.executable,
    },
    {
      id: 'prompt_label',
      label: t('settings.skillState.promptLabel', { defaultValue: 'Prompt-Label' }),
      count: summaryCounts.prompt_label,
    },
    {
      id: 'gated',
      label: t('settings.skillState.gated', { defaultValue: 'Gated' }),
      count: summaryCounts.gated,
    },
    {
      id: 'disabled',
      label: t('settings.skillState.disabled', { defaultValue: 'Deaktiviert' }),
      count: summaryCounts.disabled,
    },
  ];

  const mainContent = (
    <div className='flex flex-col h-full w-full'>
      <div className='space-y-16px pb-24px'>
        {COMMAND_EVE_SHELL_ENABLED && commandEveCapabilityPack && (
          <div
            data-testid='command-eve-capability-section'
            className='px-[16px] md:px-[32px] py-32px bg-base rd-16px md:rd-24px shadow-sm border border-b-base relative overflow-hidden transition-all'
          >
            <div className='flex flex-col gap-6px mb-20px'>
              <span className='text-16px md:text-18px text-t-primary font-bold tracking-tight'>
                {t('settings.skillsHub.commandEveCapabilitiesTitle')}
              </span>
              <span className='text-13px text-t-secondary leading-relaxed'>
                {t('settings.skillsHub.commandEveCapabilitiesDesc')}
              </span>
            </div>

            <div className='grid grid-cols-1 lg:grid-cols-2 gap-10px'>
              {(commandEveCapabilityPack.skills || []).map((skill) => (
                <div
                  key={skill.id}
                  className='rd-12px bg-fill-1 border border-solid border-border-1 p-14px flex flex-col gap-6px'
                >
                  <div className='flex items-center justify-between gap-8px'>
                    <span className='text-14px font-semibold text-t-primary truncate'>{skill.name || skill.id}</span>
                    <span className='text-10px uppercase text-primary-6 bg-[rgba(var(--primary-6),0.08)] px-8px py-2px rd-999px'>
                      {skill.default_state || t('settings.skillsHub.commandEveCapabilityAvailable')}
                    </span>
                  </div>
                  <span className='text-12px text-t-secondary'>
                    {skill.tier || t('settings.skillsHub.commandEveCapabilityTier')}
                  </span>
                </div>
              ))}
            </div>

            <div className='mt-18px pt-18px border-t border-solid border-border-1'>
              <div className='text-13px font-semibold text-t-primary mb-10px'>
                {t('settings.skillsHub.commandEveConnectorsTitle')}
              </div>
              <div className='flex flex-wrap gap-8px'>
                {(commandEveCapabilityPack.connectors || []).map((connector) => (
                  <span
                    key={connector.id}
                    className='text-12px text-t-secondary bg-fill-1 border border-solid border-border-1 px-10px py-5px rd-999px'
                  >
                    {connector.name || connector.id}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ======== Unified skill list ======== */}
        <div
          data-testid='my-skills-section'
          className='px-[16px] md:px-[32px] py-32px bg-base rd-16px md:rd-24px shadow-sm border border-b-base relative overflow-hidden transition-all'
        >
          {/* Toolbar */}
          <div className='flex flex-col lg:flex-row lg:items-center justify-between gap-16px mb-16px relative z-10'>
            <div className='flex items-center gap-10px shrink-0'>
              <span className='text-16px md:text-18px text-t-primary font-bold tracking-tight'>
                {t('settings.skillsHub.allSkillsTitle', { defaultValue: 'Fähigkeiten' })}
              </span>
              <span className='bg-[rgba(var(--primary-6),0.08)] text-primary-6 text-12px px-10px py-2px rd-[100px] font-medium ml-4px'>
                {mergedSkills.length}
              </span>
              <button
                data-testid='btn-refresh-my-skills'
                className='outline-none border-none bg-transparent cursor-pointer p-6px text-t-tertiary hover:text-primary-6 transition-colors rd-full hover:bg-fill-2 ml-4px'
                onClick={async () => {
                  await fetchData();
                  Message.success(t('common.refreshSuccess', { defaultValue: 'Refreshed' }));
                }}
                title={t('common.refresh', { defaultValue: 'Refresh' })}
              >
                <Refresh theme='outline' size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className='flex flex-col sm:flex-row items-stretch sm:items-center gap-12px w-full lg:w-auto shrink-0'>
              <div className='relative group shrink-0 w-full sm:w-[200px] lg:w-[240px]'>
                <div className='absolute left-12px top-1/2 -translate-y-1/2 text-t-tertiary group-focus-within:text-primary-6 flex pointer-events-none transition-colors'>
                  <Search size={15} />
                </div>
                <input
                  data-testid='input-search-my-skills'
                  type='text'
                  className='w-full bg-fill-1 hover:bg-fill-2 border border-border-1 focus:border-primary-5 focus:bg-base outline-none rd-8px py-6px pl-36px pr-12px text-13px text-t-primary placeholder:text-t-tertiary transition-all shadow-sm box-border m-0'
                  placeholder={t('settings.skillsHub.searchPlaceholder', { defaultValue: 'Search skills...' })}
                  value={search_query}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              <button
                data-testid='btn-manual-import'
                className='flex items-center justify-center gap-6px px-16px py-6px bg-base border border-border-1 hover:border-border-2 hover:bg-fill-1 text-t-primary rd-8px shadow-sm transition-all focus:outline-none shrink-0 cursor-pointer whitespace-nowrap'
                onClick={handleManualImport}
              >
                <FolderOpen size={15} className='text-t-secondary' />
                <span className='text-13px font-medium'>
                  {t('settings.skillsHub.manualImport', { defaultValue: 'Import Skills' })}
                </span>
              </button>
            </div>
          </div>

          {/* Filter chips (driven by the reconciliation summary) */}
          <div className='flex flex-wrap items-center gap-8px mb-16px relative z-10' data-testid='skill-filter-chips'>
            {filterChips.map((chip) => (
              <button
                key={chip.id}
                data-testid={`skill-filter-${chip.id}`}
                onClick={() => setActiveFilter(chip.id)}
                className={`text-12px px-12px py-4px rd-999px border cursor-pointer transition-all ${
                  activeFilter === chip.id
                    ? 'bg-primary-6 text-white border-primary-6'
                    : 'bg-fill-1 text-t-secondary border-border-1 hover:border-border-2 hover:bg-fill-2'
                }`}
              >
                {chip.label}
                {typeof chip.count === 'number' ? ` (${chip.count})` : ''}
              </button>
            ))}
          </div>

          {/* Path Display */}
          {skillPaths && (
            <div className='flex items-center gap-8px text-12px text-t-tertiary font-mono bg-transparent py-4px mb-16px relative z-10 pt-4px border-t border-t-transparent'>
              <FolderOpen size={16} className='shrink-0' />
              <span className='truncate' title={COMMAND_EVE_SHELL_ENABLED ? undefined : skillPaths.user_skills_dir}>
                {COMMAND_EVE_SHELL_ENABLED
                  ? t('settings.commandEveSkillStorage', { defaultValue: 'Lokal auf diesem Mac gespeichert' })
                  : skillPaths.user_skills_dir}
              </span>
            </div>
          )}

          {mergedSkills.length > 0 ? (
            <div className='w-full flex flex-col gap-6px relative z-10'>
              {filteredSkills.map((skill) => {
                const deletable = skill.source === 'custom' || skill.source === 'learned';
                return (
                  <div
                    key={skill.key}
                    data-testid={`my-skill-card-${normalizeTestId(skill.name)}`}
                    ref={(el) => {
                      skillRefs.current[skill.name] = el;
                    }}
                    role='button'
                    tabIndex={0}
                    onClick={() => void openReader(skill)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void openReader(skill);
                      }
                    }}
                    className={`group flex flex-col sm:flex-row gap-16px p-16px bg-base border hover:border-border-1 hover:bg-fill-1 hover:shadow-sm rd-12px transition-all duration-200 cursor-pointer ${highlightedSkill === skill.name ? 'border-primary-5 bg-primary-1' : 'border-transparent'}`}
                  >
                    <div className='shrink-0 flex items-start sm:mt-2px'>
                      <div
                        className={`w-40px h-40px rd-10px flex items-center justify-center font-bold text-16px shadow-sm text-transform-uppercase ${getAvatarColorClass(skill.name)}`}
                      >
                        {skill.name.charAt(0).toUpperCase()}
                      </div>
                    </div>

                    <div className='flex-1 min-w-0 flex flex-col justify-center gap-6px'>
                      <div className='flex items-center gap-10px flex-wrap'>
                        <h3 className='text-14px font-semibold text-t-primary/90 truncate m-0'>{skill.name}</h3>
                        {skill.state && (
                          <Tag color={stateTagColor(skill.state)} size='small'>
                            {t(`settings.skillState.${skill.state === 'prompt_label' ? 'promptLabel' : skill.state}`, {
                              defaultValue:
                                skill.state === 'executable'
                                  ? 'Ausführbar'
                                  : skill.state === 'prompt_label'
                                    ? 'Prompt-Label'
                                    : skill.state === 'gated'
                                      ? 'Gated'
                                      : 'Deaktiviert',
                            })}
                          </Tag>
                        )}
                        {renderSourceBadge(skill.source)}
                      </div>
                      {skill.description && (
                        <p
                          className='text-13px text-t-secondary leading-relaxed line-clamp-2 m-0'
                          title={skill.description}
                        >
                          {skill.description}
                        </p>
                      )}
                    </div>

                    <div className='shrink-0 sm:self-center flex items-center justify-end gap-6px mt-12px sm:mt-0 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity pl-4px'>
                      {deletable && (
                        <button
                          data-testid={`btn-delete-${normalizeTestId(skill.name)}`}
                          className='p-8px hover:bg-danger-1 hover:text-danger-6 text-t-tertiary rd-6px outline-none flex items-center justify-center border border-transparent cursor-pointer transition-colors shadow-sm bg-base sm:bg-transparent sm:shadow-none'
                          onClick={(e) => {
                            e.stopPropagation();
                            Modal.confirm({
                              title: t('settings.skillsHub.deleteConfirmTitle', { defaultValue: 'Delete Skill' }),
                              content: t('settings.skillsHub.deleteConfirmContent', {
                                name: skill.name,
                                defaultValue: `Are you sure you want to delete "${skill.name}"?`,
                              }),
                              okButtonProps: { status: 'danger' },
                              okText: t('common.delete', { defaultValue: 'Delete' }),
                              onOk: () => void handleDelete(skill.name),
                              wrapClassName: 'modal-delete-skill',
                            });
                          }}
                          title={t('common.delete', { defaultValue: 'Delete' })}
                        >
                          <Delete size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredSkills.length === 0 && (
                <div className='text-center text-t-secondary text-13px py-24px bg-fill-1 rd-12px border border-b-base border-dashed'>
                  {t('settings.skillsHub.noSkillsForFilter', {
                    defaultValue: 'No skills match this filter.',
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className='text-center text-t-secondary text-13px py-40px bg-fill-1 rd-12px border border-b-base border-dashed relative z-10'>
              {loading
                ? t('common.loading', { defaultValue: 'Please wait...' })
                : t('settings.skillsHub.noSkills', {
                    defaultValue: 'No skills found. Import some to get started.',
                  })}
            </div>
          )}
        </div>

        {/* ======== Builtin Auto-injected Skills (informational) ======== */}
        {visibleBuiltinAutoSkills.length > 0 && (
          <div
            data-testid='auto-skills-section'
            className='px-[16px] md:px-[32px] py-32px bg-base rd-16px md:rd-24px shadow-sm border border-b-base relative overflow-hidden transition-all'
          >
            <div className='flex items-center gap-10px mb-24px'>
              <Lightning theme='filled' size={20} fill='var(--color-primary-6)' />
              <span className='text-16px md:text-18px text-t-primary font-bold tracking-tight'>
                {t('settings.autoInjectedSkills')}
              </span>
              <span className='bg-[rgba(var(--success-6),0.08)] text-[rgb(var(--success-6))] text-12px px-10px py-2px rd-[100px] font-medium ml-4px'>
                {visibleBuiltinAutoSkills.length}
              </span>
            </div>
            <div className='w-full flex flex-col gap-6px'>
              {visibleBuiltinAutoSkills.map((skill) => (
                <div
                  key={skill.name}
                  ref={(el) => {
                    skillRefs.current[skill.name] = el;
                  }}
                  className={`flex flex-col sm:flex-row gap-16px p-16px bg-base border hover:border-border-1 hover:bg-fill-1 rd-12px transition-all duration-200 ${highlightedSkill === skill.name ? 'border-primary-5 bg-primary-1' : 'border-transparent'}`}
                >
                  <div className='shrink-0 flex items-start sm:mt-2px'>
                    <div className='w-40px h-40px rd-10px bg-[rgba(var(--success-6),0.08)] flex items-center justify-center shadow-sm'>
                      <Lightning theme='filled' size={20} fill='rgb(var(--success-6))' />
                    </div>
                  </div>
                  <div className='flex-1 min-w-0 flex flex-col justify-center gap-4px'>
                    <div className='flex items-center gap-10px'>
                      <h3 className='text-14px font-semibold text-t-primary/90 truncate m-0'>{skill.name}</h3>
                      <span className='bg-[rgba(var(--success-6),0.08)] text-[rgb(var(--success-6))] border border-[rgba(var(--success-6),0.2)] text-10px px-6px py-1px rd-4px font-medium uppercase'>
                        {t('settings.autoInjectedSkillsBadge')}
                      </span>
                    </div>
                    {skill.description && (
                      <p className='text-13px text-t-secondary leading-relaxed line-clamp-2 m-0'>{skill.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ======== Usage Tip ======== */}
        <div className='px-16px md:px-[24px] py-20px bg-base border border-b-base shadow-sm rd-16px flex items-start gap-12px text-t-secondary'>
          <Info size={18} className='text-primary-6 mt-2px shrink-0' />
          <div className='flex flex-col gap-4px'>
            <span className='font-bold text-t-primary text-14px'>
              {t('settings.skillsHub.tipTitle', { defaultValue: 'Usage Tip:' })}
            </span>
            <span className='text-13px leading-relaxed'>{t('settings.skillsHub.tipContent')}</span>
          </div>
        </div>
      </div>

      {/* ======== Click-to-read SKILL.md modal (read-only) ======== */}
      <Modal
        title={
          <div className='flex items-center gap-8px'>
            <Puzzle theme='filled' size={18} fill='rgb(var(--primary-6))' />
            <span>{readerTitle || t('settings.skillsHub.readTitle', { defaultValue: 'SKILL.md' })}</span>
            <Tag color='gray' size='small'>
              {t('settings.skillsHub.readOnly', { defaultValue: 'Read-only' })}
            </Tag>
          </div>
        }
        visible={readerOpen}
        onCancel={() => setReaderOpen(false)}
        footer={<Button onClick={() => setReaderOpen(false)}>{t('common.close', { defaultValue: 'Close' })}</Button>}
        style={{ width: 'min(820px, 92vw)' }}
        unmountOnExit
      >
        <div className='max-h-[60vh] overflow-y-auto'>
          {readerLoading ? (
            <div className='flex items-center justify-center py-40px'>
              <Spin />
            </div>
          ) : readerError ? (
            <Typography.Text type='secondary'>{readerError}</Typography.Text>
          ) : (
            <MarkdownView hiddenCodeCopyButton>{readerMarkdown}</MarkdownView>
          )}
        </div>
      </Modal>
    </div>
  );

  return withWrapper ? <SettingsPageWrapper>{mainContent}</SettingsPageWrapper> : mainContent;
};

export default SkillsHubSettings;
