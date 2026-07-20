import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { PROJECT_JOURNAL_VERSION, PROJECT_UNDO_QUARANTINE_VERSION } from '@/common/types/project-workspace/transaction';
import {
  advanceProjectJournal,
  isProjectJournalTransitionAllowed,
  projectJournalPath,
  validateProjectJournal,
} from '@process/services/project-workspace/transaction/journalStore';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  transaction: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
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
    const semanticJournal = {
      ...journal,
      phase: 'preflighted',
      semantic_base_bundle_sha256: 'c'.repeat(64),
      semantic_bundle_sha256: 'd'.repeat(64),
      semantic_effect_plan_sha256: 'a'.repeat(64),
      semantic_initial_project_id: null,
      semantic_initial_workspace_root_ref: null,
      semantic_initial_project_binding_revision: 0,
      semantic_initial_project_binding_receipt_id: null,
      semantic_preflight_receipt_id: 'test-boundary-pass:v1',
      semantic_context_ref: `context:${IDS.transaction}`,
      semantic_context_sha256: 'e'.repeat(64),
      proposed_domains_sha256: 'f'.repeat(64),
    };
    expect(validateProjectJournal(semanticJournal)).toMatchObject({ phase: 'preflighted' });
    const { semantic_initial_project_binding_revision: _missingRevision, ...missingRevision } = semanticJournal;
    expect(() => validateProjectJournal(missingRevision)).toThrow(/workspace\.journal-corrupt/);
    const { semantic_initial_project_binding_receipt_id: _missingReceipt, ...missingReceipt } = semanticJournal;
    expect(() => validateProjectJournal(missingReceipt)).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...semanticJournal,
        semantic_initial_project_binding_receipt_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() => validateProjectJournal({ ...journal, semantic_initial_project_binding_revision: 0 })).toThrow(
      /workspace\.journal-corrupt/
    );
    expect(() => validateProjectJournal({ ...journal, raw_intent: 'private' })).toThrow(/workspace\.journal-corrupt/);
    for (const transactionId of [
      'abcdefab-cdef-1abc-8def-abcdefabcdef',
      'abcdefab-cdef-5abc-8def-abcdefabcdef',
      'abcdefab-cdef-7abc-8def-abcdefabcdef',
      IDS.transaction.toUpperCase(),
    ]) {
      expect(() => validateProjectJournal({ ...journal, transaction_id: transactionId })).toThrow(
        /workspace\.journal-corrupt/
      );
    }
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

    const receiptRelativePath = `.command-eve/receipts/${IDS.transaction}.json`;
    const undoFiles = [
      { relative_path: 'AGENTS.md', sha256: 'a'.repeat(64), dev: 1, ino: 2, size: 10 },
      { relative_path: receiptRelativePath, sha256: 'b'.repeat(64), dev: 1, ino: 3, size: 20 },
    ].toSorted((left, right) => left.relative_path.localeCompare(right.relative_path));
    const undoJournal = {
      ...semanticJournal,
      phase: 'undo_quarantine_prepared',
      undo_quarantine_plan: {
        schema_version: PROJECT_UNDO_QUARANTINE_VERSION,
        transaction_id: IDS.transaction,
        origin: 'committed-undo',
        mode: 'create-tree',
        quarantine_basename: `.command-eve-undo-${IDS.transaction}`,
        receipt_relative_path: receiptRelativePath,
        catalog_proof: {
          expected_revision: 7,
          expected_record: {
            project_id: IDS.project,
            seat_id: 'seat-alpha',
            realm_id: IDS.realm,
            root_id: IDS.root,
            workspace_root_ref: `root:${IDS.root}`,
            title: 'Project Atlas',
            slug: 'project-atlas',
            status: 'active',
            manifest_relative_path: 'project-atlas/.command-eve/project.json',
            canonical_project_path: '/tmp/project-atlas',
            comparison_key: '/tmp/project-atlas',
            registered_at: '2026-07-20T00:00:00.000Z',
          },
        },
        root_identity: { dev: 1, ino: 1 },
        quarantine_root_identity: null,
        quarantine_directories: [],
        files: undoFiles,
        directories: [{ relative_path: 'docs', dev: 1, ino: 4 }],
      },
    };
    expect(validateProjectJournal(undoJournal)).toMatchObject({ phase: 'undo_quarantine_prepared' });
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        undo_quarantine_plan: {
          ...undoJournal.undo_quarantine_plan,
          files: [
            ...undoFiles,
            { relative_path: 'user-owned.txt', sha256: 'c'.repeat(64), dev: 1, ino: 5, size: 30 },
          ].toSorted((left, right) => left.relative_path.localeCompare(right.relative_path)),
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        undo_quarantine_plan: {
          ...undoJournal.undo_quarantine_plan,
          quarantine_basename: '.command-eve-undo-foreign',
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        phase: 'undo_quarantining',
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        phase: 'committed',
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        undo_quarantine_plan: {
          ...undoJournal.undo_quarantine_plan,
          catalog_proof: {
            ...undoJournal.undo_quarantine_plan.catalog_proof,
            expected_revision: 8,
            expected_record: {
              ...undoJournal.undo_quarantine_plan.catalog_proof.expected_record,
              project_id: '44444444-4444-4444-8444-444444444444',
            },
          },
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...undoJournal,
        undo_quarantine_plan: {
          ...undoJournal.undo_quarantine_plan,
          catalog_proof: {
            ...undoJournal.undo_quarantine_plan.catalog_proof,
            expected_record: {
              ...undoJournal.undo_quarantine_plan.catalog_proof.expected_record,
              raw_intent: 'must-not-be-journaled',
            },
          },
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);

    const missingRootUndoJournal = {
      ...journal,
      phase: 'undo_quarantining',
      created_files: [],
      created_directories: [],
      undo_quarantine_plan: {
        schema_version: PROJECT_UNDO_QUARANTINE_VERSION,
        transaction_id: IDS.transaction,
        origin: 'provisioning-rollback',
        mode: 'create-missing-root',
        quarantine_basename: `.command-eve-undo-${IDS.transaction}`,
        receipt_relative_path: null,
        catalog_proof: null,
        root_identity: null,
        quarantine_root_identity: null,
        quarantine_directories: [],
        files: [],
        directories: [],
      },
    };
    expect(validateProjectJournal(missingRootUndoJournal)).toMatchObject({
      phase: 'undo_quarantining',
    });
    expect(
      validateProjectJournal({
        ...missingRootUndoJournal,
        operation: 'adopt',
        phase: 'undo_removal_committed',
        undo_quarantine_plan: {
          ...missingRootUndoJournal.undo_quarantine_plan,
          mode: 'adopt-no-additions',
          root_identity: { dev: 1, ino: 2 },
        },
      })
    ).toMatchObject({ phase: 'undo_removal_committed' });
    expect(() =>
      validateProjectJournal({
        ...missingRootUndoJournal,
        undo_quarantine_plan: {
          ...missingRootUndoJournal.undo_quarantine_plan,
          origin: 'committed-undo',
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...missingRootUndoJournal,
        phase: 'recovery_required',
      })
    ).toThrow(/workspace\.journal-corrupt/);
    expect(() =>
      validateProjectJournal({
        ...missingRootUndoJournal,
        phase: 'undone',
      })
    ).toThrow(/workspace\.journal-corrupt/);

    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-journal-terminal-'));
    try {
      const removalCommitted = validateProjectJournal({
        ...missingRootUndoJournal,
        phase: 'undo_removal_committed',
      });
      const terminal = advanceProjectJournal(stateRoot, removalCommitted, 'undone', '2026-07-20T00:00:01.000Z', {
        undo_quarantine_plan: undefined,
      });
      expect(terminal.undo_quarantine_plan).toBeUndefined();
      expect(
        Object.hasOwn(
          JSON.parse(fs.readFileSync(projectJournalPath(stateRoot, IDS.transaction), 'utf8')),
          'undo_quarantine_plan'
        )
      ).toBe(false);

      const { undo_quarantine_plan: _removedPlan, ...committedJournalInput } = undoJournal;
      const committedJournal = validateProjectJournal({ ...committedJournalInput, phase: 'committed' });
      const preparedCommittedUndo = advanceProjectJournal(
        stateRoot,
        committedJournal,
        'undo_quarantine_prepared',
        '2026-07-20T00:00:01.000Z',
        { undo_quarantine_plan: undoJournal.undo_quarantine_plan }
      );
      const boundCommittedUndo = advanceProjectJournal(
        stateRoot,
        preparedCommittedUndo,
        'undo_quarantine_prepared',
        '2026-07-20T00:00:02.000Z',
        {
          undo_quarantine_plan: {
            ...undoJournal.undo_quarantine_plan,
            quarantine_root_identity: { dev: 1, ino: 10 },
            quarantine_directories: [
              { relative_path: '.command-eve', dev: 1, ino: 11 },
              { relative_path: '.command-eve/receipts', dev: 1, ino: 12 },
            ],
          },
        }
      );
      expect(boundCommittedUndo.undo_quarantine_plan).toMatchObject({
        origin: 'committed-undo',
        quarantine_root_identity: { dev: 1, ino: 10 },
      });
      expect(() =>
        advanceProjectJournal(stateRoot, boundCommittedUndo, 'undo_quarantining', '2026-07-20T00:00:03.000Z', {
          undo_quarantine_plan: {
            ...boundCommittedUndo.undo_quarantine_plan!,
            receipt_relative_path: null,
          },
        })
      ).toThrow(/workspace\.journal-corrupt/);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }

    const provisioningUndoJournal = {
      ...semanticJournal,
      phase: 'undo_quarantine_prepared',
      undo_quarantine_plan: {
        ...undoJournal.undo_quarantine_plan,
        origin: 'provisioning-rollback',
        receipt_relative_path: null,
        catalog_proof: null,
        files: undoFiles.filter((entry) => entry.relative_path !== receiptRelativePath),
      },
    };
    expect(validateProjectJournal(provisioningUndoJournal)).toMatchObject({
      phase: 'undo_quarantine_prepared',
    });
    expect(() =>
      validateProjectJournal({
        ...provisioningUndoJournal,
        undo_quarantine_plan: {
          ...provisioningUndoJournal.undo_quarantine_plan,
          receipt_relative_path: receiptRelativePath,
        },
      })
    ).toThrow(/workspace\.journal-corrupt/);

    expect(isProjectJournalTransitionAllowed('committed', 'undo_quarantine_prepared')).toBe(true);
    expect(isProjectJournalTransitionAllowed('staged', 'undo_quarantine_prepared')).toBe(true);
    expect(isProjectJournalTransitionAllowed('semantic_committed', 'undo_quarantine_prepared')).toBe(true);
    expect(isProjectJournalTransitionAllowed('undo_quarantined', 'undo_semantic_rolled_back')).toBe(true);
    expect(isProjectJournalTransitionAllowed('committed', 'planned')).toBe(false);
    expect(isProjectJournalTransitionAllowed('staged', 'undone')).toBe(false);
    expect(isProjectJournalTransitionAllowed('rollback_pending', 'undone')).toBe(false);
    expect(isProjectJournalTransitionAllowed('undo_quarantining', 'recovery_required')).toBe(false);
    expect(isProjectJournalTransitionAllowed('undo_removal_committed', 'undo_quarantining')).toBe(false);
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
