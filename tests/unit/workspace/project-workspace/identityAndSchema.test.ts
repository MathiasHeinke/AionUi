import {
  PROJECT_MANIFEST_VERSION,
  PROJECT_RECEIPT_VERSION,
  migrateProjectManifest,
  parseProjectManifest,
  parseProjectReceipt,
} from '@/common/types/project-workspace/manifest';
import {
  parseProjectId,
  parseRealmId,
  parseRootId,
  parseWorkspaceRootRef,
  toWorkspaceRootRef,
} from '@/common/types/project-workspace/identity';
import { PROJECT_JOURNAL_VERSION } from '@/common/types/project-workspace/transaction';
import { validateProjectJournal } from '@process/services/project-workspace/transaction/journalStore';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  transaction: '44444444-4444-4444-8444-444444444444',
} as const;

function manifest(): Record<string, unknown> {
  return {
    schema_version: PROJECT_MANIFEST_VERSION,
    project_id: IDS.project,
    seat_id: 'seat-alpha',
    realm_id: IDS.realm,
    realm_label: 'Business',
    realm_path_slug: 'business',
    root_id: IDS.root,
    title: 'Project Atlas',
    slug: 'project-atlas',
    status: 'active',
    domain_ids: ['domain:research'],
    created_by: 'user',
    created_at: '2026-07-20T00:00:00.000Z',
    workspace_root_ref: `root:${IDS.root}`,
    manual_overrides: [],
  };
}

describe('project workspace opaque identity', () => {
  it('accepts UUID identities and derives a portable root reference', () => {
    expect(parseRealmId(IDS.realm)).toBe(IDS.realm);
    expect(parseRootId(IDS.root)).toBe(IDS.root);
    expect(parseProjectId(IDS.project)).toBe(IDS.project);
    expect(toWorkspaceRootRef(parseRootId(IDS.root))).toBe(`root:${IDS.root}`);
  });

  it('rejects labels, path slugs, and absolute paths as opaque identity', () => {
    expect(() => parseRealmId('business')).toThrow();
    expect(() => parseRootId('/tmp/projects')).toThrow();
    expect(() => parseProjectId('../project')).toThrow();
  });

  it('parses only the exact root:<opaque-id> grammar', () => {
    expect(parseWorkspaceRootRef(`root:${IDS.root}`)).toBe(`root:${IDS.root}`);
    expect(() => parseWorkspaceRootRef(`root:business:${IDS.root}`)).toThrow();
    expect(() => parseWorkspaceRootRef(`/tmp/${IDS.root}`)).toThrow();
  });
});

describe('project manifest and receipt schemas', () => {
  it('accepts an exact v1 manifest and rejects unknown fields', () => {
    expect(parseProjectManifest(manifest()).ok).toBe(true);
    expect(parseProjectManifest({ ...manifest(), raw_prompt: 'secret' })).toMatchObject({
      ok: false,
      reason_code: 'schema.invalid',
    });
  });

  it('rejects unknown journal fields and traversal paths', () => {
    const journal = {
      schema_version: PROJECT_JOURNAL_VERSION,
      transaction_id: IDS.transaction,
      conversation_id: 'conversation-schema-test',
      operation: 'create',
      phase: 'leased',
      identity: {
        seat_id: 'seat-alpha',
        realm_id: IDS.realm,
        root_id: IDS.root,
        project_id: IDS.project,
        workspace_root_ref: `root:${IDS.root}`,
      },
      slug: 'project-atlas',
      staging_path: '/tmp/.command-eve-stage-project-atlas',
      final_path: '/tmp/project-atlas',
      lease_path: '/tmp/project-atlas.lease.json',
      owner_token_sha256: 'b'.repeat(64),
      created_files: [{ relative_path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
      created_directories: ['docs'],
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    };
    expect(validateProjectJournal(journal)).toMatchObject({ transaction_id: IDS.transaction });
    expect(() => validateProjectJournal({ ...journal, phase: 'preflighted' })).toThrow(/workspace\.journal-corrupt/);
    expect(
      validateProjectJournal({
        ...journal,
        phase: 'preflighted',
        semantic_base_bundle_sha256: 'c'.repeat(64),
        semantic_bundle_sha256: 'd'.repeat(64),
        semantic_preflight_receipt_id: 'test-boundary-pass:v1',
        semantic_context_ref: `context:${IDS.transaction}`,
        semantic_context_sha256: 'e'.repeat(64),
        proposed_domains_sha256: 'f'.repeat(64),
      })
    ).toMatchObject({ phase: 'preflighted' });
    expect(() => validateProjectJournal({ ...journal, raw_intent: 'private' })).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...journal,
        created_files: [{ relative_path: '../escape', sha256: 'a'.repeat(64) }],
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...journal,
        identity: { ...journal.identity, absolute_root: '/tmp/private' },
      })
    ).toThrow(/workspace\.journal-corrupt/);
  });

  it('fails closed for future schema versions and absolute workspace roots', () => {
    expect(parseProjectManifest({ ...manifest(), schema_version: 'command-eve-project/v99' })).toMatchObject({
      ok: false,
      reason_code: 'schema.unsupported',
    });
    expect(parseProjectManifest({ ...manifest(), workspace_root_ref: '/tmp/project' })).toMatchObject({
      ok: false,
      reason_code: 'schema.invalid',
    });
  });

  it('migrates only an explicit strict v0 shape and is idempotent on v1', () => {
    const migrated = migrateProjectManifest(
      {
        schema_version: 'command-eve-project/v0',
        project_id: IDS.project,
        seat_id: 'seat-alpha',
        realm_label: 'Business',
        title: 'Project Atlas',
        slug: 'project-atlas',
        status: 'active',
        domain_ids: [],
        created_by: 'user',
        created_at: '2026-07-20T00:00:00.000Z',
      },
      {
        realm_id: IDS.realm,
        realm_path_slug: 'business',
        root_id: IDS.root,
      }
    );
    expect(migrated).toMatchObject({ ok: true, migrated: true });
    if (!migrated.ok) throw new Error('expected migration');
    expect(migrated.value.workspace_root_ref).toBe(`root:${IDS.root}`);
    expect(migrateProjectManifest(migrated.value, undefined)).toMatchObject({
      ok: true,
      migrated: false,
    });
  });

  it('validates receipts without raw intent or absolute paths', () => {
    const receipt = {
      schema_version: PROJECT_RECEIPT_VERSION,
      transaction_id: IDS.transaction,
      operation: 'create',
      status: 'committed',
      identity: {
        seat_id: 'seat-alpha',
        realm_id: IDS.realm,
        root_id: IDS.root,
        project_id: IDS.project,
        workspace_root_ref: `root:${IDS.root}`,
      },
      semantic_bundle_sha256: 'c'.repeat(64),
      semantic_preflight_receipt_id: 'test-boundary-pass:v1',
      created_files: [{ relative_path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
      created_directories: ['docs'],
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    };
    expect(parseProjectReceipt(receipt).ok).toBe(true);
    expect(parseProjectReceipt({ ...receipt, absolute_path: '/tmp/project' })).toMatchObject({
      ok: false,
      reason_code: 'schema.invalid',
    });
  });
});
