import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { useEntitlementGate } from '@renderer/hooks/useEntitlementGate';
import { isElectronDesktop } from '@renderer/utils/platform';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import { isDayZeroForcePopEnabled } from '@/common/config/commandEveShell';
const Conversation = React.lazy(() => import('@renderer/pages/conversation'));
const Guid = React.lazy(() => import('@renderer/pages/guid'));
// 1.2.18 — Agenten + Assistenten + Dein Team merged into the single EVE-Runtime
// settings page. The old AgentSettings/AssistantSettings/DeinTeamPage routes now
// redirect here (their components still exist; EVE-Runtime embeds their bodies).
const EveRuntimeSettings = React.lazy(() => import('@renderer/pages/settings/EveRuntime/EveRuntimeSettings'));
const CapabilitiesSettings = React.lazy(() => import('@renderer/pages/settings/CapabilitiesSettings'));
const AppearanceSettings = React.lazy(() => import('@renderer/pages/settings/AppearanceSettings'));
const ModeSettings = React.lazy(() => import('@renderer/pages/settings/ModeSettings'));
const SystemSettings = React.lazy(() => import('@renderer/pages/settings/SystemSettings'));
const BillingSettings = React.lazy(() => import('@renderer/pages/settings/BillingSettings'));
const CompanyBrainSettings = React.lazy(() => import('@renderer/pages/settings/CompanyBrainSettings'));
const AccountSettings = React.lazy(() => import('@renderer/pages/settings/AccountSettings'));
const PrivacySettings = React.lazy(() => import('@renderer/pages/settings/PrivacySettings'));
const WebuiSettings = React.lazy(() => import('@renderer/pages/settings/WebuiSettings'));
const PetSettings = React.lazy(() => import('@renderer/pages/settings/PetSettings'));
const ExtensionSettingsPage = React.lazy(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const LoginPage = React.lazy(() => import('@renderer/pages/login'));
const ComponentsShowcase = React.lazy(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));
const TeamIndex = React.lazy(() => import('@renderer/pages/team'));
const CommandCenterPage = React.lazy(() => import('@renderer/pages/commandCenter'));
const KanbanBoardPage = React.lazy(() => import('@renderer/pages/kanban'));
const ConnectorCatalogPage = React.lazy(() => import('@renderer/pages/connectorCatalog'));
const LocalRuntimePage = React.lazy(() => import('@renderer/pages/localRuntime'));
const RegistrationGatePage = React.lazy(() => import('@renderer/pages/registrationGate'));
const DayZeroOnboardingHost = React.lazy(() => import('@renderer/components/billing/DayZeroOnboardingHost'));

const withRouteFallback = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={<AppLoader />}>
    <Component />
  </Suspense>
);

