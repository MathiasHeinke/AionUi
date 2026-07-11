import { describe, expect, it } from 'vitest';

import { collectStartupGateFailures } from '../../../scripts/benchmark-gates';

const stats = (mean: number, median = mean) => ({
  count: 5,
  mean,
  median,
  p95: mean,
  min: mean,
  max: mean,
});

describe('benchmark startup gates', () => {
  it('passes when startup and memory stay under red lines', () => {
    expect(
      collectStartupGateFailures({
        failed: 0,
        stats: { wallTimeToInteractive: stats(2500) },
        memory: { idle: { processTreeRssMb: 420, rendererHeapMb: 80 }, leakEstimateMb: 12 },
      })
    ).toEqual([]);
  });

  it('fails startup iteration, latency, memory, heap, and leak red lines', () => {
    expect(
      collectStartupGateFailures({
        failed: 1,
        stats: { wallTimeToInteractive: stats(5669) },
        memory: { idle: { processTreeRssMb: 640, rendererHeapMb: 180 }, leakEstimateMb: 75 },
      })
    ).toEqual([
      'startup iterations failed: 1',
      'wallTimeToInteractive.mean 5669ms exceeds 3000ms',
      'idle process-tree RSS 640MB exceeds 600MB',
      'idle renderer heap 180MB exceeds 150MB',
      'post-close leak 75MB exceeds 50MB',
    ]);
  });

  it('evaluates raw benchmark-startup memory summaries in bytes', () => {
    expect(
      collectStartupGateFailures({
        failed: 0,
        stats: { wallTimeToInteractive: stats(2500) },
        memorySummary: {
          idleProcessTreeRss: stats(650 * 1024 * 1024),
          idleRendererUsed: stats(151 * 1024 * 1024),
          leakProcessTreeRssBytes: stats(51 * 1024 * 1024),
        },
      })
    ).toEqual([
      'idle process-tree RSS 650MB exceeds 600MB',
      'idle renderer heap 151MB exceeds 150MB',
      'post-close leak 51MB exceeds 50MB',
    ]);
  });

  it('fails closed when strict startup evidence is incomplete', () => {
    expect(collectStartupGateFailures({ failed: 0, stats: {}, memorySummary: null })).toEqual([
      'wallTimeToInteractive.mean is missing',
      'idle process-tree RSS is missing',
      'idle renderer heap is missing',
      'post-close leak estimate is missing',
    ]);
  });

  it('requires only signed-packaged evidence available without CDP', () => {
    expect(
      collectStartupGateFailures({
        measurementMode: 'packaged-lifecycle',
        failed: 0,
        stats: { wallTimeToInteractive: stats(2500) },
        memorySummary: {
          idleProcessTreeRss: stats(420 * 1024 * 1024),
          idleRendererUsed: stats(0, 0),
          leakProcessTreeRssBytes: stats(0, 0),
        },
      })
    ).toEqual([]);
  });

  it('fails signed packaged lifecycle when process-tree RSS evidence is missing', () => {
    expect(
      collectStartupGateFailures({
        measurementMode: 'packaged-lifecycle',
        failed: 0,
        stats: { wallTimeToInteractive: stats(2500) },
        memorySummary: {
          idleProcessTreeRss: stats(0, 0),
          idleRendererUsed: stats(0, 0),
          leakProcessTreeRssBytes: stats(0, 0),
        },
      })
    ).toEqual(['idle process-tree RSS is missing']);
  });

  it('rejects zero adapted values for required startup evidence', () => {
    expect(
      collectStartupGateFailures({
        measurementMode: 'playwright',
        failed: 0,
        stats: { wallTimeToInteractive: stats(0, 0) },
        memory: { idle: { processTreeRssMb: 0, rendererHeapMb: 0 }, leakEstimateMb: 0 },
      })
    ).toEqual([
      'wallTimeToInteractive.mean is missing',
      'idle process-tree RSS is missing',
      'idle renderer heap is missing',
    ]);
  });

  it('rejects mean-zero wall time even when median is positive', () => {
    expect(
      collectStartupGateFailures({
        measurementMode: 'playwright',
        failed: 0,
        stats: { wallTimeToInteractive: stats(0, 2500) },
        memory: { idle: { processTreeRssMb: 420, rendererHeapMb: 80 }, leakEstimateMb: 0 },
      })
    ).toEqual(['wallTimeToInteractive.mean is missing']);
  });
});
