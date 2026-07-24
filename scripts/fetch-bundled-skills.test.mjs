import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  AUTHOR_PRODUCTION_EXPECTED_AGGREGATE_SHA256,
  AUTHOR_PRODUCTION_EXPECTED_FILE_COUNT,
  EVE_STRATEGY_SKILLS,
  EVE_STRATEGY_SKILL_IDS,
  findForbiddenUserFacingJsonContent,
  findSkillHygieneFailures,
  decideSkillSource,
  decideVerify,
  SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION,
  SKILL_IDS_REQUIRING_LINKED_FILES,
  scanForbiddenLocaleContent,
  resolveSkillStageSource,
  stageBundledSkills,
  verifyAuthorProductionSkillManifest,
} from './fetch-bundled-skills.mjs';

// --- allowlist shape -------------------------------------------------------

test('the allowlist is exactly 37 and includes curated production skills', () => {
  assert.equal(EVE_STRATEGY_SKILL_IDS.length, 37);
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('eve-doctrine'));
  assert.ok(!EVE_STRATEGY_SKILL_IDS.includes('marketing-outbound'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('blog-writer'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('founder-voice'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('client-report'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('content-machine'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('crm-department'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('voice-first-run'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('challenge-engine'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('brainstorm-divergent'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('local-vision-qa'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('visual-direction-gate'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('presentation-studio'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('ai-coding-delegation'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('lead-magnet-pdf'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('skill-authoring'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('legal-enforcement-dach'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('plaud-recording-ingest'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('autor-studio'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('essay-writer'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('book-publishing'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('premium-website-builder'));
  // gitnexus and other dev/IDE skills must NEVER be in the allowlist.
  assert.ok(!EVE_STRATEGY_SKILL_IDS.includes('gitnexus'));
});

test('the public runtime allowlist contains only independently curated root skills', () => {
  const bundles = EVE_STRATEGY_SKILLS.filter((s) => s.bundle).map((s) => s.id);
  assert.deepEqual(bundles, []);
});

test('every bundled root skill has AionCore-compatible YAML frontmatter', () => {
  for (const skill of EVE_STRATEGY_SKILLS) {
    const skillPath = path.resolve('resources/bundled-skills', skill.id, 'SKILL.md');
    const text = fs.readFileSync(skillPath, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    assert.ok(match, `${skill.id}: missing leading YAML frontmatter`);

    let frontmatter;
    assert.doesNotThrow(() => {
      frontmatter = parseYaml(match[1]);
    }, `${skill.id}: invalid YAML frontmatter`);
    assert.equal(frontmatter?.name, skill.id, `${skill.id}: frontmatter name must equal the root skill id`);
    assert.equal(typeof frontmatter?.description, 'string', `${skill.id}: description must be a string`);
    assert.ok(frontmatter.description.trim(), `${skill.id}: description must not be empty`);
  }
});

test('release snapshot mode ignores every external source root while refresh mode remains explicit', () => {
  assert.deepEqual(
    resolveSkillStageSource({
      mode: 'snapshot',
      explicitSourceRoot: '/untrusted/source',
      defaultSourceRoot: '/default',
    }),
    { ok: true, mode: 'snapshot', srcRoot: null }
  );
  assert.deepEqual(
    resolveSkillStageSource({ mode: 'refresh', explicitSourceRoot: '/approved/source', defaultSourceRoot: '/default' }),
    { ok: true, mode: 'refresh', srcRoot: '/approved/source' }
  );
  assert.deepEqual(resolveSkillStageSource({ mode: 'unknown', defaultSourceRoot: '/default' }), {
    ok: false,
    mode: 'unknown',
    srcRoot: null,
  });
});

test('the committed author-production snapshot matches the pinned 32-file source manifest', () => {
  const result = verifyAuthorProductionSkillManifest(path.resolve('resources/bundled-skills'));
  assert.equal(result.ok, true);
  assert.equal(result.file_count, AUTHOR_PRODUCTION_EXPECTED_FILE_COUNT);
  assert.equal(result.aggregate_sha256, AUTHOR_PRODUCTION_EXPECTED_AGGREGATE_SHA256);
});

test('the author-production manifest fails closed when one expected payload byte drifts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'author-manifest-test-'));
  try {
    const snapshotRoot = path.join(root, 'bundled-skills');
    for (const id of ['autor-studio', 'essay-writer', 'book-publishing']) {
      fs.cpSync(path.resolve('resources/bundled-skills', id), path.join(snapshotRoot, id), { recursive: true });
    }
    fs.appendFileSync(path.join(snapshotRoot, 'autor-studio', 'SKILL.md'), '\nmanifest drift\n');
    const result = verifyAuthorProductionSkillManifest(snapshotRoot);
    assert.equal(result.ok, false);
    assert.ok(result.reason_codes.includes('author_production_manifest_hash_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- decideSkillSource (refresh / keep / missing) --------------------------

test('decideSkillSource refreshes from source when source exists', () => {
  assert.equal(decideSkillSource({ sourceExists: true, snapshotExists: false }).action, 'refresh');
  assert.equal(decideSkillSource({ sourceExists: true, snapshotExists: true }).action, 'refresh');
});

test('decideSkillSource keeps the snapshot when source is absent but snapshot exists', () => {
  assert.equal(decideSkillSource({ sourceExists: false, snapshotExists: true }).action, 'keep');
});

test('decideSkillSource FAILS CLOSED (missing) when neither source nor snapshot exists', () => {
  assert.equal(decideSkillSource({ sourceExists: false, snapshotExists: false }).action, 'missing');
});

// --- decideVerify (single vs bundle) ---------------------------------------

test('decideVerify single: OK only with its own SKILL.md', () => {
  assert.equal(decideVerify({ bundle: false, hasOwnSkillMd: true, nestedSkillMdCount: 0 }).ok, true);
  assert.equal(decideVerify({ bundle: false, hasOwnSkillMd: false, nestedSkillMdCount: 5 }).ok, false);
});

test('decideVerify bundle: OK with >=1 nested SKILL.md, FAILS with none', () => {
  assert.equal(decideVerify({ bundle: true, hasOwnSkillMd: false, nestedSkillMdCount: 3 }).ok, true);
  assert.equal(decideVerify({ bundle: true, hasOwnSkillMd: false, nestedSkillMdCount: 0 }).ok, false);
});

// --- stageBundledSkills end-to-end against a fixture -----------------------

function makeFixtureSrc(root, { omit = [] } = {}) {
  const omitSet = new Set(omit);
  const srcRoot = path.join(root, 'src-skills');
  fs.mkdirSync(srcRoot, { recursive: true });
  for (const skill of EVE_STRATEGY_SKILLS) {
    if (omitSet.has(skill.id)) continue;
    const dir = path.join(srcRoot, skill.id);
    fs.mkdirSync(dir, { recursive: true });
    if (skill.bundle) {
      fs.writeFileSync(path.join(dir, 'README.md'), '# bundle\n');
      const sub = path.join(dir, 'icp-definer');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(sub, 'SKILL.md'),
        '---\nname: icp-definer\ndescription: Use when outbound needs an ICP definition.\n---\n# icp-definer\nreal\n'
      );
    } else {
      const disableLine = SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION.includes(skill.id)
        ? 'disable_model_invocation: true\n'
        : '';
      const linkedFiles = SKILL_IDS_REQUIRING_LINKED_FILES.includes(skill.id)
        ? 'linked_files:\n  - references/detail.md\n'
        : '';
      if (SKILL_IDS_REQUIRING_LINKED_FILES.includes(skill.id)) {
        fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'references', 'detail.md'), `# ${skill.id} detail\n`);
      }
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skill.id}\ndescription: Use when ${skill.id} is explicitly needed.\n${disableLine}${linkedFiles}---\n# ${skill.id}\nreal\n`
      );
      if (skill.id === 'book-publishing') {
        fs.mkdirSync(path.join(dir, 'references', 'templates'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'references', '01_concept_and_positioning.md'), '# Positioning\n');
        fs.writeFileSync(path.join(dir, 'references', 'templates', 'build_ebook.sh'), '#!/bin/sh\n');
      }
    }
  }
  return srcRoot;
}

test('stageBundledSkills refreshes from source and verifies all 37 including nested production assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root);
    const snapshotRoot = path.join(root, 'snapshot');
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.deepEqual(failures, []);
    // single skill landed
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'eve-doctrine', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'book-publishing', 'references', '01_concept_and_positioning.md')));
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'book-publishing', 'references', 'templates', 'build_ebook.sh')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stageBundledSkills keeps the live skill directory present while refreshing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root);
    const snapshotRoot = path.join(root, 'snapshot');
    const skill = EVE_STRATEGY_SKILLS.find(({ id }) => id === 'eve-doctrine');
    assert.ok(skill);
    const destDir = path.join(snapshotRoot, skill.id);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'stale.md'), 'stale\n');
    const inodeBefore = fs.statSync(destDir).ino;

    const failures = stageBundledSkills({ srcRoot, snapshotRoot, skills: [skill] });

    assert.deepEqual(failures, []);
    assert.equal(fs.statSync(destDir).ino, inodeBefore);
    assert.ok(fs.existsSync(path.join(destDir, 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(destDir, 'stale.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findForbiddenUserFacingJsonContent scans visible values, not technical keys', () => {
  const safe = JSON.stringify({
    bypassPermissions: 'Auto',
    nested: { yolo: 'Guarded auto' },
  });
  assert.deepEqual(findForbiddenUserFacingJsonContent(safe), []);

  const dangerous = JSON.stringify({
    bypassPermissions: 'YOLO',
    setting: 'Bypass all Claude Code permission checks (equivalent to --dangerously-skip-permissions).',
  });
  const findings = findForbiddenUserFacingJsonContent(dangerous);
  assert.deepEqual(
    findings.map((entry) => entry.path),
    ['bypassPermissions', 'setting']
  );
  assert.ok(findings[0].ids.includes('yolo-copy'));
  assert.ok(findings[1].ids.includes('dangerously-skip-permissions-copy'));
  assert.ok(findings[1].ids.includes('bypass-permissions-copy'));
});

test('scanForbiddenLocaleContent fails closed on dangerous locale values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-locale-test-'));
  try {
    fs.mkdirSync(path.join(root, 'en-US'), { recursive: true });
    fs.writeFileSync(path.join(root, 'en-US', 'agentMode.json'), JSON.stringify({ bypassPermissions: 'Auto' }));
    assert.deepEqual(scanForbiddenLocaleContent(root), []);

    fs.writeFileSync(
      path.join(root, 'en-US', 'settings.json'),
      JSON.stringify({ claudeYoloModeDesc: 'Skip all permissions with --dangerously-skip-permissions.' })
    );
    const failures = scanForbiddenLocaleContent(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /settings\.json:claudeYoloModeDesc/);
    assert.match(failures[0], /dangerously-skip-permissions-copy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findSkillHygieneFailures requires disable_model_invocation for long-tail skills', () => {
  const missing = [
    '---',
    'name: lead-magnet-pdf',
    'description: Use when a lead magnet PDF is explicitly needed.',
    '---',
    '# Lead Magnet PDF',
  ].join('\n');
  assert.ok(
    findSkillHygieneFailures({ skillId: 'lead-magnet-pdf', text: missing }).includes('disable_model_invocation_missing')
  );

  const present = missing.replace(
    'description: Use when a lead magnet PDF is explicitly needed.',
    'description: Use when a lead magnet PDF is explicitly needed.\ndisable_model_invocation: true'
  );
  assert.deepEqual(findSkillHygieneFailures({ skillId: 'lead-magnet-pdf', text: present }), []);
});

test('findSkillHygieneFailures accepts folded YAML descriptions and linked files', () => {
  const folded = [
    '---',
    'name: content-machine',
    'description: >-',
    '  Build a content system safely. Use when the operator needs a repeatable workflow.',
    'linked_files:',
    '  - references/contract.md',
    '---',
    '# Content Machine',
  ].join('\n');

  assert.deepEqual(findSkillHygieneFailures({ skillId: 'content-machine', text: folded }), []);
});

test('findSkillHygieneFailures rejects duplicated EVE doctrine surfaces and missing linked files', () => {
  const duplicated = [
    '---',
    'name: plan-system',
    'description: Use when planning is needed. For Command EVE this is copied doctrine.',
    '---',
    '# Plan System',
    '',
    '## For Command EVE',
  ].join('\n');
  const failures = findSkillHygieneFailures({ skillId: 'plan-system', text: duplicated });
  assert.ok(failures.includes('description_embeds_eve_doctrine'));
  assert.ok(failures.includes('duplicate_eve_doctrine_section'));

  const missingLinkedFiles = [
    '---',
    'name: content-machine',
    'description: Use when a content operating system is needed.',
    '---',
    '# Content Machine',
  ].join('\n');
  assert.ok(
    findSkillHygieneFailures({ skillId: 'content-machine', text: missingLinkedFiles }).includes('linked_files_missing')
  );
});

test('stageBundledSkills fails when a linked_files entry does not resolve inside the skill tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root);
    fs.rmSync(path.join(srcRoot, 'content-machine', 'references'), { recursive: true, force: true });
    const snapshotRoot = path.join(root, 'snapshot');
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.ok(failures.includes('bundled_skill_linked_file_missing:content-machine:references/detail.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stageBundledSkills keeps the committed snapshot when source is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const snapshotRoot = path.join(root, 'snapshot');
    // Pre-seed a full snapshot (as if committed), then point at a non-existent source.
    const srcRoot = makeFixtureSrc(root);
    stageBundledSkills({ srcRoot, snapshotRoot }); // populate snapshot
    fs.rmSync(srcRoot, { recursive: true, force: true }); // source now absent
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.deepEqual(failures, []); // trusts the snapshot, still verifies
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stageBundledSkills FAILS CLOSED when a skill is in neither source nor snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root, { omit: ['eve-doctrine'] });
    const snapshotRoot = path.join(root, 'snapshot'); // empty -> no committed fallback either
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.ok(failures.includes('bundled_skill_missing:eve-doctrine'));
    // the others still staged
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'plan-system', 'SKILL.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stageBundledSkills FAILS CLOSED on an invalid explicitly declared bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = path.join(root, 'src-skills');
    fs.mkdirSync(path.join(srcRoot, 'synthetic-bundle'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'synthetic-bundle', 'README.md'), 'only readme\n');
    const snapshotRoot = path.join(root, 'snapshot');
    const failures = stageBundledSkills({
      srcRoot,
      snapshotRoot,
      skills: [{ id: 'synthetic-bundle', bundle: true }],
    });
    assert.ok(failures.includes('bundled_skill_invalid:synthetic-bundle'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
