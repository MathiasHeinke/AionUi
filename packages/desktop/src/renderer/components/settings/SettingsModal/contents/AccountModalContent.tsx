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
import { Button, Input, Message, Popconfirm, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { commandEve, type ICommandEveRegistrationStatusResult } from '@/common/adapter/ipcBridge';
import { refreshCommandEveProfile } from '@/renderer/components/account/useCommandEveProfile';
import { useSeatAccess } from '@/renderer/hooks/useSeatAccess';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';

const AccountModalContent: React.FC = () => {
  const { t } = useTranslation();
  const { access, refresh: refreshSeeds } = useSeatAccess();
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
  // Seed display name is an independent server field (tenants.name). This path
  // never calls registrationUpdate and therefore cannot rename the Account.
  const [editingSeed, setEditingSeed] = useState(false);
  const [savingSeed, setSavingSeed] = useState(false);
  const [draftSeedName, setDraftSeedName] = useState('');
  const activeSeed = access.seats.find((seat) => seat.seat_id === access.activeSeatId) ?? null;

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
      Message.error(
        t('settings.accountPanel.fieldsRequired', { defaultValue: 'Name und Firma dürfen nicht leer sein.' })
      );
      return;
    }
    setSavingProfile(true);
    try {
      const response = await commandEve.registrationUpdate.invoke({ name, company });
      if (response.data?.ok) {
        await refresh();
        // Same-session chrome (GuidPage greeting, SiderFooter, ProfileAvatar) reads the shared store.
        await refreshCommandEveProfile();
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

  const beginSeedEdit = useCallback(() => {
    setDraftSeedName(activeSeed?.name ?? '');
    setEditingSeed(true);
  }, [activeSeed?.name]);

  const handleSaveSeed = useCallback(async () => {
    const displayName = draftSeedName.trim();
    if (!activeSeed?.seat_id || !displayName) {
      Message.error(
        t('settings.accountPanel.seed.nameRequired', { defaultValue: 'Der Seed-Name darf nicht leer sein.' })
      );
      return;
    }
    setSavingSeed(true);
    try {
      const response = await commandEve.seedRename.invoke({ seedId: activeSeed.seat_id, displayName });
      if (response.data?.ok) {
        await refreshSeeds();
        setEditingSeed(false);
        Message.success(t('settings.accountPanel.seed.saved', { defaultValue: 'Seed-Name gespeichert.' }));
      } else {
        Message.error(
          t('settings.accountPanel.seed.saveError', { defaultValue: 'Seed-Name konnte nicht gespeichert werden.' })
        );
      }
    } catch {
      Message.error(
        t('settings.accountPanel.seed.saveError', { defaultValue: 'Seed-Name konnte nicht gespeichert werden.' })
      );
    } finally {
      setSavingSeed(false);
    }
  }, [activeSeed?.seat_id, draftSeedName, refreshSeeds, t]);

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
        Message.success(t('settings.accountPanel.eveCloud.activated', { defaultValue: 'EVE Cloud aktiviert.' }));
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
        await refreshCommandEveProfile();
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
      await refreshCommandEveProfile();
    } catch {
      // self-quiet; the gate / avatar reflect the real state
    } finally {
      setLoggingIn(false);
    }
  }, [refresh]);

  const signedIn = Boolean(info?.has_session);

  return (
    <div className='eve-account-settings' data-testid='account-settings'>
      <SettingsPageHeader
        title={t('settings.accountPanel.title', { defaultValue: 'Konto' })}
        description={t('settings.accountPanel.pageDescription', {
          defaultValue: 'Verwalte dein lokales Profil, deine Anmeldung und den Zugriff auf EVE Cloud.',
        })}
      />

      <SettingsSection
        title={t('settings.accountPanel.profileTitle', { defaultValue: 'Profil' })}
        description={t('settings.accountPanel.profileDescription', {
          defaultValue: 'Deine Identität für Command EVE auf diesem Gerät.',
        })}
        action={
          signedIn && !editing ? (
            <Button size='small' type='text' onClick={beginEdit} data-testid='account-edit'>
              {t('settings.accountPanel.edit', { defaultValue: 'Bearbeiten' })}
            </Button>
          ) : undefined
        }
        bodyClassName={editing ? 'eve-settings-form' : 'eve-settings-list'}
      >
        {signedIn ? (
          editing ? (
            <>
              <label className='eve-settings-field'>
                <span>{t('settings.accountPanel.name')}</span>
                <Input
                  value={draftName}
                  onChange={setDraftName}
                  disabled={savingProfile}
                  data-testid='account-name-input'
                />
              </label>
              <label className='eve-settings-field'>
                <span>{t('settings.accountPanel.company')}</span>
                <Input
                  value={draftCompany}
                  onChange={setDraftCompany}
                  disabled={savingProfile}
                  data-testid='account-company-input'
                />
              </label>
              {info?.email ? (
                <label className='eve-settings-field'>
                  <span>{t('settings.accountPanel.email')}</span>
                  <Input value={info.email} disabled data-testid='account-email' />
                  <small>
                    {t('settings.accountPanel.emailLocked', {
                      defaultValue: 'E-Mail-Adresse ändern ist eine separate Anmelde-Funktion (folgt).',
                    })}
                  </small>
                </label>
              ) : null}
              <div className='eve-settings-form-actions'>
                <Button
                  type='primary'
                  loading={savingProfile}
                  onClick={() => void handleSaveProfile()}
                  data-testid='account-save'
                >
                  {savingProfile
                    ? t('settings.accountPanel.saving', { defaultValue: 'Wird gespeichert …' })
                    : t('settings.accountPanel.save', { defaultValue: 'Speichern' })}
                </Button>
                <Button disabled={savingProfile} onClick={() => setEditing(false)} data-testid='account-cancel-edit'>
                  {t('settings.accountPanel.cancel', { defaultValue: 'Abbrechen' })}
                </Button>
              </div>
            </>
          ) : (
            <>
              {info?.name ? (
                <PreferenceRow label={t('settings.accountPanel.name')}>
                  <span className='eve-settings-value' data-testid='account-name'>
                    {info.name}
                  </span>
                </PreferenceRow>
              ) : null}
              {info?.email ? (
                <PreferenceRow label={t('settings.accountPanel.email')} stackOnMobile>
                  <span className='eve-settings-value' data-testid='account-email'>
                    {info.email}
                  </span>
                </PreferenceRow>
              ) : null}
              {info?.company ? (
                <PreferenceRow label={t('settings.accountPanel.company')}>
                  <span className='eve-settings-value'>{info.company}</span>
                </PreferenceRow>
              ) : null}
            </>
          )
        ) : (
          <div className='eve-settings-action-row'>
            <div>
              <p data-testid='account-not-signed-in'>{t('settings.accountPanel.notSignedIn')}</p>
              {info?.email ? <span className='eve-settings-value'>{info.email}</span> : null}
            </div>
            <Button type='primary' loading={loggingIn} onClick={() => void handleLogin()} data-testid='account-login'>
              {t('settings.accountPanel.login')}
            </Button>
          </div>
        )}
      </SettingsSection>

      {activeSeed ? (
        <SettingsSection
          title={t('settings.accountPanel.seed.title', { defaultValue: 'Dieser Seed' })}
          description={t('settings.accountPanel.seed.description', {
            defaultValue: 'Name und Einstellungen dieses Arbeitsraums. Dein Accountprofil bleibt unverändert.',
          })}
          action={
            access.role === 'admin' && !editingSeed ? (
              <Button size='small' type='text' onClick={beginSeedEdit} data-testid='seed-edit'>
                {t('settings.accountPanel.seed.edit', { defaultValue: 'Seed umbenennen' })}
              </Button>
            ) : undefined
          }
          bodyClassName={editingSeed ? 'eve-settings-form' : 'eve-settings-list'}
        >
          {editingSeed ? (
            <>
              <label className='eve-settings-field'>
                <span>{t('settings.accountPanel.seed.name', { defaultValue: 'Seed-Name' })}</span>
                <Input
                  value={draftSeedName}
                  maxLength={200}
                  onChange={setDraftSeedName}
                  disabled={savingSeed}
                  data-testid='seed-name-input'
                />
              </label>
              <div className='eve-settings-form-actions'>
                <Button
                  type='primary'
                  loading={savingSeed}
                  onClick={() => void handleSaveSeed()}
                  data-testid='seed-save'
                >
                  {savingSeed
                    ? t('settings.accountPanel.seed.saving', { defaultValue: 'Wird gespeichert …' })
                    : t('settings.accountPanel.seed.save', { defaultValue: 'Seed speichern' })}
                </Button>
                <Button disabled={savingSeed} onClick={() => setEditingSeed(false)} data-testid='seed-cancel-edit'>
                  {t('settings.accountPanel.cancel', { defaultValue: 'Abbrechen' })}
                </Button>
              </div>
            </>
          ) : (
            <PreferenceRow label={t('settings.accountPanel.seed.name', { defaultValue: 'Seed-Name' })}>
              <span className='eve-settings-value' data-testid='seed-name'>
                {activeSeed.name}
              </span>
            </PreferenceRow>
          )}
        </SettingsSection>
      ) : null}

      {signedIn ? (
        <SettingsSection
          title={t('settings.accountPanel.sessionTitle', { defaultValue: 'Anmeldung auf diesem Mac' })}
          description={t('settings.accountPanel.logoutHint')}
        >
          <div className='eve-settings-action-row'>
            <span className='eve-settings-muted'>
              {t('settings.accountPanel.sessionStatus', { defaultValue: 'Dieses Gerät ist angemeldet.' })}
            </span>
            <Button loading={loggingOut} onClick={() => void handleLogout()} data-testid='account-logout'>
              {loggingOut
                ? t('settings.accountPanel.loggingOut')
                : t('settings.accountPanel.logoutSoft', { defaultValue: 'Von diesem Mac abmelden' })}
            </Button>
          </div>
        </SettingsSection>
      ) : null}

      {/* EVE Cloud (license-wire) status + re-activation. Only surfaced after the
          bearer state is known; re-activation never resets the device. */}
      {bearer !== undefined ? (
        <SettingsSection
          title={t('settings.accountPanel.eveCloud.title', { defaultValue: 'EVE Cloud' })}
          action={
            <Tag color={bearer ? 'green' : 'gold'}>
              {bearer
                ? t('settings.accountPanel.eveCloud.activeStatus', { defaultValue: 'Aktiv' })
                : t('settings.accountPanel.eveCloud.inactiveStatus', { defaultValue: 'Nicht aktiviert' })}
            </Tag>
          }
        >
          {bearer ? (
            <p className='eve-settings-muted' data-testid='eve-cloud-active'>
              {t('settings.accountPanel.eveCloud.activeBody', {
                defaultValue: 'EVE Cloud ist aktiviert — die Cloud-Modelle stehen zur Verfügung.',
              })}
            </p>
          ) : (
            <div className='eve-settings-form' data-testid='eve-cloud-needs-activation'>
              <p className='eve-settings-muted'>
                {t('settings.accountPanel.eveCloud.inactiveBody', {
                  defaultValue:
                    'EVE Cloud ist nicht aktiviert — Anfragen laufen aktuell lokal & privat auf deinem Gerät. Hinterlege deinen Lizenzcode erneut, um die EVE-Cloud (mehr Intelligenz, großer Kontext) zu nutzen. Dein Gerät wird dabei NICHT zurückgesetzt.',
                })}
              </p>
              <Input.TextArea
                value={licenseCode}
                onChange={setLicenseCode}
                placeholder={t('settings.accountPanel.eveCloud.codePlaceholder', {
                  defaultValue: 'Lizenzcode einfügen …',
                })}
                autoSize={{ minRows: 2, maxRows: 4 }}
                data-testid='eve-cloud-code'
              />
              <div className='eve-settings-form-actions'>
                <Button
                  type='primary'
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
            </div>
          )}
        </SettingsSection>
      ) : null}

      {signedIn ? (
        <SettingsSection
          title={t('settings.accountPanel.deviceResetTitle', { defaultValue: 'Gerät zurücksetzen' })}
          description={t('settings.accountPanel.resetHint', {
            defaultValue:
              'Setzt dieses Gerät vollständig zurück (Lizenz + Registrierung) und führt zur Registrierung zurück.',
          })}
        >
          <div className='eve-settings-action-row'>
            <span className='eve-settings-muted'>
              {t('settings.accountPanel.deviceResetWarning', {
                defaultValue: 'Diese Aktion entfernt alle lokalen Vertrauensnachweise von diesem Mac.',
              })}
            </span>
            <Popconfirm
              focusLock
              title={t('settings.accountPanel.resetConfirmTitle', { defaultValue: 'Gerät zurücksetzen?' })}
              content={t('settings.accountPanel.resetConfirmBody', {
                defaultValue:
                  'Entfernt Lizenz, Registrierung und Anmeldung von diesem Gerät. Du landest wieder auf der Registrierung und musst dich neu anmelden.',
              })}
              okText={t('settings.accountPanel.resetConfirmOk', { defaultValue: 'Zurücksetzen' })}
              cancelText={t('settings.accountPanel.resetConfirmCancel', { defaultValue: 'Abbrechen' })}
              onOk={() => void handleReset()}
            >
              <Button status='danger' type='outline' loading={resetting} data-testid='account-reset'>
                {resetting
                  ? t('settings.accountPanel.resetting', { defaultValue: 'Wird zurückgesetzt …' })
                  : t('settings.accountPanel.reset', { defaultValue: 'Abmelden & Gerät zurücksetzen' })}
              </Button>
            </Popconfirm>
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
};

export default AccountModalContent;
