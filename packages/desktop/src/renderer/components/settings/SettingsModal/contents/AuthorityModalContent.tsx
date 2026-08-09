/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Freigaben. The one place a human sets what EVE may do unasked.
 *
 * Two blocks, deliberately not one: a ladder for the everyday decision, and the
 * sealed switches for the trust decisions. They never share a control, so nobody
 * who meant "just get on with it" also buys "and spend my money".
 *
 * All logic lives in eveAuthorityCore / eveAuthorityStoreCore. This file reads,
 * renders and writes — nothing here decides anything.
 */

import { configService } from '@/common/config/configService';
import {
  EVE_SEALED_CAPABILITIES,
  type EveAuthorityGrant,
  type EveLadderRung,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';
import { readRememberedCommands } from '@/common/config/eveRememberedCommandsCore';
import {
  classifyDailyBudget,
  ENFORCED_LADDER_RUNGS,
  grantNeedsAttention,
  isFullAuthority,
  isUnconfirmedGrant,
  previewFullAuthority,
  resolveStoredGrant,
  withDailyBudget,
  withFullAuthority,
  withLadder,
  withOpaqueUiAutoRun,
  withoutRememberedCommand,
  withSeal,
  type FullAuthorityMoney,
  type FullAuthorityOpaqueUi,
} from '@/common/config/eveAuthorityStoreCore';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useActiveSeatId } from '@/renderer/hooks/useActiveSeatId';
import { Button, InputNumber, Radio, Switch } from '@arco-design/web-react';
import { Browser, Computer, Delete, Key, Ladder, Send, Shield, Unlock, UploadWeb, Wallet } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** i18n keys per rung. Copy lives in commandEve.json so translators see them together. */
const RUNG_KEYS: Record<EveLadderRung, string> = {
  0: 'authority.rung.watch',
  1: 'authority.rung.ask',
  2: 'authority.rung.routine',
  3: 'authority.rung.work',
  4: 'authority.rung.independent',
  5: 'authority.rung.full',
};

/** i18n keys per seal. Same arrangement as the rungs, for the same reason. */
const SEAL_KEYS: Record<EveSealedCapability, string> = {
  'spend.money': 'authority.seal.money',
  'publish.outward': 'authority.seal.publish',
  'delete.outside': 'authority.seal.delete',
  'credentials.read': 'authority.seal.credentials',
  'deploy.production': 'authority.seal.deploy',
};

/** One familiar, unboxed glyph per effect. The 24 px slot keeps text baselines aligned. */
const SEAL_ICONS = {
  'spend.money': <Wallet theme='outline' size={16} fill='currentColor' />,
  'publish.outward': <Send theme='outline' size={16} fill='currentColor' />,
  'delete.outside': <Delete theme='outline' size={16} fill='currentColor' />,
  'credentials.read': <Key theme='outline' size={16} fill='currentColor' />,
  'deploy.production': <UploadWeb theme='outline' size={16} fill='currentColor' />,
} satisfies Record<EveSealedCapability, React.ReactNode>;

const authoritySectionTitle = (icon: React.ReactNode, label: React.ReactNode, testId: string): React.ReactNode => (
  <span className='inline-flex min-w-0 items-center gap-8px'>
    <span
      aria-hidden='true'
      className='flex h-24px w-24px shrink-0 items-center justify-center text-[var(--eve-shell-text-secondary)]'
      data-testid={testId}
    >
      {icon}
    </span>
    <span className='min-w-0'>{label}</span>
  </span>
);

/** Cents to whole units, for display. No currency symbol: this panel does not know the seat's. */
const perDay = (cents: number): string => (cents / 100).toFixed(2);

