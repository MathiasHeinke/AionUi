/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Billing settings tab (Lane 3, Gen-B money surface).
 *
 * - Live credit meter (full readout).
 * - User SPEND-CAP setting (writes spend_cap_eur_cents via the bridge).
 * - GEN-B pricing: the operator's OWN seat is 0 € for ever (EVE Solo); CLIENT
 *   seats start at 99 €/mo (inkl. 60.000 Credits) and are added on the web
 *   (/account?intent=add_seat); recurring credit packs (+20 %) deep-link to
 *   /account?pack_eur=<n>. The legacy 79€ Starter / hidden 49€ Solo "plan" UI was
 *   removed with the Gen-B pricing switch (the desktop no longer sells a plan).
 *
 * The euro/credit MATH + the seat-status decision live in the PURE `creditsCore`
 * (unit-tested); this component is the settings presentation + the bridge wiring.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Message, Progress, Upload } from '@arco-design/web-react';
import { Info, UploadOne } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { openAccountWeb } from '@renderer/utils/platform';
import { configService } from '@/common/config/configService';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import { useSeatUsage } from '@renderer/hooks/useSeatUsage';
import { useSeatAccess } from '@renderer/hooks/useSeatAccess';
import { isLegacySeatId } from '@process/commandEve/seatSwitchCore';
import {
  buildSeatBillingStatus,
  CLIENT_SEAT_FROM_EUR,
  CREDIT_UNIT_EUR,
  DEFAULT_CREDIT_PACKS,
  validateSpendCapEur,
} from '@/common/config/creditsCore';
import { buildSeatUsageCardRows, currentUsageMonth, priorUsageMonth } from '@/common/config/seatUsageCore';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';

// The Gen-B web money surface. The desktop holds no card; it opens the web account
// where the free own-seat lives and client seats / credit packs are bought. The
// ?intent=add_seat and ?pack_eur=<n> consumers are LIVE on command-eve.com/account
// (Gen B: scroll + highlight the relevant section). We open these via openAccountWeb
// (MAIN attaches the desktop session so the browser lands LOGGED IN → checkout can
// start); paths are RELATIVE — openAccountWeb pins the command-eve.com origin.
const ADD_SEAT_PATH = '/account?intent=add_seat';

