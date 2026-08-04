import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import type { ProjectIntentPlan } from '@/common/types/project-workspace/intent';
import type { ProjectCatalogRecord, RealmRecord, RootRecord } from '@/common/types/project-workspace/registry';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import type {
  ProjectWorkspaceI18nRef,
  ProjectPlacementDTO,
  ProjectSummaryDTO,
  ProjectWorkspaceAction,
  ProjectWorkspaceArtifactDTO,
  ProjectWorkspaceConversationArtifactDTO,
  ProjectWorkspaceEnsureAutoProjectRequest,
  ProjectWorkspaceEnsureAutoProjectResult,
  ProjectWorkspaceExplicitChatIntentRequest,
  ProjectWorkspaceExplicitChatIntentResult,
  ProjectWorkspaceListDTO,
  ProjectWorkspacePreviewDTO,
  ProjectWorkspaceReceiptDTO,
  ProjectWorkspaceRealmKind,
  ProjectWorkspaceRecoveryState,
  ProjectWorkspaceStatus,
  ProjectWorkspaceUiReasonCode,
} from '@/common/types/project-workspace/ui';
import type { ProjectWorkspaceLifecycleService } from './ProjectWorkspaceLifecycleService';
import type { ProjectCreateResult, ProjectWorkspaceService } from './ProjectWorkspaceService';
import { matchConversationCandidates, resolveProjectIntent } from './core/intentCore';
import { mapProjectWorkspaceReason } from './core/lifecycleReasonCore';
import type {
  ProjectConversationMetadata,
  ProjectConversationMetadataClient,
} from './runtime/conversationBindingClient';
import { ensureProjectWorkspaceSeatBootstrap } from './seatBootstrap';
import type { ProjectWorkspaceConversationArtifactStore } from './storage/conversationArtifactStore';
import type { ProjectWorkspaceRegistryStore } from './storage/registryStore';
import { PROJECT_SCAFFOLD_DIRECTORIES } from './templates/scaffold';

/**
 * S81/R1b — main-side facade behind the renderer's 15-method project workspace
 * client contract (renderer/pages/projects/client.tsx).
 *
 * SECURITY DOCTRINE:
 *  - DTOs and receipts that cross the IPC boundary are PATH-FREE. Absolute
 *    paths (canonical_project_path, receipt paths) are resolved main-side from
 *    the trusted registry and never leave this module.
 *  - Mutation plans are ALWAYS re-derived main-side via resolveProjectIntent
 *    from the trusted seat catalogs. The renderer only transports opaque
 *    preview handles (preview_id + preview_revision); any plan fields it may
 *    forge are ignored by construction.
 *  - Every mutation asserts the seat context revision against the main-owned
 *    counter; a stale renderer snapshot fails closed with `seat.changed`.
 */

/** Preview stash TTL (5 minutes) — a preview is a bounded snapshot, not a lease. */
const DEFAULT_PREVIEW_TTL_MS = 300_000;

/**
 * Synthetic conversation id for UI-driven creates. The service requires a
 * valid conversation id on the plan; UI creates are not conversation-bound, so
 * the facade pins a constant, regex-valid sentinel instead of trusting input.
 */
const UI_CONVERSATION_ID = 'project-workspace-ui';

/**
 * 1.820.4 (MAT-1772) — post-turn auto-project policy constants. The ONLY
 * placement an autonomous create may use: the seat's single app-managed
 * default BUSINESS realm (`geschaeftlich`, seeded by seatBootstrap) with
 * exactly one active app-managed root. Missing or ambiguous → fail closed.
 */
const AUTO_PROJECT_BUSINESS_REALM_SLUG = 'geschaeftlich';
/** Bounded local metadata re-reads while the persisted title is still default. */
const AUTO_PROJECT_TITLE_REREAD_COUNT = 2;
const AUTO_PROJECT_TITLE_REREAD_DELAY_MS = 750;

/** Every shipped locale's `conversation.welcome.newConversation` default title. */
const AUTO_PROJECT_DEFAULT_TITLES = new Set([
  'neuer chat',
  'new chat',
  'novo chat',
  'yeni sohbet',
  'новий чат',
  'новый чат',
  '新しいチャット',
  '新会话',
  '新會話',
  '새 채팅',
]);

/**
 * A greeting-only first message never became a durable task title. Conservative
 * on purpose: anything beyond a bare greeting word (+ punctuation) counts as a
 * real title, and every other ambiguity is settled by the bounded re-reads.
 */
const GREETING_ONLY_TITLE =
  /^(hi+|hello|hey|hallo|servus|moin|na|salut|bonjour|hola|ciao|ol[áa]|hei|hej|привет|privet|merhaba|こんにちは|안녕(하세요)?|你好|您好|guten\s+(tag|morgen|abend)|good\s+(morning|afternoon|evening|day))[\s!?.。！？…]*$/i;

