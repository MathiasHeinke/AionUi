/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEvePreparedImageDocument } from './eveImageIntelligenceCore';
import type { CommandEvePreparedPdfDocument } from './evePdfIntelligenceCore';

export const COMMAND_EVE_ATTACHMENT_GROUNDING_REQUEST_VERSION = 'command-eve-attachment-grounding/v1' as const;
export const COMMAND_EVE_ATTACHMENT_GROUNDING_RECEIPT_VERSION = 'command-eve-attachment-grounding-receipt/v1' as const;

export type CommandEveAttachmentGroundingKind = 'pdf' | 'image';

export type CommandEveAttachmentGroundingExpectation = {
  kind: CommandEveAttachmentGroundingKind;
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  grounding_path: string;
  grounding_sha256: string;
  grounding_bytes: number;
};

export type CommandEveAttachmentGroundingRequest = {
  version: typeof COMMAND_EVE_ATTACHMENT_GROUNDING_REQUEST_VERSION;
  entries: CommandEveAttachmentGroundingExpectation[];
};

export type CommandEveAttachmentGroundingReceiptEntry = CommandEveAttachmentGroundingExpectation & {
  grounding_embedded: true;
};

export type CommandEveAttachmentGroundingReceipt = {
  version: typeof COMMAND_EVE_ATTACHMENT_GROUNDING_RECEIPT_VERSION;
  status: 'accepted';
  entries: CommandEveAttachmentGroundingReceiptEntry[];
};

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_GROUNDING_ENTRIES = 12;
const MAX_GROUNDING_BYTES = 512 * 1024;

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]/.test(value))
  );
}

function normalizeEntry(value: unknown, receipt: boolean): CommandEveAttachmentGroundingReceiptEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    (entry.kind !== 'pdf' && entry.kind !== 'image') ||
    !isAbsolutePath(entry.source_path) ||
    !isAbsolutePath(entry.grounding_path) ||
    entry.source_path === entry.grounding_path ||
    typeof entry.source_sha256 !== 'string' ||
    !SHA256.test(entry.source_sha256) ||
    typeof entry.grounding_sha256 !== 'string' ||
    !SHA256.test(entry.grounding_sha256) ||
    typeof entry.source_bytes !== 'number' ||
    !Number.isSafeInteger(entry.source_bytes) ||
    entry.source_bytes < 1 ||
    typeof entry.grounding_bytes !== 'number' ||
    !Number.isSafeInteger(entry.grounding_bytes) ||
    entry.grounding_bytes < 1 ||
    entry.grounding_bytes > MAX_GROUNDING_BYTES ||
    (receipt && entry.grounding_embedded !== true)
  ) {
    return null;
  }
  return {
    kind: entry.kind,
    source_path: entry.source_path,
    source_sha256: entry.source_sha256,
    source_bytes: entry.source_bytes,
    grounding_path: entry.grounding_path,
    grounding_sha256: entry.grounding_sha256,
    grounding_bytes: entry.grounding_bytes,
    grounding_embedded: true,
  };
}

export function groundingExpectationFromPdf(
  document: CommandEvePreparedPdfDocument
): CommandEveAttachmentGroundingExpectation {
  return {
    kind: 'pdf',
    source_path: document.source_path,
    source_sha256: document.sha256,
    source_bytes: document.bytes,
    grounding_path: document.sidecar_path,
    grounding_sha256: document.sidecar_sha256,
    grounding_bytes: document.sidecar_bytes,
  };
}

export function groundingExpectationFromImage(
  document: CommandEvePreparedImageDocument
): CommandEveAttachmentGroundingExpectation {
  return {
    kind: 'image',
    source_path: document.source_path,
    source_sha256: document.sha256,
    source_bytes: document.bytes,
    grounding_path: document.sidecar_path,
    grounding_sha256: document.sidecar_sha256,
    grounding_bytes: document.sidecar_bytes,
  };
}

export function buildCommandEveAttachmentGroundingRequest(
  entries: readonly CommandEveAttachmentGroundingExpectation[]
): CommandEveAttachmentGroundingRequest | undefined {
  if (entries.length === 0) return undefined;
  const normalized = entries.map((entry) => normalizeEntry(entry, false));
  const normalizedEntries = normalized.filter(
    (entry): entry is CommandEveAttachmentGroundingReceiptEntry => entry !== null
  );
  if (
    entries.length > MAX_GROUNDING_ENTRIES ||
    normalizedEntries.length !== entries.length ||
    normalizedEntries.reduce((total, entry) => total + entry.grounding_bytes, 0) > MAX_GROUNDING_BYTES ||
    new Set(entries.map((entry) => entry.source_path)).size !== entries.length ||
    new Set(entries.map((entry) => entry.grounding_path)).size !== entries.length
  ) {
    return undefined;
  }
  return {
    version: COMMAND_EVE_ATTACHMENT_GROUNDING_REQUEST_VERSION,
    entries: normalizedEntries.map(({ grounding_embedded: _groundingEmbedded, ...entry }) => entry),
  };
}

export function normalizeCommandEveAttachmentGroundingRequest(
  value: unknown
): CommandEveAttachmentGroundingRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (
    request.version !== COMMAND_EVE_ATTACHMENT_GROUNDING_REQUEST_VERSION ||
    !Array.isArray(request.entries) ||
    request.entries.length < 1 ||
    request.entries.length > MAX_GROUNDING_ENTRIES
  ) {
    return undefined;
  }
  const entries = request.entries.map((entry) => normalizeEntry(entry, false));
  const normalizedEntries = entries.filter(
    (entry): entry is CommandEveAttachmentGroundingReceiptEntry => entry !== null
  );
  if (normalizedEntries.length !== entries.length) return undefined;
  return buildCommandEveAttachmentGroundingRequest(normalizedEntries);
}

export function validateCommandEveAttachmentGroundingReceipt(
  expected: CommandEveAttachmentGroundingRequest | undefined,
  value: unknown
): CommandEveAttachmentGroundingReceipt | null {
  if (!expected) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.version !== COMMAND_EVE_ATTACHMENT_GROUNDING_RECEIPT_VERSION ||
    receipt.status !== 'accepted' ||
    !Array.isArray(receipt.entries) ||
    receipt.entries.length !== expected.entries.length
  ) {
    return null;
  }
  const entries = receipt.entries.map((entry) => normalizeEntry(entry, true));
  if (entries.some((entry) => entry === null)) return null;
  const normalizedEntries = entries as CommandEveAttachmentGroundingReceiptEntry[];
  if (
    normalizedEntries.some((entry, index) => {
      const wanted = expected.entries[index];
      return (
        entry.kind !== wanted.kind ||
        entry.source_path !== wanted.source_path ||
        entry.source_sha256 !== wanted.source_sha256 ||
        entry.source_bytes !== wanted.source_bytes ||
        entry.grounding_path !== wanted.grounding_path ||
        entry.grounding_sha256 !== wanted.grounding_sha256 ||
        entry.grounding_bytes !== wanted.grounding_bytes
      );
    })
  ) {
    return null;
  }
  return {
    version: COMMAND_EVE_ATTACHMENT_GROUNDING_RECEIPT_VERSION,
    status: 'accepted',
    entries: normalizedEntries,
  };
}