export const ProtectedLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();
  const { loading: gateLoading, status: gateStatus, blocked: gateBlocked, refresh: refreshGate } = useEntitlementGate();
  // The active seat id — stable on a single-seat/legacy install, and updated by
  // the switch lifecycle (configService.rebindSeat) on every admin seat switch.
  const activeSeatId = useActiveSeatId();

  if (status === 'checking' || gateLoading) {
    return <AppLoader />;
  }

  // Command EVE registration + license gate (W12) — checked FIRST. The gate is a
  // STRUCTURAL guard: while it is required and not entitled, it replaces the
  // protected layout entirely, so every protected route — including the index
  // redirect and the `*` catch-all — renders the gate (web login/register) instead
  // of any main surface. No route, deep link, or window reopen can reach a main
  // surface from here. It is fail-closed + E2E-proven, and on the Electron desktop
  // it is the SOLE source of truth, so it precedes the auth-status redirect below.
  if (gateBlocked) {
    return (
      <Suspense fallback={<AppLoader />}>
        <RegistrationGatePage status={gateStatus} onEntitled={refreshGate} />
      </Suspense>
    );
  }

  // Auth-status backstop — WebUI ONLY. On the Electron desktop there is no web
  // /login surface (the entitlement gate above IS the login), and desktop `status`
  // is honest (entitlement-derived) but must NOT act as a second, independently-
  // disagreeing redirect — that would risk a /login <-> /guid loop on a
  // momentarily-stale status. So this redirect is scoped to non-desktop builds.
  if (!isElectronDesktop() && status !== 'authenticated') {
    return <Navigate to='/login' replace />;
  }

  // Entitled: render the main layout. Mount the Day-0 onboarding host alongside
  // it — it self-quiets unless this is a first run with no Company-Brain seed.
  //
  // SEAT-REMOUNT BOUNDARY: key the per-seat host by the active seat id. The host's
  // useDayZeroOnboarding seeds its seat-scoped state (alreadySeeded from on-disk
  // evidence, dismissed from the seat-scoped config) in a MOUNT-ONCE effect and
  // does not subscribe to configService — so without a remount it would keep
  // serving the PRIOR seat's onboarding state after an admin switches seats. The
  // key REMOUNTS it on a switch, re-firing every mount-once seat read under the
  // new seat. On a single-seat/legacy install the id is stable, so this is a
  // no-op remount (byte-identical to 1.1.3). This is the general fix: any future
  // per-seat host placed here inherits the same correct re-read on a switch.
  return (
    <>
      {React.cloneElement(layout)}
      {/* v1.6 Slice 4 (Day-Zero-Soft-Fold): in Command-EVE builds the forced
          modal stays OFF — the chat greeting collects the brief and EVE mirrors
          it (Beat 1). All persistence seams + the Settings manual path survive;
          upstream builds keep the modal. */}
      {isDayZeroForcePopEnabled() ? (
        <Suspense fallback={null}>
          <DayZeroOnboardingHost key={activeSeatId} entitled />
        </Suspense>
      ) : null}
    </>
  );
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();

  return (
    <HashRouter>
      <Routes>
        <Route
          path='/login'
          element={
            // Desktop has no web /login surface — the entitlement gate (rendered by
            // ProtectedLayout on /guid) is the login. Send desktop to /guid so the
            // gate decides; WebUI keeps the real LoginPage when unauthenticated.
            isElectronDesktop() || status === 'authenticated' ? <Navigate to='/guid' replace /> : withRouteFallback(LoginPage)
          }
        />
        <Route element={<ProtectedLayout layout={layout} />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          <Route
            path='/team/:id'
            element={TEAM_MODE_ENABLED ? withRouteFallback(TeamIndex) : <Navigate to='/guid' replace />}
          />
          <Route path='/settings/model' element={withRouteFallback(ModeSettings)} />
          <Route path='/settings/eve-runtime' element={withRouteFallback(EveRuntimeSettings)} />
          {/* 1.2.18 — Agenten + Assistenten merged into EVE-Runtime; redirect old deep-links/bookmarks. */}
          <Route path='/settings/assistants' element={<Navigate to='/settings/eve-runtime' replace />} />
          <Route path='/settings/agent' element={<Navigate to='/settings/eve-runtime' replace />} />
          <Route path='/settings/capabilities' element={withRouteFallback(CapabilitiesSettings)} />
          {/* 1.2.18 — Connectoren + Runtime moved from the main sidebar into Settings. */}
          <Route path='/settings/connectors' element={withRouteFallback(ConnectorCatalogPage)} />
          <Route path='/settings/runtime' element={withRouteFallback(LocalRuntimePage)} />
          {/* Legacy routes — redirect to the merged /settings/capabilities page */}
          <Route path='/settings/skills-hub' element={<Navigate to='/settings/capabilities?tab=skills' replace />} />
          <Route path='/settings/tools' element={<Navigate to='/settings/capabilities?tab=tools' replace />} />
          <Route path='/settings/appearance' element={withRouteFallback(AppearanceSettings)} />
          <Route path='/settings/display' element={<Navigate to='/settings/appearance' replace />} />
          <Route path='/settings/webui' element={withRouteFallback(WebuiSettings)} />
          <Route path='/settings/pet' element={withRouteFallback(PetSettings)} />
          <Route path='/settings/system' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/billing' element={withRouteFallback(BillingSettings)} />
          <Route path='/settings/company-brain' element={withRouteFallback(CompanyBrainSettings)} />
          <Route path='/settings/account' element={withRouteFallback(AccountSettings)} />
          <Route path='/settings/about' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/privacy' element={withRouteFallback(PrivacySettings)} />
          <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
          <Route path='/settings' element={<Navigate to='/settings/model' replace />} />
          <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
          <Route path='/command-center' element={withRouteFallback(CommandCenterPage)} />
          <Route path='/kanban' element={withRouteFallback(KanbanBoardPage)} />
          {/* 1.2.18 — old standalone routes now redirect into Settings (bookmark-safe). */}
          <Route path='/connectors' element={<Navigate to='/settings/connectors' replace />} />
          <Route path='/skills' element={<Navigate to='/settings/capabilities?tab=skills' replace />} />
          <Route path='/runtime' element={<Navigate to='/settings/runtime' replace />} />
          <Route path='/team-roster' element={<Navigate to='/settings/eve-runtime' replace />} />
        </Route>
        <Route path='*' element={<Navigate to={isElectronDesktop() || status === 'authenticated' ? '/guid' : '/login'} replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;
