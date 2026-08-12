/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  TYPED_UI_SCHEMA_VERSION,
} from '@/common/typedUI';
import type { TMessage } from '@/common/chat/chatLib';
import { attestDurableTypedUIArtifact } from '@/process/commandEve/typedUIArtifactAttestationMain';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  hashTypedUIEnvelope,
  TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
} from '@/process/commandEve/typedUIProvenanceAttestationCore';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const seat = { activeSeatId: 'seat-production', seatContextRevision: 21 };
const callId = 'call-production-1';
const artifact = {
  artifact_id: `tool-artifact-${callId}`,
  conversation_id: 'conversation-production-1',
  source_message_id: 'message-production-1',
  created_at: Date.parse('2026-08-11T12:00:01.000Z'),
};

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-production-attestation-'));
  temporaryDirectories.push(directory);
  return {
    attestationAuditPath: path.join(directory, 'audit', 'attestations.jsonl'),
    generationLedgerPath: path.join(directory, 'audit', 'generations.jsonl'),
    providerCompletionLedgerPath: path.join(directory, 'audit', 'provider-completions.jsonl'),
  };
}

function resultPayload(rawEnvelope = typedUIFixture()) {
  return {
    ok: true,
    artifact_type: 'file',
    mime_type: TYPED_UI_MIME_TYPE,
    schema_version: TYPED_UI_SCHEMA_VERSION,
    catalog_version: TYPED_UI_CATALOG_VERSION,
    content: JSON.stringify(rawEnvelope),
  };
}

function message(rawEnvelope = typedUIFixture(), overrides: Partial<TMessage> = {}): TMessage {
  return {
    id: artifact.source_message_id,
    msg_id: artifact.source_message_id,
    conversation_id: artifact.conversation_id,
    type: 'tool_group',
    created_at: artifact.created_at,
    content: [
      {
        call_id: callId,
        name: 'eve_typed_ui_publish',
        description: 'Typed UI',
        render_output_as_markdown: false,
        result_display: resultPayload(rawEnvelope),
        status: 'Success',
      },
    ],
    ...overrides,
  } as TMessage;
}

function acpMessage(rawEnvelope = typedUIFixture(), overrides: Partial<TMessage> = {}): TMessage {
  return {
    id: artifact.source_message_id,
    msg_id: artifact.source_message_id,
    conversation_id: artifact.conversation_id,
    type: 'acp_tool_call',
    created_at: artifact.created_at,
    content: {
      session_id: 'session-production',
      update: {
        session_update: 'tool_call_update',
        tool_call_id: callId,
        status: 'completed',
        title: 'Typed UI',
        kind: 'execute',
        raw_output: {
          ...resultPayload(rawEnvelope),
          status: 'completed',
          tool_name: 'mcp__aionui_eve_artifacts__eve_typed_ui_publish',
        },
      },
    },
    ...overrides,
  } as unknown as TMessage;
}

function completion(paths: ReturnType<typeof workspace>, rawEnvelope = typedUIFixture(), suffix = '') {
  return appendMainOwnedTypedUIProviderCompletionReceipt(paths.providerCompletionLedgerPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: `session-production${suffix}`,
    provider: `actual-provider${suffix}`,
    model: `actual-model${suffix}`,
    provider_request_id: `provider-request${suffix}`,
    tool_call_id: callId,
    raw_content_sha256: hashTypedUIEnvelope(rawEnvelope),
    route_receipt: {
      receipt_id: `route-production${suffix}`,
      route: 'connected',
      status: 'completed',
      terminal: 'openai_json',
      http_status: 200,
    },
    seat_id: seat.activeSeatId,
    seat_context_revision: seat.seatContextRevision,
    completed_at: '2026-08-11T12:00:00.000Z',
  });
}

