/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_MAX_BYTES, validateTypedUIEnvelope } from './schema';
import type { TypedUIStreamState, TypedUIValidationIssue } from './types';

export interface TypedUIStreamAccumulator {
  push(chunk: string): TypedUIStreamState;
  finish(): TypedUIStreamState;
  reset(): void;
}

export function createTypedUIStreamAccumulator(): TypedUIStreamAccumulator {
  let buffer = '';
  let terminal: TypedUIStreamState | undefined;
  let finished = false;

  const bytes = (): number => new TextEncoder().encode(buffer).byteLength;
  const invalid = (issues: TypedUIValidationIssue[]): TypedUIStreamState => {
    terminal = { status: 'invalid', bytes: bytes(), issues };
    return terminal;
  };
  const finalize = (): TypedUIStreamState => {
    if (terminal) return terminal;
    if (bytes() > TYPED_UI_MAX_BYTES) {
      return invalid([
        { code: 'stream.too_large', path: '$', message: `Typed UI stream exceeds ${TYPED_UI_MAX_BYTES} bytes.` },
      ]);
    }
    try {
      const parsed = JSON.parse(buffer) as unknown;
      const result = validateTypedUIEnvelope(parsed);
      if ('issues' in result) return invalid(result.issues);
      terminal = { status: 'ready', bytes: bytes(), value: result.value };
      return terminal;
    } catch {
      return invalid([{ code: 'stream.invalid_json', path: '$', message: 'Final Typed UI stream is not valid JSON.' }]);
    }
  };

  return {
    push(chunk) {
      if (finished) {
        return invalid([
          { code: 'stream.trailing_data', path: '$', message: 'Typed UI received data after stream finalization.' },
        ]);
      }
      if (terminal) return terminal;
      buffer += chunk;
      if (bytes() > TYPED_UI_MAX_BYTES) {
        return invalid([
          { code: 'stream.too_large', path: '$', message: `Typed UI stream exceeds ${TYPED_UI_MAX_BYTES} bytes.` },
        ]);
      }
      return { status: 'partial', bytes: bytes() };
    },
    finish() {
      if (finished && terminal) return terminal;
      finished = true;
      return finalize();
    },
    reset() {
      buffer = '';
      terminal = undefined;
      finished = false;
    },
  };
}
