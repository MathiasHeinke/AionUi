#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PLAUD_OFFICIAL_PACKAGE = '@plaud-ai/cli';
export const PLAUD_PINNED_CLI_VERSION = '0.3.4';
export const PLAUD_AI_COMMANDS = Object.freeze(['transcript', 'summary']);

const PROCESSING_STATES = new Set([
  'discovered',
  'audio_pending',
  'downloaded',
  'transcribed',
  'speaker_partial',
  'synthesized',
  'complete',
  'blocked_auth',
  'blocked_capability',
  'failed',
]);

const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
]);

export function sanitizedPlaudEnvironment(source = process.env) {
  const environment = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key]) environment[key] = source[key];
  }
  environment.PLAUD_TELEMETRY_DISABLED = '1';
  environment.DO_NOT_TRACK = '1';
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  return environment;
}

export function assertPlaudCommandAllowed(command) {
  const normalized = String(command || '')
    .trim()
    .toLowerCase();
  if (PLAUD_AI_COMMANDS.includes(normalized)) {
    throw new Error(`PLAUD ${normalized} is never allowed on the automatic ingest path.`);
  }
  if (!['version', 'me', 'files', 'file', 'audio', 'recent', 'search'].includes(normalized)) {
    throw new Error('Unsupported PLAUD source command.');
  }
  return normalized;
}

export function redactPlaudSensitiveText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/https:\/\/[^\s"'<>]+/giu, '[REDACTED_URL]')
    .replace(/(Audio Download URL:\s*)(?:\r?\n)?[^\r\n]*/giu, '$1[REDACTED_URL]');
}

export function classifyPlaudAudioState({ recordingFound, audioReady }) {
  if (!recordingFound) return 'failed';
  return audioReady ? 'discovered' : 'audio_pending';
}

export function decidePlaudDedupe(existing, candidate) {
  if (!existing) return 'new';
  const sameId = existing.sourceFileId === candidate.sourceFileId;
  if (!sameId) return 'new';
  return existing.sha256 === candidate.sha256 ? 'reuse' : 'mismatch';
}

export function decidePlaudContentRoute({
  requestedRoute = 'local',
  onlineChatModel = true,
  explicitRecordingApproval = false,
} = {}) {
  if (requestedRoute === 'cloud' && explicitRecordingApproval) {
    return {
      processing_route: 'cloud_approved',
      chat_context: 'recording_content_approved',
      approval_required: false,
    };
  }
  return {
    processing_route: 'local',
    chat_context: onlineChatModel ? 'redacted_receipt_only' : 'local_only',
    approval_required: requestedRoute === 'cloud',
  };
}

function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

export function buildPlaudRedactedReceipt(input) {
  const state = String(input?.processingState || 'failed');
  if (!PROCESSING_STATES.has(state)) throw new Error('Unknown PLAUD processing state.');
  const sourceFileId = String(input?.sourceFileId || '');
  const sha256 = String(input?.sha256 || '').toLowerCase();
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(sourceFileId)) throw new Error('Invalid PLAUD file identity.');
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid PLAUD audio digest.');

  const artifactIds = Array.isArray(input?.artifactIds)
    ? input.artifactIds
        .map(String)
        .filter((value) => /^[A-Za-z0-9._:-]{1,128}$/u.test(value))
        .slice(0, 16)
    : [];
  return {
    schema_version: 1,
    source: 'plaud',
    processing_state: state,
    source_identity_sha256: createHash('sha256').update(`${sourceFileId}\0${sha256}`).digest('hex'),
    audio_sha256: sha256,
    bytes: nonNegativeInteger(input?.bytes),
    transcript_segments: nonNegativeInteger(input?.transcriptSegments),
    transcript_characters: nonNegativeInteger(input?.transcriptCharacters),
    speaker_label_count: nonNegativeInteger(input?.speakerLabelCount),
    artifact_ids: artifactIds,
    content_included: false,
    signed_url_logged: false,
    plaud_ai_minutes_consumed: 0,
  };
}

function runCaptured(spawn, command, args, environment) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    shell: false,
    env: environment,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || ''),
  };
}

export function probePlaudCapability({ plaudCli = 'plaud', spawn = spawnSync, env = process.env } = {}) {
  const environment = sanitizedPlaudEnvironment(env);
  const versionResult = runCaptured(spawn, plaudCli, [assertPlaudCommandAllowed('version')], environment);
  const versionMatch = versionResult.stdout.match(/\bplaud\s+(\d+\.\d+\.\d+)\b/iu);
  const observedVersion = versionMatch?.[1];
  if (!versionResult.ok || observedVersion !== PLAUD_PINNED_CLI_VERSION) {
    return {
      schema_version: 1,
      source: 'plaud',
      state: 'blocked_capability',
      official_package: PLAUD_OFFICIAL_PACKAGE,
      required_cli_version: PLAUD_PINNED_CLI_VERSION,
      observed_cli_version: observedVersion || null,
      authenticated: false,
      raw_output_included: false,
      plaud_ai_minutes_consumed: 0,
      recovery_action: `Install the official ${PLAUD_OFFICIAL_PACKAGE}@${PLAUD_PINNED_CLI_VERSION} through Command EVE's guided dependency flow.`,
    };
  }

  const authResult = runCaptured(spawn, plaudCli, [assertPlaudCommandAllowed('me')], environment);
  if (!authResult.ok) {
    return {
      schema_version: 1,
      source: 'plaud',
      state: 'blocked_auth',
      official_package: PLAUD_OFFICIAL_PACKAGE,
      required_cli_version: PLAUD_PINNED_CLI_VERSION,
      observed_cli_version: observedVersion,
      authenticated: false,
      raw_output_included: false,
      plaud_ai_minutes_consumed: 0,
      recovery_action: 'Complete plaud login locally. Never paste credentials into chat.',
    };
  }

  return {
    schema_version: 1,
    source: 'plaud',
    state: 'ready',
    official_package: PLAUD_OFFICIAL_PACKAGE,
    required_cli_version: PLAUD_PINNED_CLI_VERSION,
    observed_cli_version: observedVersion,
    authenticated: true,
    raw_output_included: false,
    plaud_ai_minutes_consumed: 0,
    recovery_action: null,
  };
}

function valueFor(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'status') {
    process.stderr.write('Usage: node plaud-ingest-guard.mjs status [--plaud-cli <path>]\n');
    process.exitCode = 2;
    return;
  }
  const receipt = probePlaudCapability({ plaudCli: valueFor(args, '--plaud-cli') || process.env.PLAUD_CLI || 'plaud' });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.state !== 'ready') process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
