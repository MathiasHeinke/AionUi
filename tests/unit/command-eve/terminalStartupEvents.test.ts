import { describe, expect, it } from 'vitest';

import { createTerminalStartupEventBuffer } from '@/renderer/pages/conversation/Preview/services/terminalStartupEvents';

describe('Command EVE terminal startup event buffer', () => {
  it('replays early output and exit in order once the server terminal id is known', () => {
    const buffer = createTerminalStartupEventBuffer();
    buffer.pushData({ terminalId: 'terminal-a', data: 'prompt' });
    buffer.pushData({ terminalId: 'terminal-b', data: 'foreign' });
    buffer.pushData({ terminalId: 'terminal-a', data: '> ' });
    buffer.pushExit({ terminalId: 'terminal-a', exitCode: 0 });

    expect(buffer.drain('terminal-a')).toEqual([
      { kind: 'data', event: { terminalId: 'terminal-a', data: 'prompt' } },
      { kind: 'data', event: { terminalId: 'terminal-a', data: '> ' } },
      { kind: 'exit', event: { terminalId: 'terminal-a', exitCode: 0 } },
    ]);
    expect(buffer.drain('terminal-a')).toEqual([]);
  });

  it('drops pending startup events after an aborted start', () => {
    const buffer = createTerminalStartupEventBuffer();
    buffer.pushData({ terminalId: 'terminal-a', data: 'must not leak' });
    buffer.clear();
    buffer.pushData({ terminalId: 'terminal-a', data: 'late' });
    expect(buffer.drain('terminal-a')).toEqual([]);
  });
});
