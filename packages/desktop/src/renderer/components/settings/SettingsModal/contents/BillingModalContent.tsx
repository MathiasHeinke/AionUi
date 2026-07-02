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
import { Alert, Button, Card, Input, InputNumber, Message, Progress } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '@renderer/utils/platform';
import { configService } from '@/common/config/configService';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import {
  buildSeatBillingStatus,
  CLIENT_SEAT_FROM_EUR,
  DEFAULT_CREDIT_PACKS,
  validateSpendCapEur,
} from '@/common/config/creditsCore';

// The Gen-B web money surface. The desktop holds no card; it opens the web account
// where the free own-seat lives and client seats / credit packs are bought. The
// ?intent=add_seat and ?pack_eur=<n> consumers are LIVE on command-eve.com/account
// (Gen B: scroll + highlight the relevant section).
const ACCOUNT_URL = 'https://command-eve.com/account';
const ADD_SEAT_URL = `${ACCOUNT_URL}?intent=add_seat`;

const BillingModalContent: React.FC = () => {
  const { t } = useTranslation();
  const { meter, status, setSpendCap } = useCreditsStatus();

  // Gen-B seat status: is this the free own seat (0 € for ever) or a paid seat?
  // Drives the status line + the client-seat CTA copy. Defaults to the free own
  // seat until a status is read (the honest resting state for a fresh install).
  const seatBilling = useMemo(
    () => buildSeatBillingStatus({ tier: meter?.tier ?? 'free' }),
    [meter?.tier]
  );

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
    reader.onload = () => setBrand((b) => ({ ...b, logoDataUri: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  const handleSaveCap = async () => {
    const validation = validateSpendCapEur(capEur ?? 0);
    if (!validation.ok) {
      Message.error(
        t('credits.settings.capInvalid', { defaultValue: 'Enter a valid spend cap (0 = uncapped).' })
      );
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
    void openExternalUrl(ADD_SEAT_URL).catch((): undefined => undefined);
  };
  const openPackCheckout = (eur: number) => {
    void openExternalUrl(`${ACCOUNT_URL}?pack_eur=${eur}`).catch((): undefined => undefined);
  };

  return (
    <div className='billing-settings' data-testid='billing-settings'>
      {/* Live meter readout */}
      {meter ? (
        <Card className='billing-settings__meter' data-testid='billing-settings-meter'>
          {meter.isFree ? (
            <>
              <div className='billing-settings__meter-label'>
                {t('credits.settings.freeActions', {
                  defaultValue: '{{used}} / {{cap}} free actions used',
                  used: meter.freeActionsUsed,
                  cap: meter.freeCap,
                })}
              </div>
              <Progress
                percent={meter.freeCap > 0 ? Math.round((meter.freeActionsUsed / meter.freeCap) * 100) : 0}
                showText={false}
              />
            </>
          ) : (
            <>
              <div className='billing-settings__meter-label'>
                {t('credits.settings.allowanceUsed', {
                  defaultValue: '{{pct}}% of allowance used · {{rem}} credits left',
                  pct: Math.round(meter.allowanceUsedFraction * 100),
                  rem: meter.totalRemaining,
                })}
              </div>
              <Progress percent={Math.round(meter.allowanceUsedFraction * 100)} showText={false} />
              <div className='billing-settings__meter-detail'>
                {t('credits.settings.purchasedRemaining', {
                  defaultValue: '{{n}} purchased credits',
                  n: meter.purchasedRemaining,
                })}
              </div>
            </>
          )}
        </Card>
      ) : (
        <Alert
          type='info'
          content={t('credits.settings.noStatus', { defaultValue: 'Credit status will appear once you are signed in.' })}
        />
      )}

      {/* Spend-cap setting */}
      <Card className='billing-settings__cap' title={t('credits.settings.spendCapTitle', { defaultValue: 'Spend cap' })}>
        <p className='billing-settings__hint'>
          {t('credits.settings.spendCapHint', {
            defaultValue: 'Cap how much EVE may spend on credits per period. 0 = uncapped.',
          })}
        </p>
        <div className='billing-settings__cap-row'>
          <InputNumber
            min={0}
            value={capEur}
            onChange={(v) => setCapEur(typeof v === 'number' ? v : undefined)}
            suffix='€'
            placeholder='0'
            style={{ width: 160 }}
            data-testid='billing-spend-cap-input'
          />
          <Button type='primary' loading={saving} onClick={handleSaveCap} data-testid='billing-spend-cap-save'>
            {t('credits.settings.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </Card>

      {/* Gen-B seat status + client-seat expansion CTA. No "plan" is sold here:
          the operator's OWN seat is 0 € for ever; growth = paid CLIENT seats. */}
      <Card className='billing-settings__plans' title={t('credits.settings.seatTitle', { defaultValue: 'Your seat' })}>
        <div className='billing-settings__plan-row' data-testid='billing-own-seat'>
          <span className='billing-settings__plan-name'>
            {seatBilling.isFreeOwnSeat
              ? t('credits.settings.ownSeatFree', { defaultValue: 'Your own seat: 0 € — forever' })
              : t('credits.settings.ownSeatPaid', { defaultValue: 'Your seat is active (paid client seat)' })}
          </span>
        </div>
        <p className='billing-settings__hint'>
          {t('credits.settings.clientSeatHint', {
            defaultValue:
              'Grow by adding CLIENT seats — from {{eur}} €/month, incl. 60,000 credits each. Your own seat always stays free.',
            eur: CLIENT_SEAT_FROM_EUR,
          })}
        </p>
        <Button type='primary' long shape='round' onClick={openAddSeat} data-testid='billing-add-seat'>
          {t('credits.settings.addClientSeat', {
            defaultValue: 'Add a client seat — from {{eur}} €/month',
            eur: CLIENT_SEAT_FROM_EUR,
          })}
        </Button>
      </Card>

      {/* Credit packs — the RECURRING top-up packs (+20 % each), matching the
          Gen-B website and the server TOP_UP_BONUS_FACTOR=1.2. */}
      <Card className='billing-settings__packs' title={t('credits.settings.packsTitle', { defaultValue: 'Credit packs' })}>
        <p className='billing-settings__hint'>
          {t('credits.settings.packsHint', {
            defaultValue: 'Out of allowance? Recurring top-ups add +20 % credits. Going big = a bigger pack, never a higher plan.',
          })}
        </p>
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
      </Card>

      {/* Report branding — the operator's own name/logo/footer on every deliverable EVE
          exports. The reseller prop is "deliver under YOUR brand"; this is the setter that
          was missing (the value is already READ + rendered by the report PreviewPanel). */}
      <Card className='billing-settings__brand' title={t('credits.settings.brandTitle', { defaultValue: 'Report branding' })}>
        <p className='billing-settings__hint'>
          {t('credits.settings.brandHint', {
            defaultValue: 'Your name, logo and footer on every report EVE delivers — deliver under your brand, not ours.',
          })}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 440 }}>
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
            placeholder={t('credits.settings.brandFooterPlaceholder', { defaultValue: 'Footer line (contact, website, legal)' })}
            maxLength={200}
            autoSize={{ minRows: 2, maxRows: 4 }}
            data-testid='billing-brand-footer'
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {brand.logoDataUri ? (
              <img src={brand.logoDataUri} alt='brand logo' style={{ height: 40, maxWidth: 160, objectFit: 'contain', borderRadius: 4 }} />
            ) : null}
            <label style={{ cursor: 'pointer' }}>
              <input
                type='file'
                accept='image/png,image/jpeg,image/svg+xml'
                style={{ display: 'none' }}
                onChange={(e) => handleLogoFile(e.target.files?.[0] ?? undefined)}
              />
              <Button>
                {brand.logoDataUri
                  ? t('credits.settings.brandLogoChange', { defaultValue: 'Change logo' })
                  : t('credits.settings.brandLogoPick', { defaultValue: 'Upload logo' })}
              </Button>
            </label>
            {brand.logoDataUri ? (
              <Button status='danger' type='text' onClick={() => setBrand((b) => ({ ...b, logoDataUri: undefined }))}>
                {t('credits.settings.brandLogoRemove', { defaultValue: 'Remove' })}
              </Button>
            ) : null}
          </div>
          <div>
            <Button type='primary' loading={brandSaving} onClick={handleSaveBrand} data-testid='billing-brand-save'>
              {t('credits.settings.brandSave', { defaultValue: 'Save branding' })}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default BillingModalContent;