const BillingModalContent: React.FC = () => {
  const { t } = useTranslation();
  const { meter, status, setSpendCap } = useCreditsStatus();

  // v1.5 A3 — per-seat usage attribution. The LABEL join is renderer-only (the
  // server sends opaque ids — H3): join seat_id → access.seats[].name from the
  // my-seats wire the operator already holds. Ordering follows access.seats (=
  // the Rail order, Founder-Ask). Founder summary (ALL seats) only when the admin
  // is on their own legacy/founder home; a delegate / client-seat context sees
  // ONLY its own row (deckungsgleich mit dem my-seats-Scoping).
  const { access } = useSeatAccess();
  const { usage, available: usageAvailable, month: usageMonth, setMonth: setUsageMonth } = useSeatUsage();
  const isFounderSummary = access.role === 'admin' && isLegacySeatId(access.activeSeatId);
  const seatLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of access.seats) m.set(s.seat_id, s.name);
    return m;
  }, [access.seats]);
  const usageRows = useMemo(() => {
    if (!usage || !usage.ok) return [];
    return buildSeatUsageCardRows(
      usage.seats,
      access.seats.map((s) => s.seat_id),
      (seatId) => (seatId === null ? undefined : seatLabelById.get(seatId)),
      isFounderSummary ? null : access.activeSeatId
    );
  }, [usage, access.seats, access.activeSeatId, seatLabelById, isFounderSummary]);
  const currentMonth = currentUsageMonth();
  const isPriorMonth = usageMonth !== currentMonth;

  // Gen-B seat status: is this the free own seat (0 € for ever) or a paid seat?
  // Drives the status line + the client-seat CTA copy. Defaults to the free own
  // seat until a status is read (the honest resting state for a fresh install).
  const seatBilling = useMemo(() => (meter ? buildSeatBillingStatus({ tier: meter.tier }) : null), [meter]);

  // Spend-cap form state (euros). Seeded from the current status.
  const [capEur, setCapEur] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (status && status.ok) {
      setCapEur(status.spend_cap_eur_cents > 0 ? Math.round(status.spend_cap_eur_cents / 100) : undefined);
    }
  }, [status]);

  // Report branding: READ + rendered on every deliverable (PreviewPanel) but never SET
  // until now. The reseller prop is "deliver under YOUR brand" — this is where they set it.
  const [brand, setBrand] = useState<{ displayName?: string; footer?: string; logoDataUri?: string }>(
    () => configService.get('commandEve.reportBrand') ?? {}
  );
  const [brandSaving, setBrandSaving] = useState(false);

  const handleSaveBrand = async () => {
    setBrandSaving(true);
    try {
      await configService.set('commandEve.reportBrand', {
        displayName: brand.displayName?.trim() || undefined,
        footer: brand.footer?.trim() || undefined,
        logoDataUri: brand.logoDataUri || undefined,
      });
      Message.success(
        t('credits.settings.brandSaved', { defaultValue: 'Branding saved — it appears on every report EVE delivers.' })
      );
    } catch (error) {
      Message.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBrandSaving(false);
    }
  };

  const handleLogoFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512 * 1024) {
      Message.error(t('credits.settings.brandLogoTooBig', { defaultValue: 'Logo must be under 512 KB.' }));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => setBrand((b) => ({ ...b, logoDataUri: String(reader.result) })));
    reader.readAsDataURL(file);
  };

  const handleSaveCap = async () => {
    const validation = validateSpendCapEur(capEur ?? 0);
    if (!validation.ok) {
      Message.error(t('credits.settings.capInvalid', { defaultValue: 'Enter a valid spend cap (0 = uncapped).' }));
      return;
    }
    setSaving(true);
    try {
      const ok = await setSpendCap(capEur ?? 0);
      if (ok) {
        Message.success(t('credits.settings.capSaved', { defaultValue: 'Spend cap saved.' }));
      } else {
        Message.error(t('credits.settings.capFailed', { defaultValue: 'Could not save the spend cap.' }));
      }
    } finally {
      setSaving(false);
    }
  };

  const openAddSeat = () => {
    void openAccountWeb(ADD_SEAT_PATH).catch((): undefined => undefined);
  };
  const openPackCheckout = (eur: number) => {
    void openAccountWeb(`/account?pack_eur=${eur}`).catch((): undefined => undefined);
  };

  return (
    <div className='billing-settings' data-testid='billing-settings'>
      <SettingsPageHeader
        title={t('settings.billing', { defaultValue: 'Abrechnung' })}
        description={t('credits.settings.pageDescription', {
          defaultValue: 'Behalte Guthaben, Ausgaben, Seats und das Branding deiner Reports im Blick.',
        })}
      />

      {/* Live meter readout */}
      <SettingsSection
        title={t('credits.settings.balanceTitle', { defaultValue: 'Guthaben' })}
        description={t('credits.settings.balanceDescription', {
          defaultValue: 'Dein aktueller Verbrauch und das verfügbare Guthaben.',
        })}
      >
        {meter ? (
          <div className='billing-settings__meter' data-testid='billing-settings-meter'>
            {/* ONE meter for every seat (1.820.1): the free-ACTION view that used
                to branch here promised a daily allowance that does not exist. */}
            <div className='billing-settings__meter-label'>
              {t('credits.settings.allowanceUsedEur', {
                defaultValue: '{{pct}}% of allowance used · {{rem}} credits left (≈ {{eur}} €)',
                pct: Math.round(meter.allowanceUsedFraction * 100),
                rem: meter.totalRemaining,
                eur: (meter.totalRemaining * CREDIT_UNIT_EUR).toLocaleString('de-DE', { maximumFractionDigits: 2 }),
              })}
            </div>
            <Progress percent={Math.round(meter.allowanceUsedFraction * 100)} showText={false} />
            <div className='billing-settings__meter-detail'>
              {t('credits.settings.purchasedRemaining', {
                defaultValue: '{{n}} purchased credits',
                n: meter.purchasedRemaining,
              })}
            </div>
            {/* v1.6 Slice 3 — the "Was ist ein Credit?" explainer: the PACK
                  price maps 1000:1 (model usage varies by tier factor ⇒ "≈"). */}
            <div className='billing-settings__meter-detail' data-testid='billing-credit-explainer'>
              {t('credits.settings.explainer', { defaultValue: '1.000 Credits ≈ 1 € (Pack-Preis)' })}
            </div>
          </div>
        ) : (
          <div className='eve-settings-notice eve-settings-inline-notice'>
            <Info theme='outline' size={15} />
            <span>
              {t('credits.settings.noStatus', {
                defaultValue: 'Credit status will appear once you are signed in.',
              })}
            </span>
          </div>
        )}
      </SettingsSection>

      {/* v1.5 A3 — Verbrauch nach Kunde. Per-seat usage for the month, labels
          joined from the my-seats wire (never from the server). Founder sees a
          summary of ALL seats (Rail order); a client seat sees only its own row.
          Version-skew honest: no server data ⇒ the resting note. */}
      <SettingsSection
        className='billing-settings__usage'
        testId='billing-usage'
        title={t('credits.settings.usageTitle', { defaultValue: 'Verbrauch nach Kunde' })}
        action={
          <Button
            size='mini'
            type='text'
            onClick={() => setUsageMonth(isPriorMonth ? currentMonth : priorUsageMonth(currentMonth))}
            data-testid='billing-usage-month-toggle'
          >
            {isPriorMonth
              ? t('credits.settings.usageMonthCurrent', { defaultValue: 'Aktueller Monat' })
              : t('credits.settings.usageMonthPrior', { defaultValue: 'Vormonat' })}
          </Button>
        }
      >
        <p className='billing-settings__hint'>
          {t('credits.settings.usageHint', {
            defaultValue: 'Verbrauch diesen Monat je Seat ({{month}}).',
            month: usageMonth,
          })}
        </p>
        {usageAvailable && usageRows.length > 0 ? (
          <div className='billing-settings__usage-list'>
            {usageRows.map((row) => (
              <div
                key={row.seat_id ?? '__unattributed__'}
                className='billing-settings__usage-row'
                data-testid={`billing-usage-row-${row.seat_id ?? 'unattributed'}`}
              >
                <div className='billing-settings__usage-row-head'>
                  <span className='billing-settings__usage-label'>{row.label}</span>
                  <span className='billing-settings__usage-figures'>
                    {t('credits.settings.usageFigures', {
                      defaultValue: '{{calls}} Calls · {{credits}} Credits · {{eur}} €',
                      calls: row.calls,
                      credits: row.credits,
                      eur: row.retail_eur.toFixed(2),
                    })}
                  </span>
                </div>
                <Progress percent={Math.round(row.bar_fraction * 100)} showText={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className='eve-settings-notice eve-settings-inline-notice' data-testid='billing-usage-empty'>
            <Info theme='outline' size={15} />
            <span>
              {usageAvailable
                ? t('credits.settings.usageEmpty', { defaultValue: 'Noch keine Verbrauchsdaten (ab v1.5 erfasst).' })
                : t('credits.settings.usageUnavailable', {
                    defaultValue: 'Verbrauchsdaten ab dem nächsten Server-Update.',
                  })}
            </span>
          </div>
        )}
      </SettingsSection>

      {/* Spend-cap setting */}
      <SettingsSection
        className='billing-settings__cap'
        title={t('credits.settings.spendCapTitle', { defaultValue: 'Spend cap' })}
        description={t('credits.settings.spendCapHint', {
          defaultValue: 'Cap how much EVE may spend on credits per period. 0 = uncapped.',
        })}
      >
        <div className='billing-settings__cap-row'>
          <InputNumber
            min={0}
            value={capEur}
            onChange={(v) => setCapEur(typeof v === 'number' ? v : undefined)}
            suffix='€'
            placeholder='0'
            className='billing-settings__cap-input'
            data-testid='billing-spend-cap-input'
          />
          <Button type='primary' loading={saving} onClick={handleSaveCap} data-testid='billing-spend-cap-save'>
            {t('credits.settings.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </SettingsSection>

      {/* Gen-B seat status + client-seat expansion CTA. No "plan" is sold here:
          the operator's OWN seat is 0 € for ever; growth = paid CLIENT seats. */}
      <SettingsSection
        className='billing-settings__plans'
        title={t('credits.settings.seatTitle', { defaultValue: 'Your seat' })}
        description={t('credits.settings.clientSeatHint', {
          defaultValue:
            'Grow by adding CLIENT seats — from {{eur}} €/month, incl. 60,000 credits each. Your own seat always stays free.',
          eur: CLIENT_SEAT_FROM_EUR,
        })}
      >
        <div className='billing-settings__plan-row' data-testid='billing-own-seat'>
          <span className='billing-settings__plan-name'>
            {!seatBilling
              ? t('credits.settings.seatStatusUnknown', {
                  defaultValue: 'Seat status is not verifiable right now.',
                })
              : seatBilling.isFreeOwnSeat
                ? t('credits.settings.ownSeatFree', { defaultValue: 'Your own seat: 0 € — forever' })
                : t('credits.settings.ownSeatPaid', { defaultValue: 'Your seat is active (paid client seat)' })}
          </span>
        </div>
        <Button type='primary' onClick={openAddSeat} data-testid='billing-add-seat'>
          {t('credits.settings.addClientSeat', {
            defaultValue: 'Add a client seat — from {{eur}} €/month',
            eur: CLIENT_SEAT_FROM_EUR,
          })}
        </Button>
      </SettingsSection>

      {/* Credit packs — the RECURRING top-up packs (+20 % each), matching the
          Gen-B website and the server TOP_UP_BONUS_FACTOR=1.2. */}
      <SettingsSection
        className='billing-settings__packs'
        title={t('credits.settings.packsTitle', { defaultValue: 'Credit packs' })}
        description={t('credits.settings.packsHint', {
          defaultValue:
            'Out of allowance? Recurring top-ups add +20 % credits. Going big = a bigger pack, never a higher plan.',
        })}
      >
        <div className='billing-settings__pack-grid'>
          {DEFAULT_CREDIT_PACKS.map((pack) => (
            <Button
              key={pack.eur}
              className='billing-settings__pack'
              onClick={() => openPackCheckout(pack.eur)}
              data-testid={`billing-pack-${pack.eur}`}
            >
              <span className='billing-settings__pack-price'>{pack.eur}€</span>
              {pack.bonus > 0 && (
                <span className='billing-settings__pack-bonus'>
                  {t('credits.settings.packBonus', { defaultValue: '+{{n}} bonus', n: pack.bonus })}
                </span>
              )}
            </Button>
          ))}
        </div>
      </SettingsSection>

      {/* Report branding — the operator's own name/logo/footer on every deliverable EVE
          exports. The reseller prop is "deliver under YOUR brand"; this is the setter that
          was missing (the value is already READ + rendered by the report PreviewPanel). */}
      <SettingsSection
        className='billing-settings__brand'
        title={t('credits.settings.brandTitle', { defaultValue: 'Report branding' })}
        description={t('credits.settings.brandHint', {
          defaultValue: 'Your name, logo and footer on every report EVE delivers — deliver under your brand, not ours.',
        })}
      >
        <div className='billing-settings__brand-form'>
          <Input
            value={brand.displayName ?? ''}
            onChange={(v) => setBrand((b) => ({ ...b, displayName: v }))}
            placeholder={t('credits.settings.brandNamePlaceholder', { defaultValue: 'Your agency / brand name' })}
            maxLength={80}
            showWordLimit
            data-testid='billing-brand-name'
          />
          <Input.TextArea
            value={brand.footer ?? ''}
            onChange={(v) => setBrand((b) => ({ ...b, footer: v }))}
            placeholder={t('credits.settings.brandFooterPlaceholder', {
              defaultValue: 'Footer line (contact, website, legal)',
            })}
            maxLength={200}
            autoSize={{ minRows: 2, maxRows: 4 }}
            data-testid='billing-brand-footer'
          />
          <div className='billing-settings__brand-logo-row'>
            {brand.logoDataUri ? (
              <img
                src={brand.logoDataUri}
                alt={t('credits.settings.brandLogoAlt', { defaultValue: 'Brand logo preview' })}
                className='billing-settings__brand-logo'
              />
            ) : null}
            <Upload
              accept='image/png,image/jpeg,image/svg+xml'
              autoUpload={false}
              showUploadList={false}
              beforeUpload={(file) => {
                handleLogoFile(file);
                return false;
              }}
            >
              <Button icon={<UploadOne theme='outline' size={15} />}>
                {brand.logoDataUri
                  ? t('credits.settings.brandLogoChange', { defaultValue: 'Change logo' })
                  : t('credits.settings.brandLogoPick', { defaultValue: 'Upload logo' })}
              </Button>
            </Upload>
            {brand.logoDataUri ? (
              <Button status='danger' type='text' onClick={() => setBrand((b) => ({ ...b, logoDataUri: undefined }))}>
                {t('credits.settings.brandLogoRemove', { defaultValue: 'Remove' })}
              </Button>
            ) : null}
          </div>
          <div className='eve-settings-form-actions'>
            <Button type='primary' loading={brandSaving} onClick={handleSaveBrand} data-testid='billing-brand-save'>
              {t('credits.settings.brandSave', { defaultValue: 'Save branding' })}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
};

export default BillingModalContent;
