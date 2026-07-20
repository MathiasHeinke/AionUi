import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { ProjectLifecycleOperationStore } from '@/process/services/project-workspace/transaction/lifecycleOperationStore';

const roots: string[] = [];
const request = {
  idempotency_key: '6f1cb6cb-07fe-4b9e-85f9-2b63cc94d4d3',
  operation: 'archive' as const,
  seat_id: 'seat-alpha',
  project_id: 'project-alpha',
  expected_revision: 3,
  seat_context_revision: 2,
  request: { project_id: 'project-alpha', expected_revision: 3 },
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function store(): ProjectLifecycleOperationStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-operation-'));
  roots.push(root);
  let tick = 0;
  return new ProjectLifecycleOperationStore(root, () => new Date(1_700_000_000_000 + tick++));
}

describe('ProjectLifecycleOperationStore', () => {
  it('persists a planned operation and replays the same request after restart', () => {
    const first = store();
    expect(first.prepare(request).replay).toBe(false);
    expect(first.prepare(request)).toMatchObject({ replay: true, record: { phase: 'planned' } });
  });

  it('rejects idempotency-key reuse with a different request hash', () => {
    const operations = store();
    operations.prepare(request);
    expect(() => operations.prepare({ ...request, request: { project_id: 'other' } })).toThrow(ProjectWorkspaceError);
  });

  it('tracks mutating operations as project-scoped recovery work', () => {
    const operations = store();
    operations.prepare(request);
    operations.transition(request.seat_id, request.idempotency_key, 'planned', 'mutating');
    expect(operations.listRecoverable('seat-alpha', 'project-alpha')).toHaveLength(1);
    expect(operations.listRecoverable('seat-alpha', 'other')).toHaveLength(0);
  });

  it('requires a safe terminal receipt and does not allow terminal downgrade', () => {
    const operations = store();
    operations.prepare(request);
    operations.transition(request.seat_id, request.idempotency_key, 'planned', 'mutating');
    const completed = operations.transition(request.seat_id, request.idempotency_key, 'mutating', 'committed', {
      receipt_id: 'receipt-alpha',
      outcome: 'completed',
      completed_at: 42,
    });
    expect(completed.phase).toBe('committed');
    expect(() => operations.transition(request.seat_id, request.idempotency_key, 'committed', 'mutating')).toThrow(
      ProjectWorkspaceError
    );
  });
});
