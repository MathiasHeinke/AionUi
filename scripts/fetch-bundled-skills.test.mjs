import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVE_STRATEGY_SKILLS,
  EVE_STRATEGY_SKILL_IDS,
  findForbiddenUserFacingJsonContent,
  findSkillHygieneFailures,
  decideSkillSource,
  decideVerify,
  SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION,
  SKILL_IDS_REQUIRING_LINKED_FILES,
  scanForbiddenLocaleContent,
  stageBundledSkills,
} from './fetch-bundled-skills.mjs';

// --- allowlist shape -------------------------------------------------------

test('the allowlist is exactly 31: strategy + operator skills + local-vision + 4 harvested field skills', () => {
  assert.equal(EVE_STRATEGY_SKILL_IDS.length, 31);
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('eve-doctrine'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('marketing-outbound'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('blog-writer'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('founder-voice'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('client-report'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('content-machine'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('crm-department'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('voice-first-run'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('challenge-engine'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('brainstorm-divergent'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('local-vision-qa'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('ai-coding-delegation'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('lead-magnet-pdf'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('skill-authoring'));
  assert.ok(EVE_STRATEGY_SKILL_IDS.includes('legal-enforcement-dach'));
  // gitnexus and other dev/IDE skills must NEVER be in the allowlist.
  assert.ok(!EVE_STRATEGY_SKILL_IDS.includes('gitnexus'));
});

test('marketing-outbound is the only bundle; the rest are single skills', () => {
  const bundles = EVE_STRATEGY_SKILLS.filter((s) => s.bundle).map((s) => s.id);
  assert.deepEqual(bundles, ['marketing-outbound']);
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
    }
  }
  return srcRoot;
}

test('stageBundledSkills refreshes from source and verifies all 31 (no failures)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root);
    const snapshotRoot = path.join(root, 'snapshot');
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.deepEqual(failures, []);
    // single skill landed
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'eve-doctrine', 'SKILL.md')));
    // bundle's nested SKILL.md landed
    assert.ok(fs.existsSync(path.join(snapshotRoot, 'marketing-outbound', 'icp-definer', 'SKILL.md')));
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
  assert.ok(findSkillHygieneFailures({ skillId: 'lead-magnet-pdf', text: missing }).includes('disable_model_invocation_missing'));

  const present = missing.replace('description: Use when a lead magnet PDF is explicitly needed.', 'description: Use when a lead magnet PDF is explicitly needed.\ndisable_model_invocation: true');
  assert.deepEqual(findSkillHygieneFailures({ skillId: 'lead-magnet-pdf', text: present }), []);
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
  assert.ok(findSkillHygieneFailures({ skillId: 'content-machine', text: missingLinkedFiles }).includes('linked_files_missing'));
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

test('stageBundledSkills FAILS CLOSED on an invalid bundle (no nested SKILL.md)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-test-'));
  try {
    const srcRoot = makeFixtureSrc(root);
    // Break the bundle: a dir with only a README, no nested SKILL.md.
    fs.rmSync(path.join(srcRoot, 'marketing-outbound'), { recursive: true, force: true });
    fs.mkdirSync(path.join(srcRoot, 'marketing-outbound'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'marketing-outbound', 'README.md'), 'only readme\n');
    const snapshotRoot = path.join(root, 'snapshot');
    const failures = stageBundledSkills({ srcRoot, snapshotRoot });
    assert.ok(failures.includes('bundled_skill_invalid:marketing-outbound'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
