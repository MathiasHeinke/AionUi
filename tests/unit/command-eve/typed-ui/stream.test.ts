/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTypedUIStreamAccumulator } from '@/common/typedUI';
import { describe, expect, it } from 'vitest';
import { typedUIFixture } from './fixtures';

describe('Typed UI atomic stream accumulator', () => {
  it('keeps a parseable prefix partial until explicit finalization', () => {
    const stream = createTypedUIStreamAccumulator();
    expect(stream.push(JSON.stringify(typedUIFixture()))).toMatchObject({ status: 'partial' });
    expect(stream.finish()).toMatchObject({ status: 'ready', value: typedUIFixture() });
  });

  it('rejects trailing data instead of accepting the first valid prefix', () => {
    const stream = createTypedUIStreamAccumulator();
    expect(stream.push(JSON.stringify(typedUIFixture()))).toMatchObject({ status: 'partial' });
    expect(stream.push('MALICIOUS')).toMatchObject({ status: 'partial' });
    expect(stream.finish()).toMatchObject({ status: 'invalid', issues: [{ code: 'stream.invalid_json' }] });
  });

  it('invalidates any data pushed after finalization', () => {
    const stream = createTypedUIStreamAccumulator();
    stream.push(JSON.stringify(typedUIFixture()));
    expect(stream.finish()).toMatchObject({ status: 'ready' });
    expect(stream.push('late')).toMatchObject({ status: 'invalid', issues: [{ code: 'stream.trailing_data' }] });
  });
});
