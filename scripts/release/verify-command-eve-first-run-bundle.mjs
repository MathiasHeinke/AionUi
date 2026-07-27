#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMMAND_EVE_FIRST_RUN_BUNDLE_VERIFIER_VERSION = 'command-eve-first-run-bundle-verifier/v0';

export const COMMAND_EVE_FIRST_RUN_BUNDLE_EXIT_CODES = {
  PASS: 0,
  BLOCKED_INPUT: 2,
  BLOCKED_PACKAGED_APP: 3,
  BLOCKED_REGISTRATION: 4,
  BLOCKED_PROFILE: 5,
  BLOCKED_RECEIPT: 6,
  BLOCKED_OPERATOR_CONTEXT: 7,
  BLOCKED_SKILL_STALE: 8,
  BLOCKED_PRIVATE_PATH: 9,
  BLOCKED_GENERATOR: 10,
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const ONBOARDING_SKILL_ID = 'eve-onboarding-awareness';
const PRIVATE_PATH_PATTERN =
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|\.agent-sandboxes(?:\/|\\)|company-os-private-ops(?:\/|\\)|Company\.OS(?:\/|\\))/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoTime(value) {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function titleCase(value) {
  return text(value)
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function emailFallbackName(email) {
  return titleCase(text(email).split('@')[0] || '');
}

function registrationNameIsConfirmed(registration) {
  const name = text(registration?.name);
  if (!name) return false;
  if (registration?.name_source === 'email_fallback') return false;
  if (registration?.name_source === 'explicit') return true;

  const fallback = emailFallbackName(registration?.email);
  if (fallback && name.localeCompare(fallback, undefined, { sensitivity: 'accent' }) === 0) return false;
  return registration?.name_source === 'account_metadata' || !fallback;
}

function result(status, detail, checks = [], extra = {}) {
  return {
    version: COMMAND_EVE_FIRST_RUN_BUNDLE_VERIFIER_VERSION,
    status,
    ok: status === 'PASS',
    exit_code: COMMAND_EVE_FIRST_RUN_BUNDLE_EXIT_CODES[status] ?? 1,
    detail,
    checks,
    ...extra,
  };
}

function failed(status, detail, checks) {
  return result(status, detail, checks);
}

/**
 * Pure fail-closed evaluator for a fresh packaged first run. It intentionally
 * reports hashes and booleans only: registration PII is validated in memory and
 * never copied into the release receipt.
 */
export function evaluateCommandEveFirstRunBundle(input = {}) {
  const checks = [];
  const pass = (id) => checks.push({ id, status: 'PASS' });

  if (!input.app_is_directory || !input.info_plist_present || !input.app_asar_present || !text(input.app_version)) {
    return failed(
      'BLOCKED_PACKAGED_APP',
      'The electron-builder app bundle, Info.plist, app.asar and packaged version are all required',
      checks
    );
  }
  pass('packaged_app_present');

  const registration = input.registration;
  if (
    !registration ||
    registration.version !== 'command-eve-registration/v0' ||
    registration.gdpr_consent !== true ||
    !text(registration.name) ||
    !text(registration.company) ||
    !text(registration.email) ||
    !text(registration.tenant_id)
  ) {
    return failed(
      'BLOCKED_REGISTRATION',
      'registration.json is missing or does not satisfy the local registration contract',
      checks
    );
  }
  const registeredAt = isoTime(registration.registered_at);
  if (registeredAt === null) {
    return failed('BLOCKED_REGISTRATION', 'registration.json has no valid registered_at timestamp', checks);
  }
  pass('registration_submitted');

  const profile = input.profile;
  const confirmedName = registrationNameIsConfirmed(registration);
  if (
    !profile ||
    profile.version !== 'command-eve-first-run-profile/v0' ||
    profile.source !== 'registration' ||
    profile.confidence !== 'verified' ||
    profile.needs_confirmation !== false ||
    text(profile.company_name) !== text(registration.company)
  ) {
    return failed(
      'BLOCKED_PROFILE',
      'first-run-profile.json is not a verified registration-sourced profile with the submitted company',
      checks
    );
  }
  const profileAt = isoTime(profile.updated_at);
  if (profileAt === null || profileAt < registeredAt) {
    return failed(
      'BLOCKED_PROFILE',
      'first-run-profile.json must be derived after registration; reverse-prefill ordering is rejected',
      checks
    );
  }
  if (confirmedName && text(profile.founder_name) !== text(registration.name)) {
    return failed(
      'BLOCKED_PROFILE',
      'the verified first-run profile does not carry the explicitly confirmed name',
      checks
    );
  }
  if (!confirmedName && text(profile.founder_name)) {
    return failed(
      'BLOCKED_PROFILE',
      'an email-local-part fallback was promoted into first-run-profile.json as a personal name',
      checks
    );
  }
  pass('registration_to_verified_profile');

  const receiptIdentity = input.receipt?.identity;
  if (
    !input.receipt ||
    text(input.receipt.app_release) !== text(input.app_version) ||
    !receiptIdentity ||
    receiptIdentity.source !== profile.source ||
    receiptIdentity.confidence !== profile.confidence ||
    receiptIdentity.needs_confirmation !== profile.needs_confirmation ||
    text(receiptIdentity.company_name) !== text(profile.company_name) ||
    text(receiptIdentity.founder_name) !== text(profile.founder_name) ||
    path.resolve(text(receiptIdentity.profile_path)) !== path.resolve(text(input.expected_profile_path))
  ) {
    return failed(
      'BLOCKED_RECEIPT',
      'runtime-bootstrap-receipt.json is not bound to the packaged version and exact first-run profile',
      checks
    );
  }
  pass('packaged_receipt_identity');

  const expectedName = confirmedName ? text(registration.name) : '(unbestätigt — beiläufig nachfragen)';
  const expectedOperatorEntry = [
    '# Operator',
    `Name: ${expectedName}`,
    `Firma/Brand: ${text(registration.company)}`,
    '(Bei der Registrierung angegeben.)',
  ].join('\n');
  if (!text(input.operator_context) || !input.operator_context.includes(expectedOperatorEntry)) {
    return failed(
      'BLOCKED_OPERATOR_CONTEXT',
      'memories/USER.md does not consume the verified registration profile in its generated Operator entry',
      checks
    );
  }
  if (!confirmedName && input.operator_context.includes(text(registration.name))) {
    return failed(
      'BLOCKED_OPERATOR_CONTEXT',
      'memories/USER.md leaks an email-local-part fallback into the Operator identity',
      checks
    );
  }
  pass('profile_to_operator_context');

  if (!text(input.generated_onboarding_skill) || !text(input.expected_onboarding_skill)) {
    return failed('BLOCKED_GENERATOR', 'generated and product-native onboarding skill bytes are required', checks);
  }
  if (input.generated_onboarding_skill !== input.expected_onboarding_skill) {
    return failed(
      'BLOCKED_SKILL_STALE',
      'generated eve-onboarding-awareness/SKILL.md differs from the current product-native generator',
      checks
    );
  }
  pass('onboarding_skill_byte_identity');

  if (PRIVATE_PATH_PATTERN.test(input.generated_onboarding_skill)) {
    return failed(
      'BLOCKED_PRIVATE_PATH',
      'generated first-run skill contains a private checkout or home-directory path',
      checks
    );
  }
  pass('no_private_sidecar_paths');

  return result(
    'PASS',
    'Packaged first-run registration, profile, Operator context and generated skill are coherent',
    checks,
    {
      app_release: text(input.app_version),
      identity_source: profile.source,
      identity_confidence: profile.confidence,
      confirmed_name_present: confirmedName,
      artifacts: input.artifacts || {},
    }
  );
}

function readJson(filePath, readFile = fs.readFileSync) {
  return JSON.parse(readFile(filePath, 'utf8'));
}

export function readPackagedAppVersion(appPath, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const command = spawn('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist], {
    encoding: 'utf8',
  });
  if (command.error || command.status !== 0 || !text(command.stdout)) {
    throw new Error(`Could not read CFBundleShortVersionString from ${path.basename(appPath)}`);
  }
  return text(command.stdout);
}

export function loadProductOnboardingSkill(projectRoot, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const bunBinary = deps.bunBinary || process.env.BUN_BINARY || 'bun';
  const generatorFile = path.join(
    projectRoot,
    'packages',
    'desktop',
    'src',
    'process',
    'commandEve',
    'runtimeBootstrapCore.ts'
  );
  const program = [
    `import { commandEveOnboardingSkillMarkdown } from ${JSON.stringify(pathToFileURL(generatorFile).href)};`,
    'process.stdout.write(commandEveOnboardingSkillMarkdown());',
  ].join(' ');
  const command = spawn(bunBinary, ['-e', program], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (command.error || command.status !== 0 || !text(command.stdout)) {
    const stderr = text(command.stderr);
    throw new Error(`Product first-run generator failed${stderr ? `: ${stderr}` : ''}`);
  }
  return command.stdout;
}

export function verifyCommandEveFirstRunBundle(options = {}, deps = {}) {
  const readFile = deps.readFile || fs.readFileSync;
  const exists = deps.exists || fs.existsSync;
  const stat = deps.stat || fs.statSync;
  const appPath = path.resolve(text(options.appPath));
  const userDataPath = path.resolve(text(options.userDataPath));
  const projectRoot = path.resolve(text(options.projectRoot) || DEFAULT_PROJECT_ROOT);
  const runtimeRoot = path.join(userDataPath, 'command-eve-runtime');
  const hermesHome = path.join(runtimeRoot, 'hermes', 'home');
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const appAsarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const registrationPath = path.join(runtimeRoot, 'entitlement', 'registration.json');
  const profilePath = path.join(runtimeRoot, 'first-run-profile.json');
  const receiptPath = path.join(runtimeRoot, 'runtime-bootstrap-receipt.json');
  const operatorContextPath = path.join(hermesHome, 'memories', 'USER.md');
  const onboardingSkillPath = path.join(hermesHome, 'skills-command-eve', ONBOARDING_SKILL_ID, 'SKILL.md');

  try {
    const requiredFiles = [
      infoPlistPath,
      appAsarPath,
      registrationPath,
      profilePath,
      receiptPath,
      operatorContextPath,
      onboardingSkillPath,
    ];
    const missing = requiredFiles.filter((filePath) => !exists(filePath));
    if (missing.length > 0 || !exists(appPath) || !stat(appPath).isDirectory()) {
      return result(
        'BLOCKED_INPUT',
        // NOT `missing.map(path.basename)`: Array.map passes (element, index),
        // so the index arrives as basename's `suffix` argument and Node throws
        // ERR_INVALID_ARG_TYPE. That crash replaced this gate's real verdict
        // with a bogus BLOCKED_INPUT about a "suffix" argument and hid WHICH
        // artifacts were missing.
        `Missing required packaged first-run artifact(s): ${missing.map((filePath) => path.basename(filePath)).join(', ')}`
      );
    }

    const registrationText = readFile(registrationPath, 'utf8');
    const profileText = readFile(profilePath, 'utf8');
    const receiptText = readFile(receiptPath, 'utf8');
    const operatorContext = readFile(operatorContextPath, 'utf8');
    const generatedOnboardingSkill = readFile(onboardingSkillPath, 'utf8');
    const expectedOnboardingSkill = deps.expectedOnboardingSkill ?? loadProductOnboardingSkill(projectRoot, deps);
    const appVersion = deps.appVersion ?? readPackagedAppVersion(appPath, deps);

    return evaluateCommandEveFirstRunBundle({
      app_is_directory: true,
      info_plist_present: true,
      app_asar_present: true,
      app_version: appVersion,
      registration: JSON.parse(registrationText),
      profile: JSON.parse(profileText),
      receipt: JSON.parse(receiptText),
      expected_profile_path: profilePath,
      operator_context: operatorContext,
      generated_onboarding_skill: generatedOnboardingSkill,
      expected_onboarding_skill: expectedOnboardingSkill,
      artifacts: {
        registration_sha256: sha256(registrationText),
        profile_sha256: sha256(profileText),
        runtime_receipt_sha256: sha256(receiptText),
        operator_context_sha256: sha256(operatorContext),
        onboarding_skill_sha256: sha256(generatedOnboardingSkill),
      },
    });
  } catch (error) {
    return result('BLOCKED_INPUT', error instanceof Error ? error.message : String(error));
  }
}

export function parseArgs(argv) {
  const args = { appPath: '', userDataPath: '', projectRoot: DEFAULT_PROJECT_ROOT, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') args.appPath = argv[++index] || '';
    else if (arg === '--user-data') args.userDataPath = argv[++index] || '';
    else if (arg === '--project-root') args.projectRoot = argv[++index] || '';
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/release/verify-command-eve-first-run-bundle.mjs \\
    --app <electron-builder/Command EVE.app> \\
    --user-data <fresh-packaged-run-userData> \\
    [--project-root <AionUi checkout>] [--json]

Fail-closed C9 release gate. It binds a fresh packaged run to the app version,
proves registration -> verified first-run profile -> Operator context, rejects
email-local-part names, and byte-compares the generated onboarding SKILL.md to
the product-native generator. It never depends on Company.OS sidecar paths.`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const blocked = result('BLOCKED_INPUT', error instanceof Error ? error.message : String(error));
    console.error(`${blocked.status}: ${blocked.detail}`);
    process.exitCode = blocked.exit_code;
    return;
  }

  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.appPath || !args.userDataPath) {
    const blocked = result('BLOCKED_INPUT', '--app and --user-data are required');
    console.error(`${blocked.status}: ${blocked.detail}`);
    process.exitCode = blocked.exit_code;
    return;
  }

  const verdict = verifyCommandEveFirstRunBundle(args);
  console.log(args.json ? JSON.stringify(verdict, null, 2) : `${verdict.status}: ${verdict.detail}`);
  process.exitCode = verdict.exit_code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
