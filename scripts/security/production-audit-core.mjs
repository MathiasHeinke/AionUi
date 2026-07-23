const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXCEPTION_DAYS = 31;
const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseDate(value, field, errors) {
  const text = asNonEmptyString(value);
  if (!text) {
    errors.push(`${field} must be a non-empty ISO date`);
    return undefined;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${field} is not a valid ISO date: ${text}`);
    return undefined;
  }
  return date;
}

function requireString(value, field, errors) {
  const text = asNonEmptyString(value);
  if (!text) errors.push(`${field} must be a non-empty string`);
  return text;
}

function requireStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must contain at least one string`);
    return [];
  }
  const strings = value.map((item) => asNonEmptyString(item)).filter(Boolean);
  if (strings.length !== value.length) errors.push(`${field} must contain only non-empty strings`);
  return strings;
}

export function flattenBunAuditReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Bun audit output must be a JSON object keyed by package name');
  }

  const advisories = [];
  for (const [packageName, entries] of Object.entries(report)) {
    if (!asNonEmptyString(packageName) || !Array.isArray(entries)) {
      throw new Error(`Invalid Bun audit entry for package ${String(packageName)}`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid advisory payload for ${packageName}`);
      }
      if (!Number.isInteger(entry.id) || entry.id <= 0) {
        throw new Error(`Invalid advisory id for ${packageName}`);
      }
      if (!SEVERITIES.has(entry.severity)) {
        throw new Error(`Invalid severity for ${packageName} advisory ${entry.id}`);
      }
      advisories.push({
        advisoryId: entry.id,
        package: packageName,
        severity: entry.severity,
        title: asNonEmptyString(entry.title) || '',
        url: asNonEmptyString(entry.url) || '',
        vulnerableVersions: asNonEmptyString(entry.vulnerable_versions) || '',
      });
    }
  }
  return advisories;
}

function validateException(exception, index, now, runtimeImportHits) {
  const field = `exceptions[${index}]`;
  const errors = [];
  const advisoryId = exception?.advisoryId;
  if (!Number.isInteger(advisoryId) || advisoryId <= 0) {
    errors.push(`${field}.advisoryId must be a positive integer`);
  }
  const packageName = requireString(exception?.package, `${field}.package`, errors);
  const severity = requireString(exception?.severity, `${field}.severity`, errors);
  if (severity && !SEVERITIES.has(severity)) errors.push(`${field}.severity is invalid`);
  requireString(exception?.url, `${field}.url`, errors);
  requireString(exception?.vulnerableVersions, `${field}.vulnerableVersions`, errors);
  requireString(exception?.owner, `${field}.owner`, errors);
  requireString(exception?.reachability?.classification, `${field}.reachability.classification`, errors);
  requireString(exception?.reachability?.rationale, `${field}.reachability.rationale`, errors);
  requireStringArray(exception?.reachability?.evidence, `${field}.reachability.evidence`, errors);
  requireStringArray(exception?.mitigation?.controls, `${field}.mitigation.controls`, errors);
  requireStringArray(exception?.mitigation?.verification, `${field}.mitigation.verification`, errors);
  requireString(exception?.remediation?.target, `${field}.remediation.target`, errors);
  requireString(exception?.remediation?.trigger, `${field}.remediation.trigger`, errors);
  requireStringArray(exception?.evidence, `${field}.evidence`, errors);

  const reviewedAt = parseDate(exception?.reviewedAt, `${field}.reviewedAt`, errors);
  const expiresAt = parseDate(exception?.expiresAt, `${field}.expiresAt`, errors);
  if (reviewedAt && expiresAt) {
    const ttlDays = (expiresAt.getTime() - reviewedAt.getTime()) / DAY_MS;
    if (ttlDays <= 0 || ttlDays > MAX_EXCEPTION_DAYS) {
      errors.push(`${field} exception lifetime must be between 1 and ${MAX_EXCEPTION_DAYS} days`);
    }
    if (expiresAt.getTime() < now.getTime()) errors.push(`${field} expired at ${exception.expiresAt}`);
    if (reviewedAt.getTime() > now.getTime()) errors.push(`${field}.reviewedAt is in the future`);
  }

  if (severity === 'critical') errors.push(`${field} cannot accept a critical advisory`);
  if (severity === 'high' && exception?.reachability?.classification !== 'not-reachable') {
    errors.push(`${field} high-severity exceptions require reachability.classification=not-reachable`);
  }

  const absentImports = exception?.reachability?.requiredAbsentRuntimeImports;
  if (absentImports !== undefined) {
    const requiredAbsent = requireStringArray(
      absentImports,
      `${field}.reachability.requiredAbsentRuntimeImports`,
      errors
    );
    for (const specifier of requiredAbsent) {
      const hits = runtimeImportHits?.[specifier];
      if (!Array.isArray(hits)) {
        errors.push(`${field} reachability proof was not executed for ${specifier}`);
      } else if (hits.length > 0) {
        errors.push(`${field} reachability proof failed for ${specifier}: ${hits.join(', ')}`);
      }
    }
  }

  return { advisoryId, packageName, severity, errors };
}

export function evaluateProductionAudit({ auditReport, ledger, now = new Date(), runtimeImportHits = {} }) {
  const errors = [];
  let advisories = [];
  try {
    advisories = flattenBunAuditReport(auditReport);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    errors.push('Exception ledger must be a JSON object');
  }
  if (ledger?.schemaVersion !== 1) errors.push('Exception ledger schemaVersion must equal 1');
  if (!Array.isArray(ledger?.exceptions)) errors.push('Exception ledger exceptions must be an array');

  const validated = (Array.isArray(ledger?.exceptions) ? ledger.exceptions : []).map((exception, index) => {
    const result = validateException(exception, index, now, runtimeImportHits);
    errors.push(...result.errors);
    return { exception, ...result };
  });

  const byId = new Map();
  for (const item of validated) {
    if (byId.has(item.advisoryId)) errors.push(`Duplicate exception for advisory ${item.advisoryId}`);
    byId.set(item.advisoryId, item.exception);
  }

  const accepted = [];
  for (const advisory of advisories) {
    const exception = byId.get(advisory.advisoryId);
    if (!exception) {
      errors.push(`Unreviewed ${advisory.severity} advisory ${advisory.advisoryId} in ${advisory.package}`);
      continue;
    }
    const metadataPairs = [
      ['package', advisory.package],
      ['severity', advisory.severity],
      ['url', advisory.url],
      ['vulnerableVersions', advisory.vulnerableVersions],
    ];
    const mismatches = metadataPairs.filter(([key, value]) => exception[key] !== value);
    if (mismatches.length > 0) {
      errors.push(
        `Exception metadata drift for advisory ${advisory.advisoryId}: ${mismatches.map(([key]) => key).join(', ')}`
      );
      continue;
    }
    accepted.push({ advisoryId: advisory.advisoryId, package: advisory.package, severity: advisory.severity });
  }

  const activeIds = new Set(advisories.map((advisory) => advisory.advisoryId));
  for (const item of validated) {
    if (!activeIds.has(item.advisoryId)) {
      errors.push(`Stale exception ${item.advisoryId} is not present in the current production audit`);
    }
  }

  return {
    schema: 'command-eve-production-audit-gate/v1',
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    auditedAt: now.toISOString(),
    advisoryCount: advisories.length,
    acceptedExceptionCount: accepted.length,
    accepted,
    errors,
  };
}
