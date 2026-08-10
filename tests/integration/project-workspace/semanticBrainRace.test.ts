import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBrainIndex, readEntryBody } from '@/process/commandEve/companyBrainStoreCore';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  projectA: '33333333-3333-4333-8333-333333333333',
  transactionA: '44444444-4444-4444-8444-444444444444',
  projectB: 'a5b6c7d8-e9f0-4123-8123-456789abcdef',
  transactionB: 'b6c7d8e9-f0a1-4234-9234-56789abcdef0',
} as const;

const worker = path.resolve('tests/integration/project-workspace/fixtures/semanticBrainRaceWorker.ts');
const WORKER_RESULT_PREFIX = 'EVE_SEMANTIC_BRAIN_RACE_RESULT=';

function runWorker(
  config: Record<string, unknown>,
  expected: Record<string, unknown> = { ok: true }
): {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
} {
  const child = spawn('bun', [worker], {
    env: { ...process.env, EVE_SEMANTIC_BRAIN_RACE_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `semantic worker exited ${code}`));
      try {
        const receiptLine = stdout.split(/\r?\n/).find((line) => line.startsWith(WORKER_RESULT_PREFIX));
        if (!receiptLine) throw new Error(`semantic worker receipt missing from stdout: ${stdout.trim()}`);
        expect(JSON.parse(receiptLine.slice(WORKER_RESULT_PREFIX.length))).toEqual(expected);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, completion };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function commitConfig(input: {
  stateRoot: string;
  hermesHome: string;
  transactionId: string;
  projectId: string;
  conversationId: string;
  title: string;
  slug: string;
  markerFile?: string;
  releaseFile?: string;
}): Record<string, unknown> {
  return {
    action: 'commit',
    state_root: input.stateRoot,
    hermes_home: input.hermesHome,
    transaction_id: input.transactionId,
    conversation_id: input.conversationId,
    realm_id: IDS.realm,
    root_id: IDS.root,
    project_id: input.projectId,
    title: input.title,
    slug: input.slug,
    ...(input.markerFile ? { marker_file: input.markerFile } : {}),
    ...(input.releaseFile ? { release_file: input.releaseFile } : {}),
  };
}

describe('cross-process semantic Brain mutation fence', () => {
  it('preserves both distinct project entries across an interleaved stale-index publication', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-semantic-brain-race-'));
    const hermesHome = path.join(directory, 'hermes');
    const stateA = path.join(directory, 'state-a');
    const stateB = path.join(directory, 'state-b');
    const marker = path.join(directory, 'writer-a-paused');
    const release = path.join(directory, 'release-writer-a');
    try {
      const first = runWorker(
        commitConfig({
          stateRoot: stateA,
          hermesHome,
          transactionId: IDS.transactionA,
          projectId: IDS.projectA,
          conversationId: 'conversation-a',
          title: 'Project A',
          slug: 'project-a',
          markerFile: marker,
          releaseFile: release,
        })
      );
      await waitForFile(marker);
      const second = runWorker(
        commitConfig({
          stateRoot: stateB,
          hermesHome,
          transactionId: IDS.transactionB,
          projectId: IDS.projectB,
          conversationId: 'conversation-b',
          title: 'Project B',
          slug: 'project-b',
        })
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(release, 'release\n', 'utf8');
      await Promise.all([first.completion, second.completion]);

      expect(
        readBrainIndex(hermesHome)
          .entries.map((entry) => entry.id)
          .toSorted()
      ).toEqual([`project-${IDS.projectA}`, `project-${IDS.projectB}`].toSorted());
      expect(readEntryBody(hermesHome, `project-${IDS.projectA}`)).toContain(IDS.projectA);
      expect(readEntryBody(hermesHome, `project-${IDS.projectB}`)).toContain(IDS.projectB);
      expect(fs.existsSync(path.join(hermesHome, 'company-brain', 'brain.json.lock'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it('serializes a project commit against another project rollback without resurrection', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-semantic-brain-commit-rollback-'));
    const hermesHome = path.join(directory, 'hermes');
    const stateA = path.join(directory, 'state-a');
    const stateB = path.join(directory, 'state-b');
    const commitMarker = path.join(directory, 'writer-b-paused');
    const rollbackMarker = path.join(directory, 'rollback-a-started');
    const release = path.join(directory, 'release-writer-b');
    try {
      await runWorker(
        commitConfig({
          stateRoot: stateA,
          hermesHome,
          transactionId: IDS.transactionA,
          projectId: IDS.projectA,
          conversationId: 'conversation-a',
          title: 'Project A',
          slug: 'project-a',
        })
      ).completion;

      const committing = runWorker(
        commitConfig({
          stateRoot: stateB,
          hermesHome,
          transactionId: IDS.transactionB,
          projectId: IDS.projectB,
          conversationId: 'conversation-b',
          title: 'Project B',
          slug: 'project-b',
          markerFile: commitMarker,
          releaseFile: release,
        })
      );
      await waitForFile(commitMarker);
      const rollingBack = runWorker({
        action: 'rollback',
        state_root: stateA,
        hermes_home: hermesHome,
        transaction_id: IDS.transactionA,
        marker_file: rollbackMarker,
      });
      await waitForFile(rollbackMarker);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(release, 'release\n', 'utf8');
      await Promise.all([committing.completion, rollingBack.completion]);

      expect(readBrainIndex(hermesHome).entries.map((entry) => entry.id)).toEqual([`project-${IDS.projectB}`]);
      expect(readEntryBody(hermesHome, `project-${IDS.projectA}`)).toBeNull();
      expect(readEntryBody(hermesHome, `project-${IDS.projectB}`)).toContain(IDS.projectB);
      expect(fs.existsSync(path.join(stateA, 'semantic-sidecars', `${IDS.transactionA}.json`))).toBe(false);
      expect(fs.existsSync(path.join(stateB, 'semantic-sidecars', `${IDS.transactionB}.json`))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails a normal user write closed during a project transaction and preserves both on retry', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-semantic-brain-user-write-'));
    const hermesHome = path.join(directory, 'hermes');
    const stateRoot = path.join(directory, 'state');
    const marker = path.join(directory, 'project-writer-paused');
    const release = path.join(directory, 'release-project-writer');
    try {
      const committing = runWorker(
        commitConfig({
          stateRoot,
          hermesHome,
          transactionId: IDS.transactionA,
          projectId: IDS.projectA,
          conversationId: 'conversation-a',
          title: 'Project A',
          slug: 'project-a',
          markerFile: marker,
          releaseFile: release,
        })
      );
      await waitForFile(marker);
      await runWorker(
        { action: 'user-upsert', hermes_home: hermesHome, entry_id: 'user-note' },
        { ok: false, reason_code: 'workspace.concurrent-operation' }
      ).completion;
      fs.writeFileSync(release, 'release\n', 'utf8');
      await committing.completion;
      await runWorker({ action: 'user-upsert', hermes_home: hermesHome, entry_id: 'user-note' }).completion;

      expect(
        readBrainIndex(hermesHome)
          .entries.map((entry) => entry.id)
          .toSorted()
      ).toEqual([`project-${IDS.projectA}`, 'user-note'].toSorted());
      expect(readEntryBody(hermesHome, 'user-note')).toBe('normal user write\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
