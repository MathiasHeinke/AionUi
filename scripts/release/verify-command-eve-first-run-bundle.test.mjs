import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_EVE_FIRST_RUN_BUNDLE_EXIT_CODES,
  evaluateCommandEveFirstRunBundle,
  loadProductOnboardingSkill,
  parseArgs,
  verifyCommandEveFirstRunBundle,
} from './verify-command-eve-first-run-bundle.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoots = [];
let cachedProductSkill = '';

function productSkill() {
  if (!cachedProductSkill) cachedProductSkill = loadProductOnboardingSkill(PROJECT_ROOT);
  return cachedProductSkill;
}

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-first-run-bundle-'));
  tempRoots.push(root);
  const appPath = path.join(root, 'Command EVE.app');
  const userDataPath = path.join(root, 'user-data');
  const runtimeRoot = path.join(userDataPath, 'command-eve-runtime');
  const profilePath = path.join(runtimeRoot, 'first-run-profile.json');
  const hermesHome = path.join(runtimeRoot, 'hermes', 'home');
  const registration = {
    version: 'command-eve-registration/v0',
    tenant_id: 'tenant-fixture',
    name: options.name ?? 'Ada Lovelace',
    name_source: options.nameSource ?? 'explicit',
    company: options.company ?? 'Analytical Engines',
    email: options.email ?? 'ada@example.test',
    gdpr_consent: true,
    gdpr_consent_at: '2026-07-23T10:00:00.000Z',
    registered_at: options.registeredAt ?? '2026-07-23T10:00:00.000Z',
  };
  const confirmedName = registration.name_source !== 'email_fallback';
  const profile = {
    version: 'command-eve-first-run-profile/v0',
    source: 'registration',
    confidence: 'verified',
    needs_confirmation: false,
    updated_at: options.profileUpdatedAt ?? '2026-07-23T10:00:01.000Z',
    ...(confirmedName ? { founder_name: registration.name } : {}),
    company_name: registration.company,
    ...(options.profileOverrides || {}),
  };
  const receipt = {
    version: 'command-eve-runtime-bootstrap/v0',
    app_release: options.receiptVersion ?? '1.819.0',
    identity: { ...profile, profile_path: profilePath },
    ...(options.receiptOverrides || {}),
  };
  const operatorName = confirmedName ? registration.name : '(unbestätigt — beiläufig nachfragen)';
  const operatorContext =
    options.operatorContext ??
    [
      '# Operator',
      `Name: ${operatorName}`,
      `Firma/Brand: ${registration.company}`,
      '(Bei der Registrierung angegeben.)',
      '§',
      '# Was ich über den Operator lernen + hier festhalten soll',
      '',
    ].join('\n');
  const generatedSkill = options.generatedSkill ?? productSkill();

  write(path.join(appPath, 'Contents', 'Info.plist'), '<plist />');
  write(path.join(appPath, 'Contents', 'Resources', 'app.asar'), 'packaged-app');
  write(path.join(runtimeRoot, 'entitlement', 'registration.json'), registration);
  write(profilePath, profile);
  write(path.join(runtimeRoot, 'runtime-bootstrap-receipt.json'), receipt);
  write(path.join(hermesHome, 'memories', 'USER.md'), operatorContext);
  write(path.join(hermesHome, 'skills-command-eve', 'eve-onboarding-awareness', 'SKILL.md'), generatedSkill);

  return { appPath, userDataPath, registration, profile, receipt, operatorContext, generatedSkill, profilePath };
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('loads the current product-native onboarding generator without a sidecar checkout', () => {
  const generated = productSkill();
  assert.match(generated, /^---\nname: eve-onboarding-awareness\n/);
  assert.match(generated, /command-eve\.onboarding-status/);
  assert.doesNotMatch(generated, /\/Users\/|\.agent-sandboxes|company-os-private-ops/);
});