const AuthorityModalContent: React.FC = () => {
  const { t } = useTranslation();
  const activeSeatId = useActiveSeatId();

  // Read the grant REACTIVELY, not once on mount.
  //
  // `commandEve.authority` is seat-scoped, and `rebindSeat` re-notifies every
  // seat-scoped key whose value differs under the new seat. A one-shot
  // `configService.get` in a mount effect does not hear that: switching seats
  // with this page open left the PREVIOUS seat's ladder on screen until the
  // page was remounted — in both directions, so it could show "Fragen" while
  // the active seat was actually at "Arbeiten". On the page whose whole job is
  // to state what EVE may do unasked, that is the page lying about the seat you
  // are in. Verified in the packaged 1.820.0 app, not deduced.
  //
  // `useDayZeroOnboarding` already carries this exact lesson for
  // `commandEve.clientSeedDismissed`; this is the same fix on the same
  // mechanism.
  const [storedGrant] = useConfig('commandEve.authority');
  const [legacyAcpConfig] = useConfig('acp.config');

  // useConfig's first snapshot is a synchronous read that can land BEFORE the
  // config cache has finished loading, and `initialize()` does not notify per
  // key. Render nothing until it is ready rather than briefly showing a default
  // nobody chose — a flash of the wrong rung is the same defect in miniature.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void configService.whenReady().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const grant = useMemo(() => resolveStoredGrant(storedGrant, legacyAcpConfig), [storedGrant, legacyAcpConfig]);

  // The full release is a two-step act on purpose: a button that opened five
  // seals on one click would be the kind of control people press to find out
  // what it does. Step two lists the concrete consequences and can be walked
  // away from.
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  // Money defaults to IN, because leaving it out quietly is how someone ends up
  // with a "full release" that cannot pay for a model and no idea why. But it
  // still needs a number — the toggle alone never opens the seal.
  const [releaseMoney, setReleaseMoney] = useState(true);
  const [releaseBudget, setReleaseBudget] = useState<number | undefined>(() =>
    grant.limits?.['spend.money']?.dailyCents !== undefined ? grant.limits['spend.money'].dailyCents / 100 : undefined
  );
  // A fresh full-release confirmation never assumes the broad UI override.
  // If this seat already enabled it, reflecting that state is not a new grant.
  const [releaseOpaqueUiAutoRun, setReleaseOpaqueUiAutoRun] = useState(grant.opaqueUiAutoRun === true);

  // A Full Release draft belongs to exactly one seat/grant snapshot. The
  // settings shell intentionally stays mounted across seat switches; carrying
  // this local draft would let a choice made on Seat A be applied to Seat B.
  useEffect(() => {
    setConfirmingRelease(false);
    setReleaseMoney(true);
    setReleaseBudget(
      grant.limits?.['spend.money']?.dailyCents !== undefined ? grant.limits['spend.money'].dailyCents / 100 : undefined
    );
    setReleaseOpaqueUiAutoRun(grant.opaqueUiAutoRun === true);
  }, [activeSeatId, grant]);

  const persist = useCallback(async (next: EveAuthorityGrant) => {
    // No local mirror of the value: the write notifies, `useConfig` re-reads.
    // The seat-scoped grant IS the record, and it is the only thing written.
    //
    // This used to also mirror the choice into `acp.config[hermes].preferredMode`
    // so the session-opening path — which read that key raw — would see it. But
    // `acp.config` is install-global while the grant is per seat, so the mirror
    // carried one seat's decision into every seat that had never made one (P1,
    // Kimi). The session paths now read the grant through `getModePreference`,
    // which is what makes dropping the mirror safe rather than inert.
    await configService.set('commandEve.authority', next);
  }, []);

  const remembered = useMemo(() => readRememberedCommands(grant.rememberedCommands), [grant]);

  // `grant` is always resolved (resolveStoredGrant falls back closed); what we
  // wait for is the config cache, not the value.
  if (!ready) return null;

  const onLadder = (value: EveLadderRung): void => {
    void persist(withLadder(grant, value));
  };

  const onForget = (command: string): void => {
    void persist(withoutRememberedCommand(grant, command));
  };

  const onSeal = (capability: EveSealedCapability, open: boolean): void => {
    void persist(withSeal(grant, capability, open, new Date().toISOString()));
  };

  const onOpaqueUiAutoRun = (enabled: boolean): void => {
    void persist(withOpaqueUiAutoRun(grant, enabled, new Date().toISOString()));
  };

  const onBudget = (value: number | undefined): void => {
    // A rejected amount leaves the grant alone (`withDailyBudget`), so a
    // half-typed number never becomes a ceiling nobody agreed to.
    if (typeof value !== 'number') return;
    void persist(withDailyBudget(grant, Math.round(value * 100)));
  };

  const dailyCents = grant.limits?.['spend.money']?.dailyCents;
  const moneyOpen = grant.capabilities['spend.money'] === true;

  // NaN when the toggle is on and no number has been typed. That is deliberate:
  // it flows into `previewFullAuthority` as `blocked: 'invalid-budget'`, so the
  // "no amount named" case travels down exactly the same path as a typo and
  // cannot end up silently opening the money seal.
  const releaseMoneyChoice: FullAuthorityMoney = releaseMoney
    ? { dailyCents: typeof releaseBudget === 'number' ? Math.round(releaseBudget * 100) : Number.NaN }
    : 'keep-sealed';
  const releaseOpaqueUiChoice: FullAuthorityOpaqueUi = releaseOpaqueUiAutoRun ? 'allow' : 'keep-asking';
  const releasePreview = previewFullAuthority(grant, releaseMoneyChoice, releaseOpaqueUiChoice);
  const fullyReleased = isFullAuthority(grant);

  const onRelease = (): void => {
    // `withFullAuthority` re-checks and returns the grant untouched if the
    // budget is refused; the disabled button is the courtesy, not the guard.
    void persist(withFullAuthority(grant, releaseMoneyChoice, releaseOpaqueUiChoice, new Date().toISOString()));
    setConfirmingRelease(false);
  };

  const openReleaseConfirmation = (): void => {
    // Never carry a toggle experiment from another seat or a cancelled dialog.
    setReleaseOpaqueUiAutoRun(grant.opaqueUiAutoRun === true);
    setConfirmingRelease(true);
  };

  const sealName = (capability: EveSealedCapability): string => t(`commandEve.${SEAL_KEYS[capability]}.title`);

  return (
    <AionScrollArea>
      <div className='flex flex-col pb-24px' data-testid='authority-content'>
        {isUnconfirmedGrant(grant) && (
          <div className='eve-settings-notice eve-settings-notice--warning text-14px'>
            {t('commandEve.authority.notConfirmedYet')}
          </div>
        )}

        <SettingsSection
          title={authoritySectionTitle(
            <Ladder theme='outline' size={18} fill='currentColor' />,
            t('commandEve.authority.ladderTitle'),
            'authority-section-icon-ladder'
          )}
          description={t('commandEve.authority.ladderDescription')}
          testId='authority-ladder-section'
        >
          {/*
            All six rungs render now, because all six bind. The old guard here
            existed for a real reason — a stored rung 4 inherited from a legacy
            `yolo` value had no option to sit on, and showing it would have
            presented an inert state as the human's decision. That reason is
            gone: `ENFORCED_LADDER_RUNGS` is the full ladder and the approval
            path reads the rung itself. The fallback stays anyway, for a grant
            whose stored value is not a rung at all.
          */}
          <Radio.Group
            direction='vertical'
            value={ENFORCED_LADDER_RUNGS.includes(grant.ladder) ? grant.ladder : undefined}
            onChange={onLadder}
            className='eve-settings-list flex flex-col'
          >
            {ENFORCED_LADDER_RUNGS.map((rung) => (
              <Radio key={rung} value={rung} className='w-full items-start py-12px'>
                <span className='min-w-0 pl-2px'>
                  <span className='eve-settings-preference-row__label block'>
                    {t(`commandEve.${RUNG_KEYS[rung]}.title`)}
                  </span>
                  <span className='eve-settings-preference-row__description block'>
                    {t(`commandEve.${RUNG_KEYS[rung]}.body`)}
                  </span>
                </span>
              </Radio>
            ))}
          </Radio.Group>
        </SettingsSection>

        {/*
          The five seals. They are NOT the top of the ladder — they hang off no
          rung at all, and stay shut on rung 5 until each one is switched on
          here. That separation is the whole point: raising the ladder is a
          convenience decision, unsealing one of these is a trust decision, and
          nobody who meant "just get on with it" should also buy "and spend my
          money".

          They render now because they finally BIND — but not by the route this
          comment used to claim. It said "the approval path asks
          `decideAuthority` on every decision"; `decideAuthority` has no
          production caller at all. What actually runs: a terminal command goes
          through `decideCommandApproval`, which consults `runtime.seals` FIRST,
          so a closed seal beats every rung including 5
          (eveAuthorityRuntimeCore:164-165). The seal booleans themselves come
          from `renderEveAuthorityRuntime`, i.e. from `grantAllows`.

          The honest limit of that: it binds for shell commands the seal
          matcher recognises. See the "what this ladder does not decide"
          section below for what it does not reach.
        */}
        <SettingsSection
          title={authoritySectionTitle(
            <Shield theme='outline' size={18} fill='currentColor' />,
            t('commandEve.authority.sealsTitle'),
            'authority-section-icon-seals'
          )}
          description={t('commandEve.authority.sealsDescription')}
          bodyClassName='eve-settings-list'
          testId='authority-seals-section'
        >
          {EVE_SEALED_CAPABILITIES.map((capability) => (
            <div key={capability} className='flex flex-col' data-testid={`seal-row-${capability}`}>
              <PreferenceRow
                label={
                  <span className='flex min-w-0 items-start gap-10px'>
                    <span
                      aria-hidden='true'
                      className='flex h-24px w-24px shrink-0 items-center justify-center text-[var(--eve-shell-text-secondary)]'
                      data-testid={`authority-seal-icon-${capability}`}
                    >
                      {SEAL_ICONS[capability]}
                    </span>
                    <span className='min-w-0'>
                      <span className='block'>{t(`commandEve.${SEAL_KEYS[capability]}.title`)}</span>
                      <span className='eve-settings-preference-row__description block'>
                        {t(`commandEve.${SEAL_KEYS[capability]}.body`)}
                      </span>
                    </span>
                  </span>
                }
              >
                <Switch
                  checked={grant.capabilities[capability] === true}
                  onChange={(open) => onSeal(capability, open)}
                  data-testid={`seal-switch-${capability}`}
                />
              </PreferenceRow>
              {capability === 'spend.money' && moneyOpen && (
                <div className='eve-settings-sublist mb-12px ml-34px flex flex-col gap-4px'>
                  <div className='flex items-center gap-8px'>
                    <span className='text-13px text-[var(--eve-shell-text-secondary)]'>
                      {t('commandEve.authority.dailyBudget')}
                    </span>
                    <InputNumber
                      size='small'
                      min={0.01}
                      step={1}
                      precision={2}
                      style={{ width: 120 }}
                      value={typeof dailyCents === 'number' ? dailyCents / 100 : undefined}
                      onChange={onBudget}
                      data-testid='seal-budget-money'
                    />
                  </div>
                  {/*
                    An open money seal with no usable ceiling is REFUSED at
                    decision time (`spendWithinDailyLimit`), never read as
                    unlimited. Saying so here is what stops the user seeing a
                    switch that is on, an EVE that never spends, and concluding
                    the feature is broken.
                  */}
                  {grantNeedsAttention(grant) === 'money-without-budget' && (
                    <div className='text-13px text-orange-6' data-testid='budget-missing'>
                      {t('commandEve.authority.budgetMissing')}
                    </div>
                  )}
                  {classifyDailyBudget(dailyCents) === 'confirm' && (
                    <div className='text-13px text-orange-6' data-testid='budget-high'>
                      {t('commandEve.authority.budgetHigh')}
                    </div>
                  )}
                  {/*
                    The line that keeps this field from being a lie.

                    The stored limit is not dressed up as live enforcement.
                    There is no day counter anywhere:
                    `spentTodayCents` exists only as a type (:126) and a read
                    (:206), with no store, no day boundary and no rollover
                    behind it — and the number never reaches EVE at all, since
                    the approval endpoint answers with exactly
                    `{decision, edit_policy, ladder}` (ollamaOpenAiShim:2667-2671).

                    The runtime therefore keeps `spend.money` false for
                    generic terminal commands. Opaque Browser/Desktop actions
                    use their separate, broad auto-run choice above; when it
                    is enabled, the saved daily number does not meter those
                    clicks. Product-managed generation keeps its separate
                    credit preflight.
                  */}
                  <div className='text-13px text-[var(--eve-shell-text-secondary)]' data-testid='budget-not-enforced'>
                    {t('commandEve.authority.budgetNotEnforced')}
                  </div>
                </div>
              )}
            </div>
          ))}
        </SettingsSection>

        {/*
          OPAQUE UI AUTO-RUN IS ITS OWN AXIS, NOT A SIXTH SEAL.

          The five seals describe effects. A browser click or Desktop keypress
          cannot prove its effect before it happens, so this control explicitly
          acknowledges that the visible last mile may cross those seals
          indirectly. Hermes stays installed and callable while this is off;
          only unattended click/type execution changes.
        */}
        <SettingsSection
          title={authoritySectionTitle(
            <span className='relative block h-24px w-24px'>
              <Browser theme='outline' size={16} fill='currentColor' className='absolute left-0 top-0 leading-none' />
              <Computer
                theme='outline'
                size={16}
                fill='currentColor'
                className='absolute bottom-0 right-0 leading-none'
              />
            </span>,
            t('commandEve.authority.opaqueUiTitle'),
            'authority-section-icon-opaque-ui'
          )}
          description={t('commandEve.authority.opaqueUiDescription')}
          bodyClassName='eve-settings-list'
          testId='authority-opaque-ui-section'
        >
          <div className='flex flex-col' data-testid='opaque-ui-autorun-row'>
            <PreferenceRow
              label={t('commandEve.authority.opaqueUiToggleTitle')}
              description={t('commandEve.authority.opaqueUiToggleBody')}
            >
              <Switch
                checked={grant.opaqueUiAutoRun === true}
                disabled={grant.ladder < 4 && grant.opaqueUiAutoRun !== true}
                onChange={onOpaqueUiAutoRun}
                data-testid='opaque-ui-autorun-switch'
              />
            </PreferenceRow>
            {grant.ladder < 4 && (
              <div className='eve-settings-inline-notice mb-10px text-orange-6' data-testid='opaque-ui-rung-required'>
                {t('commandEve.authority.opaqueUiRungRequired')}
              </div>
            )}
            <div
              className='eve-settings-notice eve-settings-notice--warning mb-12px text-13px'
              data-testid='opaque-ui-warning'
            >
              {t('commandEve.authority.opaqueUiWarning')}
            </div>
          </div>
        </SettingsSection>

        {/*
          THE ONE-ACT PATH TO "just get on with it".

          Deliberately NOT a sixth-and-a-half rung. Rung 5 already admits every
          action class, and the seals hang off no rung at all — that separation
          is the reason `grantAllows` reads the seal before the ladder. So this
          control does not introduce a new kind of grant; it performs the same
          writes the individual controls above perform, in one confirmed act
          (`withFullAuthority` is literally a composition of them).

          The confirmation step is not ceremony. A button that opened five seals
          and opaque UI auto-run on one press is a button people press to find
          out what it does. The independent switches and list below make every
          consequence available BEFORE the press.
        */}
        <SettingsSection
          title={authoritySectionTitle(
            <Unlock theme='outline' size={18} fill='currentColor' />,
            t('commandEve.authority.fullReleaseTitle'),
            'authority-section-icon-full-release'
          )}
          description={t('commandEve.authority.fullReleaseDescription')}
          testId='authority-full-release-section'
        >
          {fullyReleased && !confirmingRelease ? (
            <div className='eve-settings-inline-notice' data-testid='full-release-active'>
              {t('commandEve.authority.fullReleaseActive', {
                amount: perDay(grant.limits?.['spend.money']?.dailyCents ?? 0),
              })}
            </div>
          ) : confirmingRelease ? (
            <div className='flex flex-col gap-14px' data-testid='full-release-confirm'>
              <div className='eve-settings-disclosure'>{t('commandEve.authority.fullReleaseConfirmIntro')}</div>

              {/*
                Money is asked for, never assumed. `spendWithinDailyLimit`
                refuses an open money seal with no ceiling, so a full release
                that skipped this question would produce a switch that is on and
                an EVE that never spends — the exact state this panel already has
                a warning for.
              */}
              <div className='eve-settings-list' data-testid='full-release-preferences'>
                <PreferenceRow label={t('commandEve.authority.fullReleaseMoneyLabel')} stackOnMobile>
                  <div className='flex items-center gap-8px'>
                    <Switch
                      checked={releaseMoney}
                      onChange={setReleaseMoney}
                      aria-label={t('commandEve.authority.fullReleaseMoneyLabel')}
                      data-testid='full-release-money-switch'
                    />
                    {releaseMoney && (
                      <InputNumber
                        size='small'
                        min={0.01}
                        step={1}
                        precision={2}
                        style={{ width: 120 }}
                        value={releaseBudget}
                        onChange={setReleaseBudget}
                        data-testid='full-release-budget'
                      />
                    )}
                  </div>
                </PreferenceRow>

                <PreferenceRow
                  label={t('commandEve.authority.fullReleaseOpaqueUiLabel')}
                  description={t('commandEve.authority.fullReleaseOpaqueUiBody')}
                >
                  <Switch
                    checked={releaseOpaqueUiAutoRun}
                    onChange={setReleaseOpaqueUiAutoRun}
                    data-testid='full-release-opaque-ui-switch'
                  />
                </PreferenceRow>
              </div>

              <ul className='eve-settings-sublist flex flex-col gap-4px text-13px' data-testid='full-release-effects'>
                <li>
                  {releasePreview.ladderChanges
                    ? t('commandEve.authority.fullReleaseLadder', {
                        from: t(`commandEve.${RUNG_KEYS[releasePreview.ladderFrom]}.title`),
                        to: t(`commandEve.${RUNG_KEYS[releasePreview.ladderTo]}.title`),
                      })
                    : t('commandEve.authority.fullReleaseLadderUnchanged', {
                        rung: t(`commandEve.${RUNG_KEYS[releasePreview.ladderTo]}.title`),
                      })}
                </li>
                {releasePreview.sealsToOpen.map((capability) => (
                  <li key={capability} data-testid={`full-release-opens-${capability}`}>
                    {t('commandEve.authority.fullReleaseOpens', { seal: sealName(capability) })}
                  </li>
                ))}
                {releasePreview.sealsAlreadyOpen.map((capability) => (
                  <li key={capability} className='op-70'>
                    {t('commandEve.authority.fullReleaseAlreadyOpen', { seal: sealName(capability) })}
                  </li>
                ))}
                <li data-testid='full-release-money-line'>
                  {releasePreview.moneyLeftAsIs
                    ? t('commandEve.authority.fullReleaseMoneyUntouched')
                    : releasePreview.blocked === 'invalid-budget'
                      ? t('commandEve.authority.fullReleaseBudgetMissing')
                      : t('commandEve.authority.fullReleaseMoneyLimit', {
                          amount: perDay(releasePreview.dailyCents ?? 0),
                        })}
                </li>
                <li data-testid='full-release-opaque-ui-line'>
                  {releasePreview.opaqueUiAutoRunWillDisable
                    ? t('commandEve.authority.fullReleaseOpaqueUiDisables')
                    : releasePreview.opaqueUiAutoRunLeftAsIs
                      ? t('commandEve.authority.fullReleaseOpaqueUiUntouched')
                      : releasePreview.opaqueUiAutoRunAlreadyEnabled
                        ? t('commandEve.authority.fullReleaseOpaqueUiAlreadyOpen')
                        : t('commandEve.authority.fullReleaseOpaqueUiEnables')}
                </li>
              </ul>

              {releaseOpaqueUiAutoRun && (
                <div
                  className='eve-settings-notice eve-settings-notice--warning text-13px'
                  data-testid='full-release-opaque-ui-warning'
                >
                  {t('commandEve.authority.opaqueUiWarning')}
                </div>
              )}

              {/* Identical wording to the seals section, from the same key: the
                  two surfaces must not be able to describe money differently. */}
              {!releasePreview.moneyLeftAsIs && (
                <div className='eve-settings-inline-notice' data-testid='full-release-budget-not-enforced'>
                  {t('commandEve.authority.budgetNotEnforced')}
                </div>
              )}

              {releasePreview.changesNothing && (
                <div className='eve-settings-inline-notice' data-testid='full-release-noop'>
                  {t('commandEve.authority.fullReleaseNothingToDo')}
                </div>
              )}

              <div className='flex items-center gap-8px'>
                <Button
                  size='small'
                  type='primary'
                  status='warning'
                  disabled={releasePreview.blocked !== null}
                  onClick={onRelease}
                  data-testid='full-release-apply'
                >
                  {t('commandEve.authority.fullReleaseApply')}
                </Button>
                <Button size='small' onClick={() => setConfirmingRelease(false)} data-testid='full-release-cancel'>
                  {t('commandEve.authority.fullReleaseCancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size='small' onClick={openReleaseConfirmation} data-testid='full-release-open'>
              {t('commandEve.authority.fullReleaseButton')}
            </Button>
          )}
        </SettingsSection>

        {/*
          WHAT THIS PAGE DOES NOT DECIDE.
          
          Every line here was measured against the installed wheel, not quoted
          from a design note. A panel that lists six rungs and five seals reads
          as a complete account of what EVE may do; it is not one, and the gap
          is invisible unless it is written down.
          
          Native Hermes tools without their own terminal/file ACP callback now
          pass through Command EVE's structured pre_tool_call authority hook
          before their native handlers. User rung, independent effect seals and
          the explicit opaque-UI override are the three product-policy axes.
          The first remaining boundary is upstream and deliberate:
            - tools/computer_use/tool.py `_BLOCKED_KEY_COMBOS` is a genuine
              hard block for session-destroying system shortcuts. The user's
              rung decides ordinary click/type actions; this survival floor
              remains even on Full.
            - tools/tirith_security.py:74  `tirith_fail_open: True` by default,
              consumed at :720 and :726-729 — an unresolvable binary returns
              "allow", not "block". We write no `security` config, so the
              default stands.
            - tools/write_approval.py:74-82  upstream write approvals remain
              optional; Command EVE's structured hook binds memory, skill and
              schedule changes to the seat grant before dispatch.
            - tools/website_policy.py:253-262  the blocklist logs and returns
              None on any config error — fail-open by design.
            - acp_adapter/permissions.py:36 + :159-164  the 300s window. This
              one is NOT fail-open, which is exactly why it is worth stating:
              the timeout path returns "deny". Users assume the opposite about
              a five-minute wait, and the assumption is the risk.
          
          The sixth is ours, and it is the one this section exists to keep
          honest: the daily amount is stored, but generic terminal money
          commands still ask because no atomic ledger exists. If the user opens
          opaque Browser/Desktop auto-run, UI clicks can indirectly pay without
          that amount constraining them; the warning above states this plainly.
        */}
        <SettingsSection
          title={t('commandEve.authority.limitsTitle')}
          description={t('commandEve.authority.limitsDescription')}
        >
          <ul
            className='eve-settings-sublist flex flex-col gap-8px text-13px text-[var(--eve-shell-text-secondary)]'
            data-testid='authority-limits'
          >
            <li>{t('commandEve.authority.limitScreen')}</li>
            <li>{t('commandEve.authority.limitScanner')}</li>
            <li>{t('commandEve.authority.limitMemory')}</li>
            <li>{t('commandEve.authority.limitWebsites')}</li>
            <li>{t('commandEve.authority.limitTimeout')}</li>
            <li>{t('commandEve.authority.limitMoney')}</li>
          </ul>
        </SettingsSection>

        <SettingsSection
          title={t('commandEve.authority.rememberedTitle')}
          description={t('commandEve.authority.rememberedDescription')}
          bodyClassName={remembered.length === 0 ? undefined : 'eve-settings-list'}
        >
          {remembered.length === 0 ? (
            <div className='eve-settings-muted'>{t('commandEve.authority.rememberedEmpty')}</div>
          ) : (
            remembered.map((entry) => (
              <PreferenceRow
                key={entry.command}
                label={<code className='break-all text-13px'>{entry.command}</code>}
                description={t('commandEve.authority.grantedAt', {
                  date: new Date(entry.grantedAt).toLocaleDateString(),
                })}
                testId='remembered-row'
              >
                <Button size='mini' status='danger' onClick={() => onForget(entry.command)}>
                  {t('commandEve.authority.forget')}
                </Button>
              </PreferenceRow>
            ))
          )}
        </SettingsSection>
      </div>
    </AionScrollArea>
  );
};

export default AuthorityModalContent;
