/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Empty, Spin, Tag } from '@arco-design/web-react';
import { bridge } from '@office-ai/platform';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { isElectronDesktop } from '@renderer/utils/platform';

type SkillState = 'executable' | 'prompt_label' | 'gated' | 'disabled';

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

// v1.6 — EVE-authored skills (her own field skills, provenance = disk location).
type AuthoredSkillCard = {
  id: string;
  name: string;
  description: string;
  path: string;
  authored_at_ms: number;
  source: 'authored';
};

const authoredSkillsBridge = bridge.buildProvider<
  BridgeResponse<{ ok: boolean; skills: AuthoredSkillCard[] }>,
  void
>('command-eve.authored-skills');

// A skill counts as "neu" for 14 days after EVE wrote it — the same honest mtime
// horizon the v1.6 handover note uses. Pure; the caller passes now.
const AUTHORED_NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const isAuthoredNew = (authoredAtMs: number, nowMs: number): boolean =>
  authoredAtMs > 0 && nowMs - authoredAtMs <= AUTHORED_NEW_WINDOW_MS;

const stateColor = (state: SkillState): 'green' | 'orange' | 'purple' | 'red' => {
  if (state === 'executable') return 'green';
  if (state === 'prompt_label') return 'purple';
  if (state === 'gated') return 'orange';
  return 'red';
};

const textOrDash = (value?: string | null): string => {
  const text = String(value || '').trim();
  return text || '-';
};

const SummaryCard: React.FC<{ label: string; value: number; state: SkillState }> = ({ label, value, state }) => (
  <div className='rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-16px py-14px'>
    <div className='text-12px leading-18px text-t-tertiary'>{label}</div>
    <div className='mt-6px flex items-center gap-8px'>
      <span className='text-24px font-700 leading-30px text-t-primary'>{value}</span>
      <Tag color={stateColor(state)}>{label}</Tag>
    </div>
  </div>
);

const SkillCard: React.FC<{ skill: SkillLibraryCard }> = ({ skill }) => {
  const { t } = useTranslation();
  return (
    <article className='flex flex-col gap-10px rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-16px py-14px'>
      <div className='flex items-start justify-between gap-12px'>
        <div className='min-w-0'>
          <div className='truncate text-15px font-700 leading-22px text-t-primary'>{skill.name}</div>
          <div className='mt-2px truncate text-12px leading-18px text-t-tertiary'>{skill.id}</div>
        </div>
        <Tag color={stateColor(skill.state)}>{t(`skillLibrary.states.${skill.state}`)}</Tag>
      </div>
      <dl className='grid gap-x-12px gap-y-6px text-12px leading-18px sm:grid-cols-[120px_minmax(0,1fr)]'>
        <dt className='text-t-tertiary'>{t('skillLibrary.labels.executable')}</dt>
        <dd className='m-0 text-t-secondary'>
          {skill.executable ? t('skillLibrary.labels.yes') : t('skillLibrary.labels.no')}
        </dd>
        <dt className='text-t-tertiary'>{t('skillLibrary.labels.source')}</dt>
        <dd className='m-0 break-words text-t-secondary'>{textOrDash(skill.source)}</dd>
      </dl>
    </article>
  );
};

// v1.6 — a skill EVE wrote herself in the field. Shows the "Von EVE erstellt"
// badge, its description (what it does), a "Neu"-chip when recent, and the id.
const AuthoredSkillCardView: React.FC<{ skill: AuthoredSkillCard; nowMs: number }> = ({ skill, nowMs }) => {
  const { t } = useTranslation();
  return (
    <article
      data-testid={`authored-skill-${skill.id}`}
      className='flex flex-col gap-8px rounded-14px border border-solid border-[var(--color-primary-light-3)] bg-fill-1 px-16px py-14px'
    >
      <div className='flex items-start justify-between gap-12px'>
        <div className='min-w-0'>
          <div className='truncate text-15px font-700 leading-22px text-t-primary'>{skill.name}</div>
          <div className='mt-2px truncate text-12px leading-18px text-t-tertiary'>{skill.id}</div>
        </div>
        <div className='flex shrink-0 items-center gap-6px'>
          {isAuthoredNew(skill.authored_at_ms, nowMs) ? (
            <Tag color='arcoblue'>{t('skillLibrary.authored.new')}</Tag>
          ) : null}
          <Tag color='purple'>{t('skillLibrary.authored.badge')}</Tag>
        </div>
      </div>
      {skill.description ? (
        <p className='m-0 text-13px leading-20px text-t-secondary'>{skill.description}</p>
      ) : null}
    </article>
  );
};

