/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Account settings tab (browser-loopback auth, P1).
 *
 * Shows the signed-in account (name / email / company, read from the LOCAL
 * registration-status bridge — no tokens) and TWO distinct sign-out actions:
 *
 *   - "Abmelden" (SOFT): removes the login from this Mac but KEEPS the local
 *     entitlement + license wire so Command EVE stays usable offline (founder
 *     decision; current behavior).
 *   - "Abmelden & Gerät zurücksetzen" (HARD, §2b): removes the three local trust
 *     artifacts (entitlement.json + registration.json + the license-wire bearer)
 *     and revokes the session, returning the device to the RegistrationGate. A
 *     reload re-mounts ProtectedLayout, whose useEntitlementGate re-reads the now
 *     `unregistered` state and renders the gate.
 *
 * When not signed in, offers a Sign-in button that triggers the web-login flow.
 * Mirrors the Billing settings panel structure (Card + bridge wiring); the
 * decisions all live in the main process — this is presentation only.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Message, Popconfirm } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { commandEve, type ICommandEveRegistrationStatusResult } from '@/common/adapter/ipcBridge';

const AccountModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<ICommandEveRegistrationStatusResult | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  // EVE Cloud (license-wire) re-activation. `bearer` = is the cloud bearer at
  // rest present? An entitled device whose activation predates the wire-at-rest
  // feature (or hit a keychain failure at activation) is entitled but bearer-less
  // → EVE Cloud silently falls back to local. Re-pasting the SAME license code
  // re-stores the wire (activateEntitlement is idempotent on the serial), with NO
  // full device reset.
  const [bearer, setBearer] = useState<boolean | undefined>(undefined);
  const [licenseCode, setLicenseCode] = useState('');
  const [activating, setActivating] = useState(false);
  // Profile edit (name + company only — email is the login identity, locked).
  const [editing, setEditing] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftCompany, setDraftCompany] = useState('');

  const refresh = useCallback(async () => {
    try {
      const response = await commandEve.registrationStatus.invoke();
      if (response.data?.ok) setInfo(response.data);
    } catch {
      // self-quiet
    }
  }, []);

  const beginEdit = useCallback(() => {
    setDraftName(info?.name || '');
    setDraftCompany(info?.company || '');
    setEditing(true);
  }, [info?.name, info?.company]);

  const handleSaveProfile = useCallback(async () => {
    const name = draftName.trim();
    const company = draftCompany.trim();
    if (!name || !company) {
      Message.error(t('settings.accountPanel.fieldsRequired', { defaultValue: 'Name und Firma dürfen nicht leer sein.' }));
      return;
    }
    setSavingProfile(true);
    try {
      const response = await commandEve.registrationUpdate.invoke({ name, company });
      if (response.data?.ok) {
        await refresh();
        setEditing(false);
        Message.success(t('settings.accountPanel.saved', { defaultValue: 'Profil gespeichert.' }));
      } else {
        Message.error(t('settings.accountPanel.saveError', { defaultValue: 'Speichern fehlgeschlagen.' }));
      }
    } catch {
      Message.error(t('settings.accountPanel.saveError', { defaultValue: 'Speichern fehlgeschlagen.' }));
    } finally {
      setSavingProfile(false);
    }
  }, [draftName, draftCompany, refresh, t]);

  const refreshBearer = useCallback(async () => {
    try {
      const response = await commandEve.licenseWireStatus.invoke();
      setBearer(response?.data?.available === true);
    } catch {
      setBearer(undefined);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBearer();
  }, [refresh, refreshBearer]);

  // Re-store the EVE Cloud license-wire bearer by re-activating with the user's
  // license code. activateEntitlement re-verifies the code cryptographically and
  // is idempotent on the code serial; on ok the bridge calls storeLicenseWire.
  const handleActivateCloud = useCallback(async () => {
    const code = licenseCode.trim();
    if (!code) return;
    setActivating(true);
    try {
      const response = await commandEve.entitlementActivate.invoke({ code });
      if (response.data?.ok) {
        setLicenseCode('');
        await refreshBearer();
        Message.success(
          t('settings.accountPanel.eveCloud.activated', { defaultValue: 'EVE Cloud aktiviert.' })
        );
      } else {
        Message.error(
          t('settings.accountPanel.eveCloud.activateError', {
            defaultValue: 'Aktivierung fehlgeschlagen — prüfe den Lizenzcode.',
          })
        );
      }
    } catch {
      Message.error(
        t('settings.accountPanel.eveCloud.activateError', {
          defaultValue: 'Aktivierung fehlgeschlagen — prüfe den Lizenzcode.',
        })
      );
    } finally {
      setActivating(false);
    }
  }, [licenseCode, refreshBearer, t]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      const response = await commandEve.authLogout.invoke();
      if (response.data?.ok) {
        await refresh();
      } else {
        Message.error(t('settings.accountPanel.logout'));
      }
    } catch {
      Message.error(t('settings.accountPanel.logout'));
    } finally {
      setLoggingOut(false);
    }
  }, [refresh, t]);

  // HARD reset (§2b): wipe local entitlement/registration/license-wire + revoke
  // the session, then reload so ProtectedLayout's useEntitlementGate re-reads the
  // now-`unregistered` state and the RegistrationGate renders. The reload is the
  // cross-tree re-gate trigger (the gate hook lives in ProtectedLayout, not here).
  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      const response = await commandEve.entitlementReset.invoke();
      if (response.data?.ok) {
        // Re-mount the app so the entitlement gate re-evaluates from scratch.
        if (typeof window !== 'undefined' && window.location) {
          window.location.reload();
          return;
        }
        await refresh();
      } else {
        Message.error(t('settings.accountPanel.resetError', { defaultValue: 'Zurücksetzen fehlgeschlagen.' }));
      }
    } catch {
      Message.error(t('settings.accountPanel.resetError', { defaultValue: 'Zurücksetzen fehlgeschlagen.' }));
    } finally {
      setResetting(false);
    }
  }, [refresh, t]);

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      await commandEve.authWebLogin.invoke({ intent: 'login' });
      await refresh();
    } catch {
      // self-quiet; the gate / avatar reflect the real state
    } finally {
      setLoggingIn(false);
    }
  }, [refresh]);

  const signedIn = Boolean(info?.has_session);

  return (
    <div className='flex flex-col gap-16px max-w-640px' data-testid='account-settings'>
      <Card title={t('settings.accountPanel.title', { defaultValue: 'Account' })}>
        {signedIn ? (
          <div className='flex flex-col gap-12px'>
            <div className='flex items-center justify-between gap-8px'>
              <span className='text-13px text-t-tertiary'>{t('settings.accountPanel.signedInAs')}</span>
              {!editing ? (
                <Button
                  size='mini'
                  type='text'
                  onClick={beginEdit}
                  data-testid='account-edit'
                >
                  {t('settings.accountPanel.edit', { defaultValue: 'Bearbeiten' })}
                </Button>
              ) : null}
            </div>

            {editing ? (
              <>
                {/* Name + Firma are EDITABLE and persisted to the local registration
                    record via command-eve.registration-update (1.2.13). */}
                <div className='flex flex-col gap-4px'>
                  <span className='text-t-tertiary text-12px'>{t('settings.accountPanel.name')}</span>
                  <Input
                    value={draftName}
                    onChange={setDraftName}
                    disabled={savingProfile}
                    data-testid='account-name-input'
                  />
                </div>
                <div className='flex flex-col gap-4px'>
                  <span className='text-t-tertiary text-12px'>{t('settings.accountPanel.company')}</span>
                  <Input
                    value={draftCompany}
                    onChange={setDraftCompany}
                    disabled={savingProfile}
                    data-testid='account-company-input'
                  />
                </div>
                {/* E-Mail stays read-only: it is the login identity. Changing it is a
                    separate auth flow (Supabase email change) — flagged, not faked. */}
                {info?.email ? (
                  <div className='flex flex-col gap-4px'>
                    <span className='text-t-tertiary text-12px'>{t('settings.accountPanel.email')}</span>
                    <Input value={info.email} disabled data-testid='account-email' />
                    <span className='text-11px text-t-tertiary'>
                      {t('settings.accountPanel.emailLocked', {
                        defaultValue: 'E-Mail-Adresse ändern ist eine separate Anmelde-Funktion (folgt).',
                      })}
                    </span>
                  </div>
                ) : null}
                <div className='flex gap-8px'>
                  <Button
                    type='primary'
                    shape='round'
                    loading={savingProfile}
                    onClick={() => void handleSaveProfile()}
                    data-testid='account-save'
                  >
                    {savingProfile
                      ? t('settings.accountPanel.saving', { defaultValue: 'Wird gespeichert …' })
                      : t('settings.accountPanel.save', { defaultValue: 'Speichern' })}
                  </Button>
                  <Button
                    shape='round'
                    disabled={savingProfile}
                    onClick={() => setEditing(false)}
                    data-testid='account-cancel-edit'
                  >
                    {t('settings.accountPanel.cancel', { defaultValue: 'Abbrechen' })}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {info?.name ? (
                  <div className='flex justify-between gap-8px'>
                    <span className='text-t-tertiary'>{t('settings.accountPanel.name')}</span>
                    <span className='text-t-primary font-[500]' data-testid='account-name'>
                      {info.name}
                    </span>
                  </div>
                ) : null}
                {info?.email ? (
                  <div className='flex justify-between gap-8px'>
                    <span className='text-t-tertiary'>{t('settings.accountPanel.email')}</span>
                    <span className='text-t-primary font-[500]' data-testid='account-email'>
                      {info.email}
                    </span>
                  </div>
                ) : null}
                {info?.company ? (
                  <div className='flex justify-between gap-8px'>
                    <span className='text-t-tertiary'>{t('settings.accountPanel.company')}</span>
                    <span className='text-t-primary font-[500]'>{info.company}</span>
                  </div>
                ) : null}
              </>
            )}

            {/* v1.6 Slice 3 — de-escalated: the SOFT sign-out (session only; license
                + registration stay, the app keeps working) is a neutral button so
                it no longer reads like the destructive twin of the device reset
                below. Only the hard reset keeps danger + confirm. */}
            <Button
              shape='round'
              loading={loggingOut}
              onClick={() => void handleLogout()}
              data-testid='account-logout'
            >
              {loggingOut
                ? t('settings.accountPanel.loggingOut')
                : t('settings.accountPanel.logoutSoft', { defaultValue: 'Von diesem Mac abmelden' })}
            </Button>
            <span className='text-12px text-t-tertiary'>{t('settings.accountPanel.logoutHint')}</span>

            <Popconfirm
              focusLock
              title={t('settings.accountPanel.resetConfirmTitle', {
                defaultValue: 'Gerät zurücksetzen?',
              })}
              content={t('settings.accountPanel.resetConfirmBody', {
                defaultValue:
                  'Entfernt Lizenz, Registrierung und Anmeldung von diesem Gerät. Du landest wieder auf der Registrierung und musst dich neu anmelden.',
              })}
              okText={t('settings.accountPanel.resetConfirmOk', { defaultValue: 'Zurücksetzen' })}
              cancelText={t('settings.accountPanel.resetConfirmCancel', { defaultValue: 'Abbrechen' })}
              onOk={() => void handleReset()}
            >
              <Button
                status='danger'
                type='outline'
                shape='round'
                loading={resetting}
                data-testid='account-reset'
              >
                {resetting
                  ? t('settings.accountPanel.resetting', { defaultValue: 'Wird zurückgesetzt …' })
                  : t('settings.accountPanel.reset', { defaultValue: 'Abmelden & Gerät zurücksetzen' })}
              </Button>
            </Popconfirm>
            <span className='text-12px text-t-tertiary'>
              {t('settings.accountPanel.resetHint', {
                defaultValue:
                  'Setzt dieses Gerät vollständig zurück (Lizenz + Registrierung) und führt zur Registrierung zurück.',
              })}
            </span>
          </div>
        ) : (
          <div className='flex flex-col gap-12px'>
            <div className='text-13px text-t-tertiary' data-testid='account-not-signed-in'>
              {t('settings.accountPanel.notSignedIn')}
            </div>
            {info?.email ? (
              <div className='flex justify-between gap-8px'>
                <span className='text-t-tertiary'>{t('settings.accountPanel.email')}</span>
                <span className='text-t-primary font-[500]'>{info.email}</span>
              </div>
            ) : null}
            <Button
              type='primary'
              shape='round'
              loading={loggingIn}
              onClick={() => void handleLogin()}
              data-testid='account-login'
            >
              {t('settings.accountPanel.login')}
            </Button>
          </div>
        )}
      </Card>

      {/* EVE Cloud (license-wire) status + re-activation. Only surfaced when the
          bearer is DEFINITIVELY absent (`=== false`) so an entitled-but-bearer-less
          device can re-store the cloud credential without a full reset. */}
      {bearer === false ? (
        <Card title={t('settings.accountPanel.eveCloud.title', { defaultValue: 'EVE Cloud' })}>
          <div className='flex flex-col gap-12px'>
            <div className='text-13px text-t-tertiary' data-testid='eve-cloud-needs-activation'>
              {t('settings.accountPanel.eveCloud.inactiveBody', {
                defaultValue:
                  'EVE Cloud ist nicht aktiviert — Anfragen laufen aktuell lokal & privat auf deinem Gerät. Hinterlege deinen Lizenzcode erneut, um die EVE-Cloud (mehr Intelligenz, großer Kontext) zu nutzen. Dein Gerät wird dabei NICHT zurückgesetzt.',
              })}
            </div>
            <Input.TextArea
              value={licenseCode}
              onChange={setLicenseCode}
              placeholder={t('settings.accountPanel.eveCloud.codePlaceholder', {
                defaultValue: 'Lizenzcode einfügen …',
              })}
              autoSize={{ minRows: 2, maxRows: 4 }}
              data-testid='eve-cloud-code'
            />
            <Button
              type='primary'
              shape='round'
              loading={activating}
              disabled={licenseCode.trim().length === 0}
              onClick={() => void handleActivateCloud()}
              data-testid='eve-cloud-activate'
            >
              {activating
                ? t('settings.accountPanel.eveCloud.activating', { defaultValue: 'Wird aktiviert …' })
                : t('settings.accountPanel.eveCloud.activate', { defaultValue: 'EVE Cloud aktivieren' })}
            </Button>
          </div>
        </Card>
      ) : bearer === true ? (
        <Card title={t('settings.accountPanel.eveCloud.title', { defaultValue: 'EVE Cloud' })}>
          <div className='text-13px text-t-tertiary' data-testid='eve-cloud-active'>
            {t('settings.accountPanel.eveCloud.activeBody', {
              defaultValue: 'EVE Cloud ist aktiviert — die Cloud-Modelle stehen zur Verfügung.',
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
};

export default AccountModalContent;
