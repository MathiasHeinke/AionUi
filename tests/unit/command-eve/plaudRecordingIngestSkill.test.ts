import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK } from '@/process/commandEve/runtimeBootstrapCore';

const skillRoot = path.resolve(process.cwd(), 'resources/bundled-skills/plaud-recording-ingest');
const guardPath = path.join(skillRoot, 'scripts', 'plaud-ingest-guard.mjs');
const downloaderPath = path.join(skillRoot, 'scripts', 'plaud-download-audio.mjs');

const guard = (await import(pathToFileURL(guardPath).href)) as {
  assertPlaudCommandAllowed(command: string): string;
  buildPlaudRedactedReceipt(input: Record<string, unknown>): Record<string, unknown>;
  classifyPlaudAudioState(input: { recordingFound: boolean; audioReady: boolean }): string;
  decidePlaudContentRoute(input?: {
    requestedRoute?: string;
    onlineChatModel?: boolean;
    explicitRecordingApproval?: boolean;
  }): Record<string, unknown>;
  decidePlaudDedupe(
    existing: { sourceFileId: string; sha256: string } | undefined,
    candidate: { sourceFileId: string; sha256: string }
  ): string;
  probePlaudCapability(input?: {
    plaudCli?: string;
    spawn?: (command: string, args: string[], options: Record<string, unknown>) => Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  }): Record<string, unknown>;
  redactPlaudSensitiveText(value: string): string;
};

describe('PLAUD recording ingest built-in', () => {
  it('stays gated until the live CLI and OAuth capability receipt proves readiness', () => {
    const bundled = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === 'plaud-recording-ingest');
    const publicManifest = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public', 'command-eve-capabilities.json'), 'utf8')
    ) as { skills: Array<{ id: string; default_state: string }> };
    const published = publicManifest.skills.find((skill) => skill.id === 'plaud-recording-ingest');

    expect(bundled?.default_state).toBe('gated');
    expect(published?.default_state).toBe('gated');
  });

  it('packages every linked security contract and the fixed-root downloader', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    for (const linkedFile of [
      'references/processing-contract.md',
      'references/command-eve-integration.md',
      'scripts/plaud-download-audio.mjs',
      'scripts/plaud-ingest-guard.mjs',
    ]) {
      expect(skill).toContain(`  - ${linkedFile}`);
      expect(fs.statSync(path.join(skillRoot, linkedFile)).size).toBeGreaterThan(0);
    }

    const downloader = fs.readFileSync(downloaderPath, 'utf8');
    expect(downloader).toContain('--data-root');
    expect(downloader).not.toContain('--output-dir');
  });

  it('keeps a synchronized recording retryable while its audio is pending', () => {
    expect(guard.classifyPlaudAudioState({ recordingFound: true, audioReady: false })).toBe('audio_pending');
    expect(guard.classifyPlaudAudioState({ recordingFound: true, audioReady: true })).toBe('discovered');
  });

  it('removes signed URLs and bearer values before any status reaches chat', () => {
    const redacted = guard.redactPlaudSensitiveText(
      'Bearer top-secret\nAudio Download URL:\nhttps://files.example/audio?X-Amz-Signature=secret'
    );
    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('https://');
    expect(redacted).not.toContain('X-Amz-Signature');
    expect(redacted).toContain('[REDACTED_URL]');
  });

  it('deduplicates only when the PLAUD file ID and audio digest both match', () => {
    const candidate = { sourceFileId: 'plaud_file_1234', sha256: 'a'.repeat(64) };
    expect(guard.decidePlaudDedupe(undefined, candidate)).toBe('new');
    expect(guard.decidePlaudDedupe(candidate, candidate)).toBe('reuse');
    expect(guard.decidePlaudDedupe({ ...candidate, sha256: 'b'.repeat(64) }, candidate)).toBe('mismatch');
    expect(guard.decidePlaudDedupe({ ...candidate, sourceFileId: 'plaud_file_9999' }, candidate)).toBe('new');
  });

  it('keeps processing local and cloud context redacted until recording-specific approval', () => {
    expect(guard.decidePlaudContentRoute()).toMatchObject({
      processing_route: 'local',
      chat_context: 'redacted_receipt_only',
      approval_required: false,
    });
    expect(guard.decidePlaudContentRoute({ requestedRoute: 'cloud' })).toMatchObject({
      processing_route: 'local',
      chat_context: 'redacted_receipt_only',
      approval_required: true,
    });
    expect(guard.decidePlaudContentRoute({ requestedRoute: 'cloud', explicitRecordingApproval: true })).toMatchObject({
      processing_route: 'cloud_approved',
      chat_context: 'recording_content_approved',
    });
  });

  it('denies automatic PLAUD AI commands and emits content-free zero-minute receipts', () => {
    expect(() => guard.assertPlaudCommandAllowed('transcript')).toThrow(/never allowed/i);
    expect(() => guard.assertPlaudCommandAllowed('summary')).toThrow(/never allowed/i);
    const receipt = guard.buildPlaudRedactedReceipt({
      processingState: 'transcribed',
      sourceFileId: 'plaud_file_1234',
      sha256: 'a'.repeat(64),
      bytes: 123,
      transcriptSegments: 4,
      transcript: 'private words',
      signedUrl: 'https://secret.example',
      artifactIds: ['transcript.raw', '/private/path'],
    });
    expect(receipt).toMatchObject({
      processing_state: 'transcribed',
      bytes: 123,
      transcript_segments: 4,
      artifact_ids: ['transcript.raw'],
      content_included: false,
      signed_url_logged: false,
      plaud_ai_minutes_consumed: 0,
    });
    expect(JSON.stringify(receipt)).not.toContain('private words');
    expect(JSON.stringify(receipt)).not.toContain('secret.example');
  });

  it('probes only the pinned official CLI and auth with a sanitized environment', () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const spawn = vi.fn((_command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ args, options });
      return args[0] === 'version'
        ? { status: 0, stdout: 'plaud 0.3.4\n' }
        : { status: 0, stdout: 'private account metadata\n' };
    });

    expect(
      guard.probePlaudCapability({ plaudCli: '/managed/plaud', spawn, env: { PATH: '/bin', SECRET_KEY: 'nope' } })
    ).toMatchObject({
      state: 'ready',
      official_package: '@plaud-ai/cli',
      required_cli_version: '0.3.4',
      authenticated: true,
      raw_output_included: false,
      plaud_ai_minutes_consumed: 0,
    });
    expect(calls.map((call) => call.args)).toEqual([['version'], ['me']]);
    for (const call of calls) {
      const environment = call.options.env as NodeJS.ProcessEnv;
      expect(environment.SECRET_KEY).toBeUndefined();
      expect(environment.PLAUD_TELEMETRY_DISABLED).toBe('1');
      expect(environment.DO_NOT_TRACK).toBe('1');
    }
  });

  it('reports clean-install and expired-auth blockers without exposing CLI output', () => {
    const missing = () => ({ status: 1, stdout: 'signed URL https://secret.example', error: new Error('missing') });
    expect(guard.probePlaudCapability({ spawn: missing })).toMatchObject({
      state: 'blocked_capability',
      raw_output_included: false,
    });

    const expired = (_command: string, args: string[]) =>
      args[0] === 'version' ? { status: 0, stdout: 'plaud 0.3.4\n' } : { status: 1, stdout: 'private profile' };
    expect(guard.probePlaudCapability({ spawn: expired })).toMatchObject({
      state: 'blocked_auth',
      raw_output_included: false,
    });
  });
});
