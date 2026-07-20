import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_MANIFEST_VERSION } from '@/common/types/project-workspace/manifest';
import { inspectProjectAdoption } from '@process/services/project-workspace/transaction/adoption';

const EXPECTED = {
  seat_id: 'seat-alpha',
  realm_id: '11111111-1111-4111-8111-111111111111',
  root_id: '22222222-2222-4222-8222-222222222222',
  project_id: '33333333-3333-4333-8333-333333333333',
  workspace_root_ref: 'root:22222222-2222-4222-8222-222222222222',
} as const;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: PROJECT_MANIFEST_VERSION,
    ...EXPECTED,
    realm_label: 'Business',
    realm_path_slug: 'business',
    title: 'Atlas',
    slug: 'atlas',
    status: 'active',
    domain_ids: [],
    created_by: 'user',
    created_at: '2026-07-20T00:00:00.000Z',
    manual_overrides: [],
    ...overrides,
  };
}

describe('add-only project adoption', () => {
  let root: string;
  let directory: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-adopt-root-'));
    directory = path.join(root, 'atlas');
    fs.mkdirSync(directory);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns a collision preview and performs no write when no manifest exists', () => {
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'existing\n');
    const result = inspectProjectAdoption({
      directory,
      expected_identity: EXPECTED,
      owned_root_path: root,
    });
    expect(result).toMatchObject({ action: 'preview', needs_confirmation: true });
    expect(result.collisions).toContain('AGENTS.md');
    expect(fs.existsSync(path.join(directory, '.command-eve'))).toBe(false);
  });

  it('fails closed on corrupt, future, foreign, and duplicate manifests', () => {
    const manifestDir = path.join(directory, '.command-eve');
    fs.mkdirSync(manifestDir);
    const file = path.join(manifestDir, 'project.json');
    fs.writeFileSync(file, '{broken');
    expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
      reason_code: 'adoption.manifest-corrupt',
    });

    fs.writeFileSync(file, JSON.stringify({ ...manifest(), schema_version: 'command-eve-project/v99' }));
    expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
      reason_code: 'adoption.schema-unsupported',
    });

    fs.writeFileSync(file, JSON.stringify(manifest({ seat_id: 'seat-beta' })));
    expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
      reason_code: 'adoption.foreign-ownership',
    });

    fs.writeFileSync(file, JSON.stringify(manifest({ project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })));
    expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
      reason_code: 'adoption.collision',
    });
  });

  it('reconciles only the same identity and rejects an unowned root', () => {
    fs.mkdirSync(path.join(directory, '.command-eve'));
    fs.writeFileSync(path.join(directory, '.command-eve', 'project.json'), JSON.stringify(manifest()));
    expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
      action: 'continue_existing',
    });
    expect(
      inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: `${root}-other` })
    ).toMatchObject({ reason_code: 'adoption.root-unowned' });
  });

  it('rejects symlinked scaffold components without writing through them', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-adopt-outside-'));
    try {
      fs.symlinkSync(outside, path.join(directory, 'memory-bank'));
      expect(inspectProjectAdoption({ directory, expected_identity: EXPECTED, owned_root_path: root })).toMatchObject({
        action: 'reject',
        reason_code: 'adoption.symlink',
      });
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(directory, '.command-eve'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a nested adoption target outside the root project level', () => {
    const nested = path.join(root, 'group', 'atlas');
    fs.mkdirSync(nested, { recursive: true });
    expect(
      inspectProjectAdoption({ directory: nested, expected_identity: EXPECTED, owned_root_path: root })
    ).toMatchObject({
      action: 'reject',
      reason_code: 'adoption.root-overlap',
    });
  });
});
