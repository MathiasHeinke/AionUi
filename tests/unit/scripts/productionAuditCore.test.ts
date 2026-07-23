import { describe, expect, it } from 'vitest';

import { evaluateProductionAudit, flattenBunAuditReport } from '../../../scripts/security/production-audit-core.mjs';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const ADVISORY = {
  id: 1124006,
  url: 'https://github.com/advisories/GHSA-frvp-7c67-39w9',
  title: 'Path traversal in serve-static',
  severity: 'moderate',
  vulnerable_versions: '<2.0.5',
};

function buildLedger(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    exceptions: [
      {
        advisoryId: 1124006,
        package: '@hono/node-server',
        severity: 'moderate',
        url: ADVISORY.url,
        vulnerableVersions: '<2.0.5',
        owner: 'Command EVE Security',
        reachability: {
          classification: 'not-reachable',
          rationale: 'The vulnerable subpath is not imported by product runtime code.',
          evidence: ['packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts'],
          requiredAbsentRuntimeImports: ['@hono/node-server'],
        },
        mitigation: {
          controls: ['Remote MCP transports remain disabled.'],
          verification: ['bun run security:audit:production'],
        },
        remediation: {
          target: '@modelcontextprotocol/sdk with @hono/node-server >=2.0.5',
          trigger: 'Upgrade when the SDK publishes a compatible production line.',
        },
        reviewedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-08-22T00:00:00.000Z',
        evidence: [ADVISORY.url],
        ...overrides,
      },
    ],
  };
}

describe('production dependency audit gate', () => {
  it('accepts an exactly matched, unexpired and unreachable advisory exception', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [ADVISORY] },
      ledger: buildLedger(),
      now: NOW,
      runtimeImportHits: { '@hono/node-server': [] },
    });

    expect(receipt.status).toBe('PASS');
    expect(receipt.acceptedExceptionCount).toBe(1);
  });

  it('fails closed for an advisory missing from the exception ledger', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { sharp: [{ ...ADVISORY, id: 99, severity: 'high' }] },
      ledger: { schemaVersion: 1, exceptions: [] },
      now: NOW,
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors).toContain('Unreviewed high advisory 99 in sharp');
  });

  it('fails closed when exception metadata drifts from the registry advisory', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [ADVISORY] },
      ledger: buildLedger({ vulnerableVersions: '<2.0.4' }),
      now: NOW,
      runtimeImportHits: { '@hono/node-server': [] },
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors).toContain('Exception metadata drift for advisory 1124006: vulnerableVersions');
  });

  it('fails closed after the exception expiry', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [ADVISORY] },
      ledger: buildLedger(),
      now: new Date('2026-08-23T00:00:00.000Z'),
      runtimeImportHits: { '@hono/node-server': [] },
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors.some((error) => error.includes('expired at'))).toBe(true);
  });

  it('fails closed when the supposedly unreachable module appears in runtime source', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [ADVISORY] },
      ledger: buildLedger(),
      now: NOW,
      runtimeImportHits: { '@hono/node-server': ['packages/desktop/src/process/server.ts'] },
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors.some((error) => error.includes('reachability proof failed'))).toBe(true);
  });

  it('fails closed when the runtime reachability proof was not executed', () => {
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [ADVISORY] },
      ledger: buildLedger(),
      now: NOW,
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors.some((error) => error.includes('reachability proof was not executed'))).toBe(true);
  });

  it('rejects critical exceptions regardless of ledger metadata', () => {
    const critical = { ...ADVISORY, severity: 'critical' };
    const receipt = evaluateProductionAudit({
      auditReport: { '@hono/node-server': [critical] },
      ledger: buildLedger({ severity: 'critical' }),
      now: NOW,
      runtimeImportHits: { '@hono/node-server': [] },
    });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors).toContain('exceptions[0] cannot accept a critical advisory');
  });

  it('rejects stale exceptions after an advisory is fixed', () => {
    const receipt = evaluateProductionAudit({ auditReport: {}, ledger: buildLedger(), now: NOW });

    expect(receipt.status).toBe('FAIL');
    expect(receipt.errors).toContain('Stale exception 1124006 is not present in the current production audit');
  });

  it('rejects malformed Bun audit payloads instead of treating them as zero advisories', () => {
    expect(() => flattenBunAuditReport([])).toThrow('must be a JSON object');
  });
});
