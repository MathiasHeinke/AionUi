/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A renderer may ask Main to materialize one already-managed image as a private
 * agent attachment for a document-producing turn. Main alone resolves bytes
 * and returns the resulting private attachment path.
 *
 * This contract deliberately carries no path in a message, prepared context or
 * tool result. Its path is an IPC-only value consumed as an existing `agentFile`.
 */

export type CommandEveManagedArtifactInputRequest = {
  conversationId: string;
  artifactId: string;
  /**
   * A bounded source identifier read from the selected PDF artifact. Main
   * resolves and verifies it against the conversation workspace or Downloads;
   * it never enters the transcript or display attachment list.
   */
  sourcePath?: string;
};

export type CommandEveManagedArtifactInputRefusalReason =
  | 'invalid-request'
  | 'artifact-unavailable'
  | 'seat-changed'
  | 'source-unsafe'
  | 'stage-failed';

export type CommandEveManagedArtifactInputResolution =
  | Readonly<{ status: 'ready'; agentFilePath: string }>
  | Readonly<{ status: 'refused'; reasonCode: CommandEveManagedArtifactInputRefusalReason }>;