function isDefaultOrGreetingTitle(title: string): boolean {
  const normalized = title.trim().toLocaleLowerCase('en-US');
  if (!normalized) return true;
  if (AUTO_PROJECT_DEFAULT_TITLES.has(normalized)) return true;
  return GREETING_ONLY_TITLE.test(normalized);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type MutationIdentity = {
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  idempotency_key: string;
};

type PreviewStashEntry = {
  kind: 'create' | 'adopt';
  plan: ProjectIntentPlan;
  preview_revision: number;
  expires_at: number;
  directory?: string;
};

type ArtifactListener = {
  conversation_id: string;
  listener: (artifact: ProjectWorkspaceConversationArtifactDTO) => void;
};

export type ProjectWorkspaceFacadeDeps = {
  registry: ProjectWorkspaceRegistryStore;
  service: ProjectWorkspaceService;
  lifecycle: ProjectWorkspaceLifecycleService;
  artifact_store: ProjectWorkspaceConversationArtifactStore;
  binding_client: ProjectConversationMetadataClient;
  get_active_seat_id: () => string;
  get_active_seat_label: () => string;
  get_active_seat_context_revision: () => number;
  /** Optional seat-switch guard for the fail-open chat intent gate (S81/R3). */
  is_seat_switch_in_flight?: () => boolean;
  now_ms?: () => number;
  preview_ttl_ms?: number;
  /** Injectable for tests; delay between the bounded title re-reads. */
  auto_project_title_reread_delay_ms?: number;
  /** Injectable for tests; defaults to electron shell.showItemInFolder. */
  reveal_in_folder?: (absolutePath: string) => void;
};

function deterministicUuid(seed: string): string {
  const digest = Buffer.from(crypto.createHash('sha256').update(seed).digest().subarray(0, 16));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Realm-kind heuristic: realms carry no explicit kind, so the UI grouping is
 * derived from the (operator-chosen, lowercase-folded) realm label. German and
 * English vocabulary are both accepted ('privat'/'personal' → private,
 * 'geschaeft'/'geschäft'/'business'/'work' → business); anything else is
 * 'custom'. This is display-only — it never influences paths or authorization.
 */
function realmKind(label: string): ProjectWorkspaceRealmKind {
  // NFKD + strip combining marks so 'Geschäftlich' folds to 'geschaeftlich'
  // (same normalization family as the intent core's word matcher).
  const folded = label
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-US');
  if (folded.includes('privat') || folded.includes('personal')) return 'private';
  if (folded.includes('geschaft') || folded.includes('business') || folded.includes('work')) {
    return 'business';
  }
  return 'custom';
}

function projectStatus(record: ProjectCatalogRecord): ProjectWorkspaceStatus {
  return record.status;
}

function recoveryState(record: ProjectCatalogRecord): ProjectWorkspaceRecoveryState {
  return record.status === 'recovery_required' ? 'required' : 'none';
}

function allowedActions(record: ProjectCatalogRecord): ProjectWorkspaceAction[] {
  switch (record.status) {
    case 'active':
      return ['edit', 'archive', 'reveal', 'undo'];
    case 'archived':
      return ['restore', 'reveal'];
    case 'recovery_required':
      return ['recover'];
  }
}

export class ProjectWorkspaceFacade {
  private readonly nowMs: () => number;
  private readonly previewTtlMs: number;
  private readonly autoProjectTitleRereadDelayMs: number;
  private readonly revealInFolder: (absolutePath: string) => void;
  private readonly previews = new Map<string, PreviewStashEntry>();
  private readonly artifactListeners = new Set<ArtifactListener>();

  constructor(private readonly deps: ProjectWorkspaceFacadeDeps) {
    this.nowMs = deps.now_ms ?? Date.now;
    this.previewTtlMs = deps.preview_ttl_ms ?? DEFAULT_PREVIEW_TTL_MS;
    this.autoProjectTitleRereadDelayMs = deps.auto_project_title_reread_delay_ms ?? AUTO_PROJECT_TITLE_REREAD_DELAY_MS;
    this.revealInFolder = deps.reveal_in_folder ?? ((absolutePath) => shell.showItemInFolder(absolutePath));
  }

  /** Fail closed when the renderer snapshot predates the latest seat switch. */
  private assertSeat(seatContextRevision: number): void {
    if (this.deps.get_active_seat_context_revision() !== seatContextRevision) {
      throw new ProjectWorkspaceError('seat.changed');
    }
  }

  private trustedProjectRecord(seatId: string, projectId: string): ProjectCatalogRecord {
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    const record = catalogs.projects.projects.find((candidate) => candidate.project_id === projectId);
    if (!record) throw new ProjectWorkspaceError('root.not-found');
    return record;
  }

  private summaryFor(
    record: ProjectCatalogRecord,
    catalogs: { realms: { realms: RealmRecord[] }; roots: { roots: RootRecord[] } },
    revision: number,
    conversationCount: number
  ): ProjectSummaryDTO {
    const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === record.realm_id);
    const root = catalogs.roots.roots.find((candidate) => candidate.root_id === record.root_id);
    return {
      project_id: record.project_id,
      title: record.title,
      realm_kind: realmKind(realm?.label ?? ''),
      realm_label: realm?.label ?? '',
      root_label: root?.label ?? '',
      status: projectStatus(record),
      last_safe_update: Date.parse(record.registered_at),
      conversation_count: conversationCount,
      revision,
      recovery_state: recoveryState(record),
      allowed_actions: allowedActions(record),
    };
  }

  private placementId(realmId: string, rootId: string): string {
    return `${realmId}:${rootId}`;
  }

  private resolvePlacement(placementIdValue: string): { realm: RealmRecord; root: RootRecord } {
    const [realmId, rootId] = placementIdValue.split(':');
    if (!realmId || !rootId) throw new ProjectWorkspaceError('root.not-found');
    const catalogs = this.deps.registry.readSeatCatalogs(this.deps.get_active_seat_id());
    const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === realmId);
    const root = catalogs.roots.roots.find((candidate) => candidate.root_id === rootId);
    if (!realm || !root || realm.status !== 'active' || root.status !== 'active') {
      throw new ProjectWorkspaceError('root.not-found');
    }
    return { realm, root };
  }

  /** Re-derive the mutation plan main-side from trusted catalogs — never from renderer input. */
  private derivePlan(input: { placement_id: string; title: string; conversation_id: string }): ProjectIntentPlan {
    const seatId = this.deps.get_active_seat_id();
    const { realm, root } = this.resolvePlacement(input.placement_id);
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    const plan = resolveProjectIntent({
      conversation_id: input.conversation_id,
      snapshot: {
        seat_id: seatId,
        realm_id: realm.realm_id,
        root_id: root.root_id,
        workspace_root_ref: root.workspace_root_ref,
        realm_revision: catalogs.realms.revision,
        root_revision: catalogs.roots.revision,
        project_catalog_revision: catalogs.projects.revision,
      },
      title: input.title,
      confidence: 1,
      explicit_create: true,
      explicit_one_off: false,
      durable_signal_count: 0,
      ambiguous_scope: false,
      sensitive_root_choice: false,
      auto_create_requested: false,
      candidates: catalogs.projects.projects.map((record) => ({
        project_id: record.project_id,
        seat_id: record.seat_id,
        realm_id: record.realm_id,
        root_id: record.root_id,
        workspace_root_ref: record.workspace_root_ref,
        title: record.title,
        slug: record.slug,
        status: record.status,
      })),
      accepted_domain_ids: [],
      proposed_domain_labels: [],
    });
    if (plan.action !== 'create' || !plan.project_id) {
      throw new ProjectWorkspaceError('catalog.project-conflict');
    }
    return plan;
  }

  private stashPreview(entry: Omit<PreviewStashEntry, 'preview_revision' | 'expires_at'>): string {
    const previewId = deterministicUuid(`${this.deps.get_active_seat_id()}\0${entry.plan.title}\0${this.nowMs()}`);
    this.previews.set(previewId, {
      ...entry,
      preview_revision: 1,
      expires_at: this.nowMs() + this.previewTtlMs,
    });
    return previewId;
  }

  private takeStashedPreview(
    previewId: string,
    expectedPreviewRevision: number,
    idempotencyKey: string,
    kind: PreviewStashEntry['kind']
  ): { entry: PreviewStashEntry } | { receipt: ProjectWorkspaceReceiptDTO } {
    const entry = this.previews.get(previewId);
    const stale =
      !entry ||
      entry.kind !== kind ||
      entry.expires_at < this.nowMs() ||
      entry.preview_revision !== expectedPreviewRevision;
    if (stale) {
      this.previews.delete(previewId);
      return { receipt: this.rejectedReceipt(idempotencyKey, 'stale_snapshot') };
    }
    this.previews.delete(previewId);
    return { entry };
  }

  private rejectedReceipt(receiptId: string, reasonCode: ProjectWorkspaceUiReasonCode): ProjectWorkspaceReceiptDTO {
    return {
      receipt_id: receiptId,
      outcome: 'rejected',
      completed_at: this.nowMs(),
      reason_code: reasonCode,
      safe_follow_ups: [],
    };
  }

  private createResultReceipt(result: ProjectCreateResult, fallbackReceiptId: string): ProjectWorkspaceReceiptDTO {
    if (result.ok === false) {
      return {
        receipt_id: fallbackReceiptId,
        outcome: result.recovery_required ? 'recovery_required' : 'rejected',
        completed_at: this.nowMs(),
        reason_code: mapProjectWorkspaceReason(result.reason_code),
        safe_follow_ups: result.recovery_required ? ['recover'] : [],
      };
    }
    const seatId = this.deps.get_active_seat_id();
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    const record = catalogs.projects.projects.find(
      (candidate) => candidate.canonical_project_path === result.project_path
    );
    return {
      receipt_id: result.transaction_id,
      outcome: 'completed',
      completed_at: this.nowMs(),
      ...(record ? { project: this.summaryFor(record, catalogs, catalogs.projects.revision, 0) } : {}),
      safe_follow_ups: ['reveal'],
    };
  }

  async list(): Promise<ProjectWorkspaceListDTO> {
    const seatId = this.deps.get_active_seat_id();
    // Lazy seat bootstrap (same idempotent seed as the bridge init): a seat
    // restored or switched to after boot still gets its default realms/roots
    // on first list, so placements are always offerable.
    if (this.deps.registry.readSeatCatalogs(seatId).realms.realms.length === 0) {
      ensureProjectWorkspaceSeatBootstrap({
        registry: this.deps.registry,
        seat_id: seatId,
        data_path: path.dirname(this.deps.registry.stateRoot),
      });
    }
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    const conversationCountByProject = new Map<string, number>();
    try {
      for (const metadata of await this.deps.binding_client.listMetadata()) {
        const projectId = metadata.binding?.project_id;
        if (!projectId) continue;
        conversationCountByProject.set(projectId, (conversationCountByProject.get(projectId) ?? 0) + 1);
      }
    } catch (error) {
      // Conversation counts are enrichment, never a reason to fail the whole
      // list: a metadata backend failure (capability rotation, backend down)
      // must not blank the placements/projects UI.
      console.error('[ProjectWorkspace] list: metadata enrichment failed, returning counts as zero', error);
    }
    const placements: ProjectPlacementDTO[] = catalogs.roots.roots.flatMap((root) => {
      const realm = root.realm_id
        ? catalogs.realms.realms.find((candidate) => candidate.realm_id === root.realm_id)
        : undefined;
      if (!realm) return [];
      const writable = realm.status === 'active' && root.status === 'active';
      return [
        {
          placement_id: this.placementId(realm.realm_id, root.root_id),
          realm_kind: realmKind(realm.label),
          realm_label: realm.label,
          root_label: root.label,
          writable,
          ...(writable ? {} : { disabled_reason: 'root_conflict' as const }),
        },
      ];
    });
    const projects = catalogs.projects.projects.map((record) =>
      this.summaryFor(
        record,
        catalogs,
        catalogs.projects.revision,
        conversationCountByProject.get(record.project_id) ?? 0
      )
    );
    return {
      seat_label: this.deps.get_active_seat_label(),
      seat_context_revision: this.deps.get_active_seat_context_revision(),
      automatic_creation_enabled: this.isAutoProjectPolicyActive(),
      placements,
      projects,
    };
  }

  /**
   * 1.820.4 (MAT-1772) — the Projects UI truth source for "automatic creation".
   * It reports the NEW post-turn auto-project policy (`ensureAfterSuccessfulTurn`),
   * which is genuinely active exactly when its main-side dependencies are wired.
   * This is an explicit policy SEPARATION from the intent-core calibration
   * auto-create: `PROJECT_AUTO_CREATE_RELEASE_LOCKED` stays true and untouched
   * as historical/eval doctrine — the calibration code never gated this path.
   */
  private isAutoProjectPolicyActive(): boolean {
    return Boolean(this.deps.service && this.deps.lifecycle && this.deps.artifact_store && this.deps.binding_client);
  }

  async previewCreate(request: {
    placement_id: string;
    title: string;
    profile?: string;
    seat_context_revision: number;
  }): Promise<ProjectWorkspacePreviewDTO> {
    this.assertSeat(request.seat_context_revision);
    const title = request.title.trim();
    if (!title || title.length > 200) throw new ProjectWorkspaceError('identity.invalid');
    const plan = this.derivePlan({
      placement_id: request.placement_id,
      title,
      conversation_id: UI_CONVERSATION_ID,
    });
    const previewId = this.stashPreview({ kind: 'create', plan });
    const { realm, root } = this.resolvePlacement(request.placement_id);
    return {
      preview_id: previewId,
      preview_revision: 1,
      destination_label: `${realm.label} / ${root.label}`,
      project_title: plan.title,
      scaffold_summary: [...PROJECT_SCAFFOLD_DIRECTORIES],
      semantic_writes: [],
      conversation_effect: 'none',
      warnings: [],
      expires_at: this.nowMs() + this.previewTtlMs,
    };
  }

  async create(request: {
    preview_id: string;
    expected_preview_revision: number;
    seat_context_revision: number;
    idempotency_key: string;
  }): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    const stashed = this.takeStashedPreview(
      request.preview_id,
      request.expected_preview_revision,
      request.idempotency_key,
      'create'
    );
    if ('receipt' in stashed) return stashed.receipt;
    const result = await this.deps.service.create(stashed.entry.plan);
    return this.createResultReceipt(result, request.idempotency_key);
  }

  previewAdopt(request: { title?: string; seat_context_revision: number }): Promise<ProjectWorkspacePreviewDTO | null> {
    this.assertSeat(request.seat_context_revision);
    // Adoption requires an operator-selected directory which the renderer
    // contract does not transport; without a main-side directory there is
    // nothing trustworthy to preview, so the facade declines (null).
    return Promise.resolve(null);
  }

  async adopt(request: {
    preview_id: string;
    expected_preview_revision: number;
    seat_context_revision: number;
    idempotency_key: string;
  }): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    const stashed = this.takeStashedPreview(
      request.preview_id,
      request.expected_preview_revision,
      request.idempotency_key,
      'adopt'
    );
    if ('receipt' in stashed) return stashed.receipt;
    if (!stashed.entry.directory) return this.rejectedReceipt(request.idempotency_key, 'stale_snapshot');
    const result = await this.deps.service.adopt(stashed.entry.plan, stashed.entry.directory, true);
    return this.createResultReceipt(result, request.idempotency_key);
  }

  updateMetadata(request: MutationIdentity & { title: string }): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    return this.deps.lifecycle.updateMetadata(request);
  }

  archive(request: MutationIdentity): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    return this.deps.lifecycle.archive(request);
  }

  restore(request: MutationIdentity): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    return this.deps.lifecycle.restore(request);
  }

  bindConversation(request: MutationIdentity & { conversation_id: string }): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    return this.deps.lifecycle.bindConversation(request);
  }

  unbindConversation(request: MutationIdentity & { conversation_id: string }): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    return this.deps.lifecycle.unbindConversation(request);
  }

  /** Resolve the trusted catalog path main-side and reveal it; never returns the path. */
  async reveal(request: Pick<MutationIdentity, 'project_id' | 'seat_context_revision'>): Promise<void> {
    this.assertSeat(request.seat_context_revision);
    const record = this.trustedProjectRecord(this.deps.get_active_seat_id(), request.project_id);
    this.revealInFolder(record.canonical_project_path);
  }

  async recover(request: MutationIdentity): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    const results = await this.deps.lifecycle.recoverProject({
      project_id: request.project_id,
      seat_context_revision: request.seat_context_revision,
    });
    const last = results.at(-1);
    if (last) return last;
    return {
      receipt_id: request.idempotency_key,
      outcome: 'completed',
      completed_at: this.nowMs(),
      safe_follow_ups: [],
    };
  }

  async undo(request: MutationIdentity): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(request.seat_context_revision);
    const seatId = this.deps.get_active_seat_id();
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    if (catalogs.projects.revision !== request.expected_revision) {
      return this.rejectedReceipt(request.idempotency_key, 'stale_snapshot');
    }
    const record = this.trustedProjectRecord(seatId, request.project_id);
    const receiptsDirectory = path.join(record.canonical_project_path, '.command-eve', 'receipts');
    // Receipt filenames are random UUIDv4 transaction ids, so lexicographic
    // order is NOT chronological (Fable/Kimi review finding). Select by mtime.
    const receiptFiles = fs.existsSync(receiptsDirectory)
      ? fs
          .readdirSync(receiptsDirectory)
          .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
          .map((name) => ({ name, mtimeMs: fs.statSync(path.join(receiptsDirectory, name)).mtimeMs }))
          .toSorted((left, right) => left.mtimeMs - right.mtimeMs)
          .map((entry) => entry.name)
      : [];
    const latest = receiptFiles.at(-1);
    if (!latest) {
      return {
        receipt_id: request.idempotency_key,
        outcome: 'recovery_required',
        completed_at: this.nowMs(),
        reason_code: 'recovery_required',
        safe_follow_ups: ['recover'],
      };
    }
    const result = await this.deps.service.undo(path.join(receiptsDirectory, latest));
    if (result.ok === false) {
      return {
        receipt_id: request.idempotency_key,
        outcome: 'recovery_required',
        completed_at: this.nowMs(),
        reason_code: mapProjectWorkspaceReason(result.reason_code),
        safe_follow_ups: ['recover'],
      };
    }
    return {
      receipt_id: request.idempotency_key,
      outcome: 'completed',
      completed_at: this.nowMs(),
      safe_follow_ups: [],
    };
  }

  listConversationArtifacts(request: { conversation_id: string }): Promise<ProjectWorkspaceConversationArtifactDTO[]> {
    return Promise.resolve(this.deps.artifact_store.list(this.deps.get_active_seat_id(), request.conversation_id));
  }

  subscribeConversationArtifacts(
    request: { conversation_id: string },
    listener: (artifact: ProjectWorkspaceConversationArtifactDTO) => void
  ): () => void {
    const entry: ArtifactListener = { conversation_id: request.conversation_id, listener };
    this.artifactListeners.add(entry);
    return () => {
      this.artifactListeners.delete(entry);
    };
  }

  /**
   * Fan-out seam: wire as the artifact store's `on_changed` callback. Events
   * are forwarded only to listeners subscribed to the artifact's conversation.
   */
  notifyArtifactChanged = (artifact: ProjectWorkspaceConversationArtifactDTO): void => {
    for (const entry of this.artifactListeners) {
      if (entry.conversation_id === artifact.conversation_id) entry.listener(artifact);
    }
  };

  /**
   * S81/R3 — chat intent gate. Scores an outgoing chat message against the
   * seat's existing projects: 0 matches → pass through, 1 → bind via the
   * lifecycle service, >1 → clarify. FAIL-OPEN by contract: any error
   * (seat switch, stale revision, binding failure, store failure) resolves to
   * `pass_through` so sending is never blocked. Auto-create stays
   * release-locked — this gate only ever binds EXISTING projects.
   */
  async chatIntent(
    request: ProjectWorkspaceExplicitChatIntentRequest
  ): Promise<ProjectWorkspaceExplicitChatIntentResult> {
    try {
      if (this.deps.is_seat_switch_in_flight?.()) return { decision: 'pass_through' };
      const currentRevision = this.deps.get_active_seat_context_revision();
      if (request.seat_context_revision !== 0 && request.seat_context_revision !== currentRevision) {
        return { decision: 'pass_through' }; // stale renderer view: never bind
      }
      const seatId = this.deps.get_active_seat_id();
      const catalogs = this.deps.registry.readSeatCatalogs(seatId);
      const candidates = catalogs.projects.projects.map((record) => ({
        project_id: record.project_id,
        seat_id: record.seat_id,
        realm_id: record.realm_id,
        root_id: record.root_id,
        workspace_root_ref: record.workspace_root_ref,
        title: record.title,
        slug: record.slug,
        status: record.status,
      }));
      const matches = matchConversationCandidates(request.input, candidates);
      if (matches.length === 0) return { decision: 'pass_through' };
      if (matches.length > 1) {
        const titles = matches.map((match) => match.title);
        // UI copy ships as renderer-owned i18n key + params (1.818 CAO-P2);
        // the raw string is only the English fallback for version skew.
        const quotedTitles = titles.map((title) => `"${title}"`);
        const question = `Did you mean one of these projects: ${quotedTitles.join(' or ')}? Tell me which one you meant.`;
        const questionI18n: ProjectWorkspaceI18nRef = {
          key: 'common.projects.chatIntent.clarifyQuestion',
          params: { titles: quotedTitles },
        };
        const artifactId = crypto.randomUUID();
        const preview = {
          artifact_id: artifactId,
          state: 'preview' as const,
          intent_summary: 'Ambiguous project assignment',
          intent_summary_i18n: {
            key: 'common.projects.chatIntent.ambiguousSummary',
          } as ProjectWorkspaceI18nRef,
          target_label: titles.join(' / '),
          project_title: titles.join(' / '),
          delta_summary: titles,
          question,
          question_i18n: questionI18n,
          safe_follow_ups: [] as ProjectWorkspaceAction[],
        };
        this.deps.artifact_store.create({
          seat_id: seatId,
          conversation_id: request.conversation_id,
          artifact_id: artifactId,
          payload: preview,
        });
        this.deps.artifact_store.transition({
          seat_id: seatId,
          conversation_id: request.conversation_id,
          artifact_id: artifactId,
          expected_state: 'preview',
          payload: { ...preview, state: 'awaiting_confirmation' as const },
        });
        return { decision: 'needs_clarification', question, question_i18n: questionI18n };
      }
      const match = matches[0];
      // The renderer's 250ms budget races this handler. If the renderer has
      // already given up (deadline passed), do NOT commit a binding — the send
      // has gone out unbound and a late bind would churn mid-turn attestation
      // state (Fable/Grok review finding). Binding happens before the send or
      // not at all this turn.
      if (typeof request.deadline_ms === 'number' && this.nowMs() >= request.deadline_ms) {
        return { decision: 'pass_through' };
      }
      const receipt = await this.deps.lifecycle.bindConversation({
        project_id: match.project_id,
        expected_revision: catalogs.projects.revision,
        seat_context_revision: currentRevision,
        idempotency_key: request.idempotency_key,
        conversation_id: request.conversation_id,
      });
      const artifactId = crypto.randomUUID();
      const preview = {
        artifact_id: artifactId,
        state: 'preview' as const,
        project_id: match.project_id,
        intent_summary: `Conversation assigned to project "${match.title}"`,
        intent_summary_i18n: {
          key: 'common.projects.chatIntent.boundSummary',
          params: { title: match.title },
        } as ProjectWorkspaceI18nRef,
        target_label: match.title,
        project_title: match.title,
        delta_summary: [`bind -> ${match.slug}`],
        safe_follow_ups: ['reveal', 'edit'] as ProjectWorkspaceAction[],
      };
      this.deps.artifact_store.create({
        seat_id: seatId,
        conversation_id: request.conversation_id,
        artifact_id: artifactId,
        payload: preview,
      });
      if (receipt.outcome !== 'completed') {
        // 1.818 CAO-P2: a non-completed bind must not claim a completed
        // artifact or a handled decision. Keep recovery-required distinct
        // from a hard rejection so the UI can offer the one safe next action.
        const recoveryRequired = receipt.outcome === 'recovery_required';
        this.deps.artifact_store.transition({
          seat_id: seatId,
          conversation_id: request.conversation_id,
          artifact_id: artifactId,
          expected_state: 'preview',
          payload: {
            ...preview,
            state: recoveryRequired ? ('recovery_required' as const) : ('rejected' as const),
            intent_summary: recoveryRequired
              ? `Conversation assignment to project "${match.title}" requires recovery`
              : `Could not assign conversation to project "${match.title}"`,
            intent_summary_i18n: {
              key: recoveryRequired
                ? 'common.projects.chatIntent.bindRecoveryRequiredSummary'
                : 'common.projects.chatIntent.bindRejectedSummary',
              params: { title: match.title },
            } as ProjectWorkspaceI18nRef,
            safe_follow_ups: recoveryRequired ? (['recover'] as ProjectWorkspaceAction[]) : [],
            ...(receipt.reason_code ? { reason_code: receipt.reason_code } : {}),
            receipt: {
              receipt_id: receipt.receipt_id,
              outcome: receipt.outcome,
              completed_at: receipt.completed_at,
            },
          },
        });
        return { decision: 'pass_through' };
      }
      this.deps.artifact_store.transition({
        seat_id: seatId,
        conversation_id: request.conversation_id,
        artifact_id: artifactId,
        expected_state: 'preview',
        payload: {
          ...preview,
          state: 'completed' as const,
          receipt: {
            receipt_id: receipt.receipt_id,
            outcome: receipt.outcome,
            completed_at: receipt.completed_at,
          },
        },
      });
      return { decision: 'handled', artifact_id: artifactId };
    } catch {
      return { decision: 'pass_through' }; // intent errors never block sending
    }
  }

  /**
   * 1.820.4 (MAT-1772) — post-turn auto-project policy. After a successful,
   * substantive EVE/Hermes ACP turn on a conversation that still lives in its
   * temporary workspace, provision ONE durable project in the seat's single
   * app-managed default business placement and bind the conversation to it.
   *
   * ADDITIVE BY CONTRACT: this is a post-turn action only. It is NOT the 250ms
   * pre-send chatIntent gate, never blocks a turn, and the renderer only sends
   * the opaque hint `{ conversation_id, turn_id }` — every eligibility fact
   * (ACP/EVE backend, temporary + non-custom workspace, unbound state, durable
   * title) is re-derived here from TRUSTED main-side metadata and catalogs.
   *
   * FAIL-CLOSED: empty/errored/replayed/non-EVE/already-bound/custom or
   * non-temporary turns, seat switches, and missing/ambiguous business
   * placements all resolve to `{ status: 'noop' }`. Nothing is ever guessed:
   * no path, no placement, no title. The method never throws — the IPC bridge
   * relies on that for its fire-and-forget renderer contract.
   */
  async ensureAfterSuccessfulTurn(
    request: ProjectWorkspaceEnsureAutoProjectRequest
  ): Promise<ProjectWorkspaceEnsureAutoProjectResult> {
    try {
      if (this.deps.is_seat_switch_in_flight?.()) return { status: 'noop' };
      const conversationId = typeof request?.conversation_id === 'string' ? request.conversation_id : '';
      const turnId = typeof request?.turn_id === 'string' ? request.turn_id.trim() : '';
      if (!conversationId || !turnId || turnId.length > 256) return { status: 'noop' };
      const seatId = this.deps.get_active_seat_id();

      // Trusted metadata re-read #1. A backend/metadata failure is a no-op,
      // never a reason to create anything.
      let metadata: ProjectConversationMetadata;
      try {
        metadata = await this.deps.binding_client.readMetadata(conversationId);
      } catch {
        return { status: 'noop' };
      }
      if (!this.isAutoProjectEligibleMetadata(metadata)) return { status: 'noop' };

      // Durable title: the PERSISTED conversation name only. While it is still
      // a default/greeting title, perform a few bounded LOCAL re-reads (the
      // title write can race the terminal finish frame) — never inference, and
      // no durable title means a safe no-op.
      let title = metadata.name.trim();
      for (
        let attempt = 0;
        attempt < AUTO_PROJECT_TITLE_REREAD_COUNT && isDefaultOrGreetingTitle(title);
        attempt += 1
      ) {
        await delay(this.autoProjectTitleRereadDelayMs);
        try {
          metadata = await this.deps.binding_client.readMetadata(conversationId);
        } catch {
          return { status: 'noop' };
        }
        // The conversation changed under us (bound, switched, no longer temp).
        if (!this.isAutoProjectEligibleMetadata(metadata)) return { status: 'noop' };
        title = metadata.name.trim();
      }
      if (!title || title.length > 200 || isDefaultOrGreetingTitle(title)) return { status: 'noop' };
      // The re-read waits gave a seat switch a window to start — re-check.
      if (this.deps.is_seat_switch_in_flight?.()) return { status: 'noop' };

      // Exactly ONE app-managed default business placement, or fail closed.
      // The same idempotent lazy seat bootstrap as list() runs first so a seat
      // restored/switched to after boot still offers its seeded placement.
      if (this.deps.registry.readSeatCatalogs(seatId).realms.realms.length === 0) {
        ensureProjectWorkspaceSeatBootstrap({
          registry: this.deps.registry,
          seat_id: seatId,
          data_path: path.dirname(this.deps.registry.stateRoot),
        });
      }
      const placement = this.resolveAutoBusinessPlacement(seatId);
      if (!placement) return { status: 'noop' };

      // Deterministic idempotency identity from seat + conversation + turn:
      // duplicate finish events and retries of the SAME turn collide on it.
      const idempotencyIdentity = deterministicUuid(`auto-project\0${seatId}\0${conversationId}\0${turnId}`);

      let plan: ProjectIntentPlan;
      try {
        plan = this.derivePlan({
          placement_id: this.placementId(placement.realm.realm_id, placement.root.root_id),
          title,
          conversation_id: conversationId,
        });
      } catch {
        // e.g. catalog.project-conflict: an equal-title project already exists.
        // Never guess another placement and never force a duplicate.
        return { status: 'noop' };
      }
      const projectId = plan.project_id;
      if (!projectId) return { status: 'noop' };
      plan.created_by = 'eve';

      const result = await this.deps.service.create(plan);
      if (result.ok === false) {
        return { status: 'rejected', reason_code: mapProjectWorkspaceReason(result.reason_code) };
      }

      // ProjectWorkspaceService.create() commits the semantic bundle and its
      // conversation-binding CAS as ONE transaction. Never issue a second
      // lifecycle bind here: doing so races the already-committed revision and
      // can turn a successful create into a false rejection. Re-read the
      // trusted metadata instead and surface success only when that atomic
      // commit is observable.
      let committedMetadata: ProjectConversationMetadata;
      try {
        committedMetadata = await this.deps.binding_client.readMetadata(conversationId);
      } catch {
        return { status: 'rejected', reason_code: 'invariant_failure' };
      }
      if (
        committedMetadata.binding?.project_id !== projectId ||
        committedMetadata.binding.workspace_root_ref !== plan.workspace_root_ref
      ) {
        return { status: 'rejected', reason_code: 'invariant_failure' };
      }

      this.writeAutoProjectArtifact({
        seatId,
        conversationId,
        artifactId: idempotencyIdentity,
        plan,
        placement,
        receiptId: result.transaction_id,
      });
      return { status: 'created', project_id: projectId, project_title: plan.title };
    } catch (error) {
      return {
        status: 'rejected',
        reason_code:
          error instanceof ProjectWorkspaceError ? mapProjectWorkspaceReason(error.reason_code) : 'invariant_failure',
      };
    }
  }

  /**
   * Eligibility for the post-turn auto-project policy, proven ONLY from
   * trusted main-side metadata: a Command-EVE/Hermes ACP conversation that is
   * still in its temporary workspace, has no user-selected custom workspace,
   * and is not already project-bound (the binding re-check is also the primary
   * duplicate/replay guard: one project per conversation).
   */
  private isAutoProjectEligibleMetadata(metadata: ProjectConversationMetadata): boolean {
    return (
      metadata.conversation_type === 'acp' &&
      metadata.backend !== null &&
      isCommandEveAcpConversation(metadata.backend) &&
      metadata.is_temporary_workspace === true &&
      metadata.custom_workspace !== true &&
      metadata.binding === null
    );
  }

  /**
   * Resolve the seat's single app-managed default BUSINESS placement from the
   * trusted catalogs. Zero or ambiguous (≠1 active business realm, or ≠1
   * active app-managed root beneath it) returns null — the caller fails closed
   * as a pathless no-op and never guesses a path.
   */
  private resolveAutoBusinessPlacement(seatId: string): { realm: RealmRecord; root: RootRecord } | null {
    const catalogs = this.deps.registry.readSeatCatalogs(seatId);
    const businessRealms = catalogs.realms.realms.filter(
      (realm) => realm.status === 'active' && realm.path_slug === AUTO_PROJECT_BUSINESS_REALM_SLUG
    );
    if (businessRealms.length !== 1) return null;
    const roots = catalogs.roots.roots.filter(
      (root) => root.realm_id === businessRealms[0].realm_id && root.status === 'active' && root.kind === 'app_managed'
    );
    if (roots.length !== 1) return null;
    return { realm: businessRealms[0], root: roots[0] };
  }

  /**
   * Surface the successful auto-create through the existing project
   * conversation artifact flow: the composer picks the newest COMPLETED
   * artifact's `project_title` for the durable project chip. The artifact id
   * is the deterministic turn identity, so a replayed finish re-creates an
   * identical record (store-level idempotent) instead of piling up artifacts.
   */
  private writeAutoProjectArtifact(input: {
    seatId: string;
    conversationId: string;
    artifactId: string;
    plan: ProjectIntentPlan;
    placement: { realm: RealmRecord; root: RootRecord };
    receiptId: string;
  }): void {
    const preview: ProjectWorkspaceArtifactDTO = {
      artifact_id: input.artifactId,
      state: 'preview',
      ...(input.plan.project_id ? { project_id: input.plan.project_id } : {}),
      intent_summary: `Project "${input.plan.title}" created and linked`,
      target_label: `${input.placement.realm.label} / ${input.placement.root.label}`,
      project_title: input.plan.title,
      delta_summary: [`create -> ${input.plan.slug}`, `bind -> ${input.plan.slug}`],
      safe_follow_ups: ['reveal', 'edit'],
    };
    try {
      this.deps.artifact_store.create({
        seat_id: input.seatId,
        conversation_id: input.conversationId,
        artifact_id: input.artifactId,
        payload: preview,
      });
      this.deps.artifact_store.transition({
        seat_id: input.seatId,
        conversation_id: input.conversationId,
        artifact_id: input.artifactId,
        expected_state: 'preview',
        payload: {
          ...preview,
          state: 'completed',
          receipt: {
            receipt_id: input.receiptId,
            outcome: 'completed',
            completed_at: this.nowMs(),
          },
        },
      });
    } catch (error) {
      // An identical COMPLETED artifact from an earlier delivery of this same
      // turn is success, not failure (the store's completed state is terminal
      // and rejects a second transition). Anything else is logged, never
      // thrown: the project and the binding have already committed.
      const existing = this.deps.artifact_store
        .list(input.seatId, input.conversationId)
        .find((artifact) => artifact.id === input.artifactId);
      if (existing?.payload.state !== 'completed') {
        console.error('[ProjectWorkspace] auto-project artifact write failed (non-blocking)', error);
      }
    }
  }
}

export function createProjectWorkspaceFacade(deps: ProjectWorkspaceFacadeDeps): ProjectWorkspaceFacade {
  return new ProjectWorkspaceFacade(deps);
}