function request(rawEnvelope = typedUIFixture()) {
  return {
    version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
    envelope: bindTypedUIEnvelopeToArtifact(rawEnvelope, artifact),
    artifact,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('production durable Typed UI artifact attestation', () => {
  it('joins one real provider completion to the exact durable AionCore message and returns provider-free proof', async () => {
    const paths = workspace();
    const rawEnvelope = typedUIFixture();
    completion(paths, rawEnvelope);
    const readMessage = vi.fn(async () => message(rawEnvelope));
    const result = await attestDurableTypedUIArtifact(paths, request(rawEnvelope), seat, { readMessage });

    expect(result.status).toBe('verified');
    expect(result.artifact_id).toBe(artifact.artifact_id);
    expect(readMessage).toHaveBeenCalledWith(artifact.conversation_id, artifact.source_message_id);
    const ledgers = [paths.providerCompletionLedgerPath, paths.generationLedgerPath, paths.attestationAuditPath]
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(ledgers).not.toContain('actual-provider');
    expect(ledgers).not.toContain('actual-model');
    expect(ledgers).not.toContain('provider-request');
    expect(ledgers).not.toContain('"tool_call_id":');
  });

  it('joins one terminal durable ACP raw_output without inferring a tool name from its title', async () => {
    const paths = workspace();
    const rawEnvelope = typedUIFixture();
    completion(paths, rawEnvelope);
    const durable = acpMessage(rawEnvelope);
    if (durable.type === 'acp_tool_call') {
      (durable.content as unknown as { update: { title: string } }).update.title = 'arbitrary presentation title';
    }

    await expect(
      attestDurableTypedUIArtifact(paths, request(rawEnvelope), seat, { readMessage: async () => durable })
    ).resolves.toMatchObject({
      status: 'verified',
      artifact_id: artifact.artifact_id,
    });
  });

  it('accepts the bare compatibility name on a persisted ACP row with the exact provider call id', async () => {
    const paths = workspace();
    const rawEnvelope = typedUIFixture();
    // The Main-owned producer receipt and durable ACP update must carry the
    // identical upstream provider id; neither side may derive a replacement.
    completion(paths, rawEnvelope);
    const durable = acpMessage(rawEnvelope);
    if (durable.type === 'acp_tool_call') {
      const rawOutput = (durable.content as unknown as { update: { raw_output: Record<string, unknown> } }).update
        .raw_output;
      rawOutput.tool_name = 'eve_typed_ui_publish';
      // AionCore currently injects this marker, but the durable contract keeps
      // it optional so historical persisted rows remain safely readable.
      delete rawOutput.status;
    }

    await expect(
      attestDurableTypedUIArtifact(paths, request(rawEnvelope), seat, { readMessage: async () => durable })
    ).resolves.toMatchObject({
      status: 'verified',
      artifact_id: artifact.artifact_id,
    });
  });

  it.each([
    [
      'wrong call',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { tool_call_id: string } }).update.tool_call_id = 'call-other'),
    ],
    [
      'nonterminal',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { status: string } }).update.status = 'in_progress'),
    ],
    [
      'malformed result',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { raw_output: unknown } }).update.raw_output = { ok: true }),
    ],
    [
      'extra result key',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { raw_output: unknown } }).update.raw_output = {
          ...resultPayload(),
          status: 'completed',
          unexpected: true,
        }),
    ],
    [
      'missing executed tool identity',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        delete (value.content as unknown as { update: { raw_output: Record<string, unknown> } }).update.raw_output
          .tool_name,
    ],
    [
      'non-target executed tool identity',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { raw_output: { tool_name: string } } }).update.raw_output.tool_name =
          'mcp__other__eve_typed_ui_publish'),
    ],
    [
      'oversized result',
      (value: TMessage) =>
        value.type === 'acp_tool_call' &&
        ((value.content as unknown as { update: { raw_output: unknown } }).update.raw_output = {
          ...resultPayload(),
          status: 'completed',
          content: 'x'.repeat(512 * 1024 + 1),
        }),
    ],
  ])('rejects %s ACP durable evidence', async (_label, mutate) => {
    const paths = workspace();
    completion(paths);
    const durable = acpMessage();
    mutate(durable);
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, { readMessage: async () => durable })
    ).rejects.toThrow('attestation.durable_');
  });

  it('fails closed with no producer and does not manufacture a generation receipt', async () => {
    const paths = workspace();
    const result = await attestDurableTypedUIArtifact(paths, request(), seat, {
      readMessage: async () => message(),
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'trusted_generation_receipt_missing' });
    expect(fs.existsSync(paths.generationLedgerPath)).toBe(false);
  });

  it('rejects forged renderer content and durable result/provider evidence substitution', async () => {
    const paths = workspace();
    completion(paths);
    const forged = request();
    forged.envelope.elements.heading.props.text = 'renderer mutation';
    await expect(
      attestDurableTypedUIArtifact(paths, forged, seat, { readMessage: async () => message() })
    ).rejects.toThrow('attestation.durable_content_mismatch');

    const durablePayload = resultPayload() as Record<string, unknown>;
    durablePayload.provider = 'renderer-forgery';
    const forgedMessage = message(typedUIFixture());
    if (forgedMessage.type === 'tool_group') forgedMessage.content[0].result_display = durablePayload;
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, { readMessage: async () => forgedMessage })
    ).rejects.toThrow('attestation.durable_result_invalid');
  });

  it('rejects cross-conversation, wrong-call, non-success, and ambiguous provider correlations', async () => {
    const paths = workspace();
    completion(paths);
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, {
        readMessage: async () => message(typedUIFixture(), { conversation_id: 'conversation-other' }),
      })
    ).rejects.toThrow('attestation.durable_message_mismatch');

    const wrongCall = message();
    if (wrongCall.type === 'tool_group') wrongCall.content[0].call_id = 'call-other';
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, { readMessage: async () => wrongCall })
    ).rejects.toThrow('attestation.durable_tool_call_mismatch');

    const failed = message();
    if (failed.type === 'tool_group') failed.content[0].status = 'Error';
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, { readMessage: async () => failed })
    ).rejects.toThrow('attestation.durable_tool_call_mismatch');

    completion(paths, typedUIFixture(), '-duplicate');
    await expect(
      attestDurableTypedUIArtifact(paths, request(), seat, { readMessage: async () => message() })
    ).rejects.toThrow('attestation.provider_completion_ambiguous');
  });

  it('is idempotent for the same immutable message and rejects a stale seat revision', async () => {
    const paths = workspace();
    completion(paths);
    const readMessage = vi.fn(async () => message());
    const deps = { readMessage };
    const first = await attestDurableTypedUIArtifact(paths, request(), seat, deps);
    const second = await attestDurableTypedUIArtifact(paths, request(), seat, deps);
    expect(second.attestation_id).toBe(first.attestation_id);
    expect(readMessage).toHaveBeenCalledTimes(1);
    const stale = await attestDurableTypedUIArtifact(paths, request(), { ...seat, seatContextRevision: 22 }, deps);
    expect(stale).toMatchObject({ status: 'rejected', reason: 'seat_revision_mismatch' });
    expect(readMessage).toHaveBeenCalledTimes(2);
  });
});
