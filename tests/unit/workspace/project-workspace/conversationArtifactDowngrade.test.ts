/**
 * A 1.822.x client must survive reading state that 1.823.0 wrote.
 *
 * 1.823.0 added Office records to the conversation-artifact store. The shipped
 * 1.822.x parser rejects any record that is not a `project_workspace` artifact,
 * and its `list()` maps without a per-file catch — so one unreadable record
 * discards the whole conversation, not just itself. That client is already in
 * users' hands and cannot be changed, which makes the layout 1.823.0 writes the
 * only place this can be fixed.
 *
 * The baseline parser below is the real shipped code, read out of git at the
 * exact commit, never a retelling. A restated parser would only prove this file
 * agrees with itself.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  type CommandEveOfficeConversationArtifactPayload,
} from '@/common/types/office/artifactLineage';
import {
  commandEveOfficeArtifactRelativePath,
  ProjectWorkspaceConversationArtifactStore,
} from '@/process/services/project-workspace/storage/conversationArtifactStore';

/** The 1.822.5 release baseline this candidate is expected to downgrade to. */
const BASELINE_COMMIT = '2c7d4e754';
const STORE_SOURCE = 'packages/desktop/src/process/services/project-workspace/storage/conversationArtifactStore.ts';
const SHARED_SOURCE = 'packages/desktop/src/process/services/project-workspace/storage/atomicJson.ts';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type BaselineConversationArtifact = { id: string; kind: string };
type BaselineArtifactStore = { list(seatId: string, conversationId: string): BaselineConversationArtifact[] };
type BaselineStoreModule = {
  ProjectWorkspaceConversationArtifactStore: new (options: { state_root: string }) => BaselineArtifactStore;
};

const disposables: string[] = [];

afterEach(() => {
  for (const directory of disposables.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * Scratch state stays inside the repository because the baseline module is
 * imported through Vite, which only transforms TypeScript under its root.
 */
function scratchDirectory(prefix: string): string {
  const parent = path.join(REPOSITORY_ROOT, 'tmp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  disposables.push(directory);
  return directory;
}

function baselineSource(file: string): string {
  return execFileSync('git', ['show', `${BASELINE_COMMIT}:${file}`], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function workingTreeSource(file: string): string {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
}

/**
 * Loads the baseline store as a module. Only its relative import of the shared
 * atomic-write helpers is rewritten, which the test below proves is byte-for-byte
 * the same file at both commits; every line of the parser itself is untouched.
 */
async function loadBaselineStore(): Promise<BaselineStoreModule> {
  const shared = path.join(REPOSITORY_ROOT, SHARED_SOURCE).replace(/\.ts$/, '');
  const source = baselineSource(STORE_SOURCE).replace("from './atomicJson'", `from '${shared}'`);
  const directory = scratchDirectory('command-eve-1822-baseline-');
  const module = path.join(directory, 'conversationArtifactStore.ts');
  fs.writeFileSync(module, source);
  return (await import(/* @vite-ignore */ module)) as BaselineStoreModule;
}

function stateRoot(): string {
  return scratchDirectory('command-eve-downgrade-');
}

const officeSha = 'a'.repeat(64);
const projectPayload = {
  artifact_id: 'artifact-alpha',
  state: 'preview' as const,
  intent_summary: 'Create a project for this conversation',
  target_label: 'Business · Managed',
  project_title: 'Launch',
  delta_summary: ['Project index'],
  safe_follow_ups: [],
};
const officePayload: CommandEveOfficeConversationArtifactPayload = {
  artifact_type: 'file',
  artifact_id: 'office-alpha',
  title: 'Report.docx',
  file_name: 'Report.docx',
  mime_type: commandEveOfficeMimeType('word'),
  path: commandEveOfficeArtifactRelativePath('conversation-alpha', 'office-alpha', officeSha, 'word'),
  size: 42,
  hash: officeSha,
  managed_office: true,
  office_mode: 'word',
  origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  origin_action: 'create',
  parent_artifact_id: null,
  source_sha256: officeSha,
  source_size: 42,
  source_fingerprint: commandEveOfficeFingerprint('word', officeSha, 42),
  result_sha256: officeSha,
  result_fingerprint: commandEveOfficeFingerprint('word', officeSha, 42),
  operation_id: 'officeop_' + '1'.repeat(64),
  seat_id: 'seat-alpha',
  seat_context_revision: 7,
  source_message_id: 'msg-office',
  source_turn_id: 'turn-office',
  source_directive_index: 0,
  source_tool: 'hermes_media_directive',
};

function writeCurrentConversation(root: string): void {
  const store = new ProjectWorkspaceConversationArtifactStore({ state_root: root, now: () => 42 });
  store.create({
    seat_id: 'seat-alpha',
    conversation_id: 'conversation-alpha',
    artifact_id: projectPayload.artifact_id,
    payload: projectPayload,
  });
  store.createOfficeArtifact({
    seat_id: 'seat-alpha',
    conversation_id: 'conversation-alpha',
    artifact_id: officePayload.artifact_id,
    payload: officePayload,
  });
}

function conversationDirectory(root: string): string {
  return path.join(root, 'conversation-artifacts', 'seat-alpha', 'conversation-alpha');
}

describe('1.822.x downgrade over state written by 1.823.0', () => {
  it('substitutes only shared helpers that are identical at both commits', () => {
    expect(baselineSource(SHARED_SOURCE)).toBe(workingTreeSource(SHARED_SOURCE));
  });

  it('still lists every conversation artifact after 1.823.0 created an Office record', async () => {
    const root = stateRoot();
    writeCurrentConversation(root);
    const baseline = await loadBaselineStore();

    const listed = new baseline.ProjectWorkspaceConversationArtifactStore({ state_root: root }).list(
      'seat-alpha',
      'conversation-alpha'
    );

    expect(listed.map((artifact) => artifact.id)).toEqual([projectPayload.artifact_id]);
  });

  it('loses the whole conversation once an Office record sits flat beside the artifacts', async () => {
    // The negative control: it is the record's LOCATION that keeps the old
    // client readable, not anything about the record itself. Without this, a
    // future change could move Office records back into the parsed directory
    // and the test above would keep passing for the wrong reason.
    const root = stateRoot();
    writeCurrentConversation(root);
    const directory = conversationDirectory(root);
    fs.copyFileSync(
      path.join(directory, '.office-records', officePayload.artifact_id + '.json'),
      path.join(directory, officePayload.artifact_id + '.json')
    );
    const baseline = await loadBaselineStore();

    expect(() =>
      new baseline.ProjectWorkspaceConversationArtifactStore({ state_root: root }).list(
        'seat-alpha',
        'conversation-alpha'
      )
    ).toThrow('workspace.journal-corrupt');
  });
});
