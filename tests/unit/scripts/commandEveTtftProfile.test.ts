import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveCommandEveTtftDataRoot,
  resolveCommandEveTtftRuntimeRoot,
} from '../../../scripts/command-eve/ttft/profile-core';

describe('Command EVE TTFT profile paths', () => {
  it('resolves product receipts below the canonical Command EVE data child', () => {
    const profileRoot = path.join(path.sep, 'tmp', 'command-eve-ttft-profile');

    expect(resolveCommandEveTtftDataRoot(profileRoot)).toBe(path.join(profileRoot, 'command-eve'));
    expect(resolveCommandEveTtftRuntimeRoot(profileRoot)).toBe(
      path.join(profileRoot, 'command-eve', 'command-eve-runtime')
    );
  });
});