test('PASS binds the packaged version to registration, verified profile, Operator context and exact skill bytes', () => {
  const fixture = makeFixture();
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );

  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.exit_code, COMMAND_EVE_FIRST_RUN_BUNDLE_EXIT_CODES.PASS);
  assert.equal(verdict.identity_source, 'registration');
  assert.equal(verdict.identity_confidence, 'verified');
  assert.equal(verdict.confirmed_name_present, true);
  assert.deepEqual(
    verdict.checks.map((check) => check.id),
    [
      'packaged_app_present',
      'registration_submitted',
      'registration_to_verified_profile',
      'packaged_receipt_identity',
      'profile_to_operator_context',
      'onboarding_skill_byte_identity',
      'no_private_sidecar_paths',
    ]
  );
  const serialized = JSON.stringify(verdict);
  assert.doesNotMatch(serialized, /Ada Lovelace|Analytical Engines|ada@example\.test/);
});

test('PASS keeps an email-derived local part out of both profile and Operator context', () => {
  const fixture = makeFixture({
    name: 'Jane Doe',
    nameSource: 'email_fallback',
    company: 'Example',
    email: 'jane.doe@example.test',
  });
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );

  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.confirmed_name_present, false);
  assert.doesNotMatch(fixture.operatorContext, /Jane Doe/);
});

test('fails closed when an email fallback is promoted into the verified profile', () => {
  const input = {
    app_is_directory: true,
    info_plist_present: true,
    app_asar_present: true,
    app_version: '1.819.0',
    registration: {
      version: 'command-eve-registration/v0',
      tenant_id: 'tenant-fixture',
      name: 'Jane Doe',
      name_source: 'email_fallback',
      company: 'Example',
      email: 'jane.doe@example.test',
      gdpr_consent: true,
      registered_at: '2026-07-23T10:00:00.000Z',
    },
    profile: {
      version: 'command-eve-first-run-profile/v0',
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      updated_at: '2026-07-23T10:00:01.000Z',
      founder_name: 'Jane Doe',
      company_name: 'Example',
    },
  };
  const verdict = evaluateCommandEveFirstRunBundle(input);
  assert.equal(verdict.status, 'BLOCKED_PROFILE');
  assert.match(verdict.detail, /email-local-part fallback/);
});

test('fails closed on reverse-prefill ordering', () => {
  const fixture = makeFixture({ profileUpdatedAt: '2026-07-23T09:59:59.000Z' });
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );
  assert.equal(verdict.status, 'BLOCKED_PROFILE');
  assert.match(verdict.detail, /derived after registration/);
});

test('fails closed when the generated onboarding skill is stale', () => {
  const fixture = makeFixture({ generatedSkill: `${productSkill()}stale\n` });
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );
  assert.equal(verdict.status, 'BLOCKED_SKILL_STALE');
});

test('fails closed when a matching generated skill carries a private checkout path', () => {
  const contaminated = `${productSkill()}\nSource: /Users/example/Developer/Company.OS/private.md\n`;
  const fixture = makeFixture({ generatedSkill: contaminated });
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: contaminated }
  );
  assert.equal(verdict.status, 'BLOCKED_PRIVATE_PATH');
});

test('fails closed when the runtime receipt is not bound to the packaged app version', () => {
  const fixture = makeFixture({ receiptVersion: '1.818.0' });
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );
  assert.equal(verdict.status, 'BLOCKED_RECEIPT');
});

test('fails closed when a required generated artifact is missing', () => {
  const fixture = makeFixture();
  fs.rmSync(path.join(fixture.userDataPath, 'command-eve-runtime', 'first-run-profile.json'));
  const verdict = verifyCommandEveFirstRunBundle(
    { appPath: fixture.appPath, userDataPath: fixture.userDataPath, projectRoot: PROJECT_ROOT },
    { appVersion: '1.819.0', expectedOnboardingSkill: productSkill() }
  );
  assert.equal(verdict.status, 'BLOCKED_INPUT');
});

test('parseArgs requires explicit packaged app and fresh user-data paths without hidden sidecar defaults', () => {
  assert.throws(() => parseArgs(['/tmp/positional']), /Unknown argument/);
  const args = parseArgs(['--app', '/tmp/Command EVE.app', '--user-data', '/tmp/eve-clean', '--json']);
  assert.equal(args.appPath, '/tmp/Command EVE.app');
  assert.equal(args.userDataPath, '/tmp/eve-clean');
  assert.equal(args.json, true);
});
