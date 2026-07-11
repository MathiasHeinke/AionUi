export type PhaseStats = {
  count: number;
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
};

type MemorySnapshotMb = {
  processTreeRssMb?: number;
  rendererHeapMb?: number;
};

type StartupGateReport = {
  measurementMode?: string;
  failed?: number;
  stats?: Record<string, PhaseStats | undefined>;
  memory?: {
    idle?: MemorySnapshotMb;
    leakEstimateMb?: number;
  };
  memorySummary?: {
    idleRendererUsed?: PhaseStats;
    idleProcessTreeRss?: PhaseStats;
    leakProcessTreeRssBytes?: PhaseStats;
  } | null;
};

export type StartupGateThresholds = {
  coldStartWindowMs: number;
  processTreeRssIdleMb: number;
  rendererHeapIdleMb: number;
  leakAfterCloseMb: number;
};

export const STARTUP_GATE_THRESHOLDS: StartupGateThresholds = {
  coldStartWindowMs: 3000,
  processTreeRssIdleMb: 600,
  rendererHeapIdleMb: 150,
  leakAfterCloseMb: 50,
};

function bytesToMb(bytes: number | undefined): number | undefined {
  if (bytes === undefined || !Number.isFinite(bytes)) return undefined;
  return bytes / 1024 / 1024;
}

function hasMetric(stats: PhaseStats | undefined): boolean {
  return !!stats && stats.count > 0 && Number.isFinite(stats.mean) && Number.isFinite(stats.median);
}

function hasPositiveMetric(stats: PhaseStats | undefined): boolean {
  return hasMetric(stats) && stats.mean > 0 && stats.median > 0;
}

function overThreshold(value: number | undefined, threshold: number): boolean {
  return value !== undefined && Number.isFinite(value) && value > threshold;
}

function isPositiveFinite(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function collectStartupGateFailures(
  report: StartupGateReport | null | undefined,
  thresholds: StartupGateThresholds = STARTUP_GATE_THRESHOLDS
): string[] {
  if (!report) return ['startup report is missing'];

  const failures: string[] = [];
  if ((report.failed ?? 0) > 0) {
    failures.push(`startup iterations failed: ${report.failed}`);
  }

  const wallStats = report.stats?.wallTimeToInteractive;
  if (!hasPositiveMetric(wallStats)) {
    failures.push('wallTimeToInteractive.mean is missing');
  }

  const wallMean = wallStats?.mean;
  if (overThreshold(wallMean, thresholds.coldStartWindowMs)) {
    failures.push(
      `wallTimeToInteractive.mean ${Math.round(wallMean ?? 0)}ms exceeds ${thresholds.coldStartWindowMs}ms`
    );
  }

  const processTreeStats = report.memorySummary?.idleProcessTreeRss;
  const processTreeRssIdleMb =
    report.memory?.idle?.processTreeRssMb ??
    (hasPositiveMetric(processTreeStats) ? bytesToMb(processTreeStats?.median) : undefined);
  if (!isPositiveFinite(processTreeRssIdleMb)) {
    failures.push('idle process-tree RSS is missing');
  }
  if (overThreshold(processTreeRssIdleMb, thresholds.processTreeRssIdleMb)) {
    failures.push(
      `idle process-tree RSS ${Math.round(processTreeRssIdleMb ?? 0)}MB exceeds ${thresholds.processTreeRssIdleMb}MB`
    );
  }

  const rendererHeapStats = report.memorySummary?.idleRendererUsed;
  const rendererHeapIdleMb =
    report.memory?.idle?.rendererHeapMb ??
    (hasPositiveMetric(rendererHeapStats) ? bytesToMb(rendererHeapStats?.median) : undefined);
  const rendererHeapRequired = report.measurementMode !== 'packaged-lifecycle';
  if (rendererHeapRequired && !isPositiveFinite(rendererHeapIdleMb)) {
    failures.push('idle renderer heap is missing');
  }
  if (overThreshold(rendererHeapIdleMb, thresholds.rendererHeapIdleMb)) {
    failures.push(
      `idle renderer heap ${Math.round(rendererHeapIdleMb ?? 0)}MB exceeds ${thresholds.rendererHeapIdleMb}MB`
    );
  }

  const leakStats = report.memorySummary?.leakProcessTreeRssBytes;
  const leakEstimateMb = report.memory?.leakEstimateMb ?? (hasMetric(leakStats) ? bytesToMb(leakStats?.median) : undefined);
  const leakRequired = report.measurementMode !== 'packaged-lifecycle';
  if (leakRequired && (leakEstimateMb === undefined || !Number.isFinite(leakEstimateMb))) {
    failures.push('post-close leak estimate is missing');
  }
  if (overThreshold(leakEstimateMb, thresholds.leakAfterCloseMb)) {
    failures.push(`post-close leak ${Math.round(leakEstimateMb ?? 0)}MB exceeds ${thresholds.leakAfterCloseMb}MB`);
  }

  return failures;
}
