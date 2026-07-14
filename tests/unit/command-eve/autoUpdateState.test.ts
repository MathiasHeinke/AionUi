import { describe, expect, it } from 'vitest';

import { mergeAutoUpdateStatus } from '@/common/update/autoUpdateState';

describe('mergeAutoUpdateStatus', () => {
  it('preserves version and notes when progress events omit metadata', () => {
    const available = mergeAutoUpdateStatus(null, {
      status: 'available',
      version: '1.8.12',
      releaseNotes: 'Quiet background download',
    });
    const downloading = mergeAutoUpdateStatus(available, {
      status: 'downloading',
      progress: { bytesPerSecond: 2, percent: 25, transferred: 25, total: 100 },
    });

    expect(downloading).toMatchObject({
      status: 'downloading',
      version: '1.8.12',
      releaseNotes: 'Quiet background download',
      progress: { percent: 25 },
    });
  });

  it('does not lose an installable package during a later no-update check', () => {
    const downloaded = { status: 'downloaded' as const, version: '1.8.12' };
    const checking = mergeAutoUpdateStatus(downloaded, { status: 'checking' });
    const notAvailable = mergeAutoUpdateStatus(checking, { status: 'not-available' });

    expect(notAvailable).toEqual(downloaded);
  });

  it.each(['error', 'cancelled'] as const)(
    'does not lose an installable package when a later check ends as %s',
    (status) => {
      const downloaded = {
        status: 'downloaded' as const,
        version: '1.8.12',
        releaseNotes: 'Already on disk',
      };
      const next = mergeAutoUpdateStatus(downloaded, {
        status,
        error: 'Network unavailable',
      });

      expect(next).toEqual(downloaded);
    }
  );

  it('lets a newer feed result supersede a deferred package', () => {
    const next = mergeAutoUpdateStatus(
      { status: 'downloaded', version: '1.8.12', releaseNotes: 'Old notes' },
      { status: 'available', version: '1.8.13', releaseNotes: 'New notes' }
    );

    expect(next).toEqual({
      status: 'available',
      version: '1.8.13',
      releaseNotes: 'New notes',
      progress: undefined,
    });
  });
});