const SkillLibraryPage: React.FC = () => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<SkillLibraryResult | null>(null);
  const [authored, setAuthored] = useState<AuthoredSkillCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isElectronDesktop()) {
      setResult({
        version: 'command-eve-skill-library/v0',
        ok: false,
        status: 'blocked',
        reason_code: 'ELECTRON_BRIDGE_REQUIRED',
        message: t('skillLibrary.blocked.electronBridgeRequired'),
        source: {
          generated_by: 'command-eve-skill-library-core',
        },
      });
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await skillLibraryBridge.invoke(undefined);
      const data = response.data;
      setResult(data ?? null);
      if (!response.success) {
        setError(response.msg || data?.message || t('skillLibrary.errors.loadFailed'));
      }
      // EVE-authored skills load independently — their absence/failure must never
      // block the main library, and a failure here just hides the section.
      try {
        const authoredResponse = await authoredSkillsBridge.invoke();
        setAuthored(
          authoredResponse.success && authoredResponse.data?.ok ? authoredResponse.data.skills : []
        );
      } catch {
        setAuthored([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('skillLibrary.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = result?.model;
  const skills = model?.skills ?? [];
  const visibleWarnings = model?.warnings.filter((warning) => warning.trim()).slice(0, 3) ?? [];

  return (
    <div className='size-full overflow-y-auto bg-bg-1'>
      <div className={classNames('mx-auto flex max-w-1280px flex-col gap-18px px-24px py-28px', isMobile && 'px-16px')}>
        <header className='flex flex-wrap items-start justify-between gap-12px'>
          <div className='min-w-0'>
            <div className='flex items-center gap-8px'>
              <h1 className='m-0 text-28px font-700 leading-34px text-t-primary'>{t('skillLibrary.title')}</h1>
              <Tag color='gray'>{t('skillLibrary.readOnly')}</Tag>
            </div>
            <p className='m-0 mt-8px max-w-820px text-14px leading-22px text-t-secondary'>
              {t('skillLibrary.subtitle')}
            </p>
          </div>
          <Button type='secondary' loading={loading} onClick={() => void load()}>
            {t('skillLibrary.refresh')}
          </Button>
        </header>

        {error ? <Alert type='warning' title={t('skillLibrary.errors.loadFailed')} content={error} /> : null}
        {result && !result.ok ? (
          <Alert
            type={result.status === 'blocked' ? 'warning' : 'error'}
            title={t('skillLibrary.blocked.title')}
            content={`${result.reason_code || 'SKILL_LIBRARY_UNAVAILABLE'}: ${result.message || t('skillLibrary.blocked.description')}`}
          />
        ) : null}

        {loading ? (
          <div className='min-h-240px flex items-center justify-center'>
            <Spin size={32} />
          </div>
        ) : model ? (
          <>
            <section className='grid gap-12px md:grid-cols-4'>
              {(['executable', 'prompt_label', 'gated', 'disabled'] as SkillState[]).map((state) => (
                <SummaryCard
                  key={state}
                  label={t(`skillLibrary.states.${state}`)}
                  value={model.summary[state]}
                  state={state}
                />
              ))}
            </section>

            <section className='rounded-16px border border-solid border-[var(--color-border-2)] bg-bg-2 px-18px py-16px'>
              <div className='mb-12px text-16px font-700 leading-24px text-t-primary'>
                {t('skillLibrary.sections.runtimeTruth')}
              </div>
              <div className='grid gap-x-12px gap-y-8px text-12px leading-18px lg:grid-cols-[190px_minmax(0,1fr)]'>
                <span className='text-t-tertiary'>{t('skillLibrary.labels.reconciliation')}</span>
                <span className='min-w-0 break-words text-t-secondary'>{model.source.runtime_reconciliation_path}</span>
                <span className='text-t-tertiary'>{t('skillLibrary.labels.capabilityPack')}</span>
                <span className='min-w-0 break-words text-t-secondary'>
                  {textOrDash(model.source.capability_pack_path)}
                </span>
                <span className='text-t-tertiary'>{t('skillLibrary.labels.managedSkillDir')}</span>
                <span className='min-w-0 break-words text-t-secondary'>
                  {textOrDash(model.source.managed_skill_dir)}
                </span>
                <span className='text-t-tertiary'>{t('skillLibrary.labels.blockedTransports')}</span>
                <span className='min-w-0 break-words text-t-secondary'>
                  {model.blocked_external_mcp_transports.length
                    ? model.blocked_external_mcp_transports.join(', ')
                    : '-'}
                </span>
                <span className='text-t-tertiary'>{t('skillLibrary.labels.kanban')}</span>
                <span className='min-w-0 break-words text-t-secondary'>
                  {`${t('skillLibrary.labels.dispatch')}: ${String(model.kanban.dispatch_in_gateway)} · ${t('skillLibrary.labels.autoDecompose')}: ${String(model.kanban.auto_decompose)}`}
                </span>
              </div>
            </section>

            {visibleWarnings.length ? (
              <section className='rounded-16px border border-solid border-[var(--color-warning-light-4)] bg-warning-1 px-18px py-16px'>
                <div className='mb-8px text-14px font-700 leading-22px text-t-primary'>
                  {t('skillLibrary.sections.warnings')}
                </div>
                <ul className='m-0 pl-18px text-13px leading-20px text-t-secondary'>
                  {visibleWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {authored.length ? (
              <section data-testid='authored-skills-section'>
                <div className='mb-4px flex items-center justify-between gap-12px'>
                  <h2 className='m-0 text-18px font-700 leading-26px text-t-primary'>
                    {t('skillLibrary.sections.authored')}
                  </h2>
                  <Tag color='purple'>{authored.length}</Tag>
                </div>
                <p className='m-0 mb-12px max-w-820px text-13px leading-20px text-t-secondary'>
                  {t('skillLibrary.authored.intro')}
                </p>
                <div className='grid gap-12px xl:grid-cols-2'>
                  {authored.map((skill) => (
                    <AuthoredSkillCardView key={`authored:${skill.id}`} skill={skill} nowMs={Date.now()} />
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <div className='mb-12px flex items-center justify-between gap-12px'>
                <h2 className='m-0 text-18px font-700 leading-26px text-t-primary'>
                  {t('skillLibrary.sections.skills')}
                </h2>
                <Tag color='gray'>{skills.length}</Tag>
              </div>
              {skills.length ? (
                <div className='grid gap-12px xl:grid-cols-2'>
                  {skills.map((skill) => (
                    <SkillCard key={`${skill.state}:${skill.id}`} skill={skill} />
                  ))}
                </div>
              ) : (
                <Empty description={t('skillLibrary.empty.noSkills')} />
              )}
            </section>
          </>
        ) : (
          <Empty description={t('skillLibrary.empty.noModel')} />
        )}
      </div>
    </div>
  );
};

export default SkillLibraryPage;
