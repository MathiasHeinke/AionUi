import { defineConfig } from 'vitest/config';
import path from 'path';

const aliases = {
  '@/': path.resolve(__dirname, './packages/desktop/src') + '/',
  '@process/': path.resolve(__dirname, './packages/desktop/src/process') + '/',
  '@renderer/': path.resolve(__dirname, './packages/desktop/src/renderer') + '/',
  '@worker/': path.resolve(__dirname, './packages/desktop/src/process/worker') + '/',
  '@mcp/models/': path.resolve(__dirname, './packages/desktop/src/common/models') + '/',
  '@mcp/types/': path.resolve(__dirname, './packages/desktop/src/common') + '/',
  '@mcp/': path.resolve(__dirname, './packages/desktop/src/common') + '/',
};

/**
 * Tests that spawn a real `process.execPath` child and block on it.
 *
 * Listed explicitly rather than matched by a path pattern: spawning a child is a
 * property of what a test does, not of where it lives, and a glob would either
 * miss a new one or quietly pull in a neighbour that does not need the slot.
 */
const SUBPROCESS_TEST_FILES = [
  'tests/unit/assets/prepareAioncoreReuse.test.ts',
  'tests/unit/bootstrap/buildWithBuilder.test.ts',
  'tests/unit/command-eve/runtimeBridgeRegistration.test.ts',
  'tests/unit/e2e-harness/e2eBaselineDiff.test.ts',
  'tests/unit/scripts/benchmarkProcessTree.test.ts',
  'tests/unit/scripts/buildWithBuilderExitCode.test.ts',
  'tests/unit/scripts/productionAuditCore.test.ts',
];

export default defineConfig({
  resolve: {
    alias: aliases,
  },
  test: {
    globals: true,
    // 20s (was 10s): the suite has legitimately slow integration/DOM tests — the
    // kanban marketing-executor ladder and the Company-Brain modal DOM tests run
    // ~7-8s of real work each, leaving only a ~2-3s margin at 10s. Under full
    // parallel load (119 files incl. process/server-spawning SG-1 tests) that
    // margin vanished and non-broken tests hit the wall. These are timeouts, never
    // assertion failures; 20s restores headroom without masking any real defect.
    testTimeout: 20000,
    // Cap worker parallelism (was unbounded = one per core). The CPU-heavy jsdom
    // DOM tests and the process/server-spawning integration tests otherwise starve
    // each other under a fully-saturated pool: the same tests pass in isolation
    // (8.8s) but time out past 20s when every core runs a heavy file at once.
    // A 60% cap leaves the OS + the heavy tests enough CPU to finish deterministically
    // (verified green: 119 files / 1722 tests). Scales with core count.
    maxWorkers: '60%',
    // Use projects to run different environments (Vitest 4+)
    projects: [
      // Node environment tests (existing tests)
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/unit/**/*.test.ts',
            'tests/unit/**/test_*.ts',
            'tests/integration/**/*.test.ts',
            'tests/regression/**/*.test.ts',
          ],
          exclude: ['tests/unit/**/*.dom.test.ts', 'tests/unit/**/*.dom.test.tsx', ...SUBPROCESS_TEST_FILES],
          setupFiles: ['./tests/vitest.setup.ts'],
        },
      },
      // jsdom environment tests (React component/hook tests)
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/unit/**/*.dom.test.ts', 'tests/unit/**/*.dom.test.tsx'],
          setupFiles: ['./tests/vitest.dom.setup.ts'],
        },
      },
      // Tests that spawn a REAL `process.execPath` child and wait for it to
      // finish. They are not slow because of their own work — `buildWithBuilder`
      // costs 14s alone — but because that child competes with `maxWorkers` peers
      // for the same cores. That is why raising this file's budget from 30s to
      // 120s did not settle it: at 766 files the same case still measured 131s
      // and failed on the larger budget, three times on a byte-identical tree.
      //
      // `groupOrder: 1` runs them after the parallel groups instead, so the child
      // process gets an unloaded machine. This is the cause, not the symptom: a
      // timeout that only appears under peer load says nothing about the target
      // contract this file asserts, and a gate that goes red for reasons unrelated
      // to any defect stops being readable evidence for a release.
      {
        extends: true,
        test: {
          name: 'subprocess',
          environment: 'node',
          include: SUBPROCESS_TEST_FILES,
          setupFiles: ['./tests/vitest.setup.ts'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
      outputFile: './bench-results.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Cover ALL source code by default — new files are automatically included.
      // Only exclude files that genuinely cannot be unit-tested (entry points,
      // type-only files, static assets, etc.).
      include: ['packages/desktop/src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}'],
      exclude: [
        // Type declaration files (no runtime code)
        'packages/**/src/**/*.d.ts',

        // Electron entry points (require Electron runtime)
        'packages/desktop/src/index.ts',
        'packages/desktop/src/preload.ts',

        // Shims / polyfills
        'packages/desktop/src/common/utils/shims/**',

        // Pure type / constant files
        'packages/desktop/src/common/types/**',

        // Static assets and i18n JSON (no logic)
        'packages/desktop/src/renderer/**/*.json',
        'packages/desktop/src/renderer/**/*.svg',
        'packages/desktop/src/renderer/**/*.css',

        // i18n config (JSON-only)
        'packages/desktop/src/common/config/i18n-config.json',
      ],
      // Thresholds apply to the included file set.
      // Keeping them informational until coverage ramps up across all files.
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
