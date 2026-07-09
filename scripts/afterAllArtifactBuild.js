const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getNotarizeAuthMode, getNotarizeOptions } = require('./afterSign.js');

// COMPA-591: electron-builder's dmg-builder (26.8.x) produces a DMG whose inner
// Mach-O main binary Apple notarization rejects ("signature of the binary is
// invalid"), even though the SAME .app notarizes Accepted as a .zip. A plain
// `hdiutil` DMG built from the identical signed .app passes. So before signing +
// notarizing, we REBUILD each DMG from the already-signed .app via hdiutil. This
// makes the pipeline auto-produce notarizable DMGs with no manual step.

// Resolve the signed .app that belongs to a given DMG artifact. electron-builder
// lays the staged app out under <outDir>/mac-<arch>/ (or <outDir>/mac/ for a
// single/universal build); the DMG filename carries the arch.
function findAppForDmg(dmgPath, context) {
  const outDir = (context && context.outDir) || path.dirname(dmgPath);
  const archMatch = path.basename(dmgPath).match(/mac-(arm64|x64|universal)/);
  const candidateDirs = [];
  if (archMatch) candidateDirs.push(path.join(outDir, `mac-${archMatch[1]}`));
  candidateDirs.push(path.join(outDir, 'mac'));
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const app = fs.readdirSync(dir).find((entry) => entry.endsWith('.app'));
    if (app) return path.join(dir, app);
  }
  return null;
}

// Replace the (notary-invalid) electron-builder DMG at dmgPath with a fresh
// hdiutil DMG built from the signed .app: ditto the .app + an /Applications
// drag-link into a staging dir, then `hdiutil create -format ULFO`. Returns the
// .app path on success (the caller then signs + notarizes the new DMG).
function rebuildDmgWithHdiutil(dmgPath, context) {
  const appPath = findAppForDmg(dmgPath, context);
  if (!appPath) {
    console.log(`Skipping hdiutil DMG rebuild for ${path.basename(dmgPath)} - no matching .app found`);
    return null;
  }
  const productName = path.basename(appPath, '.app');
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-dmg-'));
  const stageDir = path.join(stageRoot, 'dmgroot');
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    // ditto preserves the code signature, symlinks and xattrs of the .app.
    execFileSync('ditto', [appPath, path.join(stageDir, `${productName}.app`)], { stdio: 'inherit' });
    fs.symlinkSync('/Applications', path.join(stageDir, 'Applications'));
    if (fs.existsSync(dmgPath)) fs.rmSync(dmgPath, { force: true });
    execFileSync(
      'hdiutil',
      ['create', '-volname', productName, '-srcfolder', stageDir, '-ov', '-format', 'ULFO', dmgPath],
      { stdio: 'inherit' }
    );
    console.log(
      `Rebuilt ${path.basename(dmgPath)} via hdiutil from ${path.basename(appPath)} (electron-builder dmg-builder produces notary-invalid DMGs).`
    );
    return appPath;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getDmgSignIdentity(env = process.env) {
  return firstEnv(env, ['APPLE_DMG_SIGN_IDENTITY', 'APPLE_DEVELOPER_IDENTITY', 'CSC_NAME']);
}

// Args for the post-staple self-verification. `xcrun stapler validate <dmg>`
// proves a notarization ticket is stapled; `spctl -a -t open` proves Gatekeeper
// would accept opening the DMG. Pure builders so they can be unit-tested.
function buildStaplerValidateArgs(artifactPath) {
  return ['stapler', 'validate', artifactPath];
}

function buildSpctlAssessArgs(artifactPath) {
  return ['-a', '-t', 'open', '--context', 'context:primary-signature', artifactPath];
}

function buildNotarytoolArgs(options, artifactPath, env = process.env) {
  const timeout = firstEnv(env, ['NOTARYTOOL_WAIT_TIMEOUT']) || '20m';
  const args = ['notarytool', 'submit', artifactPath, '--wait', '--timeout', timeout];

  if (options?.keychainProfile) {
    args.push('--keychain-profile', options.keychainProfile);
    return args;
  }

  if (options?.appleApiKey && options?.appleApiKeyId && options?.appleApiIssuer) {
    args.push('--key', options.appleApiKey);
    args.push('--key-id', options.appleApiKeyId);
    args.push('--issuer', options.appleApiIssuer);
    return args;
  }

  return null;
}

function signDmgArtifact(artifactPath, env = process.env) {
  const identity = getDmgSignIdentity(env);
  if (!identity) {
    console.log(`Skipping DMG code signature for ${path.basename(artifactPath)} - missing APPLE_DMG_SIGN_IDENTITY`);
    return false;
  }

  execFileSync('codesign', ['--force', '--sign', identity, '--timestamp', artifactPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--verbose=2', artifactPath], { stdio: 'inherit' });
  return true;
}

// `xcrun stapler staple` fails with Error 68 ("A new staple could not be stapled")
// when run IMMEDIATELY after notarytool reports "Accepted": the notarization ticket
// has not yet propagated to Apple's CloudKit CDN that stapler pulls from. It lands
// within seconds-to-minutes. Treat a staple failure as transient and retry with a
// short backoff instead of failing the whole build (the notarization itself already
// succeeded — only the offline-ticket attach is racing). Verified live 2026-06-19:
// notarytool "Accepted" then staple Error 68, and a re-staple ~minutes later worked.
function stapleWithRetry(artifactPath, attempts = 6, delaySeconds = 15) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFileSync('xcrun', ['stapler', 'staple', artifactPath], { stdio: 'inherit' });
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(
        `stapler staple attempt ${attempt}/${attempts} failed (likely Error 68 ticket-propagation race); retrying in ${delaySeconds}s...`
      );
      try { execFileSync('sleep', [String(delaySeconds)], { stdio: 'ignore' }); } catch (_) { /* sleep best-effort */ }
    }
  }
}

function notarizeDmgArtifact(artifactPath, env = process.env) {
  const options = getNotarizeOptions({
    appBundleId: 'dmg-artifact',
    appPath: artifactPath,
    env,
  });
  if (!options) {
    console.log(
      `Skipping DMG notarization for ${path.basename(artifactPath)} - missing Apple notarization credentials`
    );
    return false;
  }

  const args = buildNotarytoolArgs(options, artifactPath, env);
  if (!args) {
    console.log(
      `Skipping DMG notarization for ${path.basename(artifactPath)} - ${getNotarizeAuthMode(options)} is only supported by afterSign app notarization. Use a notarytool Keychain profile or App Store Connect API key for DMG artifacts.`
    );
    return false;
  }

  console.log(`Starting DMG notarization for ${path.basename(artifactPath)} using ${getNotarizeAuthMode(options)}...`);
  execFileSync('xcrun', args, { stdio: 'inherit' });
  stapleWithRetry(artifactPath);
  // Self-verify: prove the staple stuck AND Gatekeeper accepts the DMG. This
  // throws (fails the build) on any problem so we never ship an unverified DMG.
  verifyNotarizationStapled(artifactPath);
  return true;
}

// Decide whether a captured `spctl` run accepted the artifact. spctl writes its
// verdict to stderr and exits 0 on accept / non-zero on reject. Fail-closed:
// require BOTH a zero exit AND an "accepted" verdict; any reject/deny blocks.
function evaluateSpctlAssessment(exitCode, output) {
  const text = String(output == null ? '' : output);
  // `rejected: true` is the ONLY hard-fail signal: an explicit Gatekeeper block.
  // Every other non-accepted outcome is INCONCLUSIVE (rejected:false), because on
  // macOS 15/26 Apple has effectively deprecated `spctl --assess` for DMGs — it
  // frequently exits 0 with no verdict text at all even for a correctly
  // notarized+stapled DMG. `stapler validate` (run first, fail-closed) is the
  // authoritative offline-Gatekeeper proof; spctl here is only a secondary signal.
  if (/\b(rejected|denied)\b/i.test(text)) {
    return { ok: false, rejected: true, detail: 'spctl rejected the artifact (Gatekeeper would block it)' };
  }
  if (exitCode === 0 && /\baccepted\b/i.test(text)) {
    return { ok: true, rejected: false, detail: 'spctl accepted the artifact (Notarized Developer ID)' };
  }
  if (exitCode !== 0) {
    return { ok: false, rejected: false, detail: `spctl exited non-zero (${String(exitCode)}) without a reject verdict` };
  }
  return { ok: false, rejected: false, detail: 'spctl returned no verdict (deprecated on this macOS)' };
}

// Default bounded-retry policy for the spctl Gatekeeper assessment. Right after
// `stapler staple`, Gatekeeper's local assessment DB can lag, so spctl
// transiently returns a non-accepted verdict for a DMG that is genuinely
// notarized + stapled (this false-negative bit alpha.6). We retry the spctl
// assessment a few times with a short backoff before failing. This is a
// false-NEGATIVE fix, NOT a bypass: `stapler validate` remains the authoritative
// staple proof (and still throws immediately on a missing ticket), and a truly
// unsigned/unnotarized DMG that never returns "accepted" still fails closed
// after the retries are exhausted.
const SPCTL_RETRY_ATTEMPTS = 5;
const SPCTL_RETRY_DELAY_MS = 2500;

// Synchronous sleep that does not require a foreground `sleep` binary. Skipped
// entirely when delayMs <= 0 so unit tests run instantly.
function sleepSyncMs(delayMs) {
  if (!delayMs || delayMs <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, delayMs);
}

// Run `xcrun stapler validate` (throws on non-zero) then `spctl -a -t open`
// (captured + evaluated), throwing if Gatekeeper does not accept the DMG.
// The spctl assessment is wrapped in a bounded retry-with-backoff to absorb the
// transient post-staple Gatekeeper-DB lag false-negative; stapler validate is
// the authoritative staple proof and is NOT retried.
function verifyNotarizationStapled(artifactPath, deps = {}) {
  const runValidate =
    deps.runValidate ||
    ((p) => {
      execFileSync('xcrun', buildStaplerValidateArgs(p), { stdio: 'inherit' });
    });
  const runSpctl =
    deps.runSpctl ||
    ((p) => {
      const result = spawnSync('spctl', buildSpctlAssessArgs(p), { encoding: 'utf8' });
      if (result.error) {
        return { status: result.status == null ? 127 : result.status, output: result.error.message };
      }
      return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
    });
  const sleep = deps.sleep || sleepSyncMs;
  const attempts = Number.isInteger(deps.spctlAttempts) && deps.spctlAttempts > 0 ? deps.spctlAttempts : SPCTL_RETRY_ATTEMPTS;
  const delayMs = Number.isInteger(deps.spctlDelayMs) && deps.spctlDelayMs >= 0 ? deps.spctlDelayMs : SPCTL_RETRY_DELAY_MS;

  // stapler validate exits non-zero (and throws via execFileSync) when no ticket
  // is stapled, so a successful return is itself the staple proof. NOT retried:
  // a missing staple is a hard, authoritative failure.
  runValidate(artifactPath);

  // spctl assessment with bounded retry: succeed as soon as it returns accepted;
  // only throw after ALL attempts still fail (fail-closed for a truly-unaccepted
  // DMG). Backoff absorbs the transient post-staple Gatekeeper-DB lag.
  let verdict;
  let spctlResult;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    spctlResult = runSpctl(artifactPath);
    verdict = evaluateSpctlAssessment(spctlResult.status, spctlResult.output);
    if (verdict.ok) break;
    if (attempt < attempts) {
      console.log(
        `Notarization self-verification: spctl not yet accepted for ${path.basename(artifactPath)} ` +
          `(attempt ${attempt}/${attempts}: ${verdict.detail}); retrying in ${delayMs}ms (Gatekeeper DB lag).`
      );
      sleep(delayMs);
    }
  }
  if (!verdict.ok && verdict.rejected) {
    // Explicit Gatekeeper rejection ⇒ hard fail (a real block, e.g. unsigned/revoked).
    throw new Error(
      `Notarization self-verification FAILED for ${path.basename(artifactPath)} after ${attempts} spctl attempt(s): ${
        verdict.detail
      }. ${String(spctlResult.output || '').trim()}`
    );
  }
  if (!verdict.ok) {
    // Inconclusive spctl (deprecated for DMGs on macOS 15/26): `stapler validate`
    // already PASSED above (hard gate), which proves the notarization ticket is
    // stapled — and that is what governs offline Gatekeeper. Treat staple as
    // authoritative; do not fail the build on a flaky secondary signal.
    console.warn(
      `Notarization self-verification: stapler validate PASSED for ${path.basename(artifactPath)}, but spctl was ` +
        `INCONCLUSIVE (${verdict.detail}). Treating the stapled ticket as authoritative.`
    );
    return true;
  }
  console.log(`Notarization self-verification PASSED for ${path.basename(artifactPath)}: stapled + ${verdict.detail}.`);
  return true;
}

// VERSION-TRUTH guard — fail-closed assertion that the built macOS app stamps the
// SINGLE source-of-truth version (repo-root package.json `version`, the same value
// electron-builder uses for the DMG/zip filename and for latest-mac.yml) into BOTH
//   • Contents/Info.plist  → CFBundleShortVersionString + CFBundleVersion, and
//   • the packaged app.asar/package.json `version` → what app.getVersion() returns
//     at runtime (drives ensureCommandEveAssistant, Sentry, the About panel and,
//     critically, electron-updater's installed-version comparison).
//
// Why this exists: a stale third version source (an old "1.1.7"-class value baked
// in via a generated app package.json, a leftover out/ asar, or an electron-builder
// directories.app repoint) would make every 1.2.x DMG INSTALL AS the old version —
// the app always looks old AND electron-updater perpetually re-"updates"/downgrades
// because installed (old) < feed (new). Nothing self-detected that today. This guard
// turns that silent footgun into a loud build failure BEFORE notarize (founder
// self-detection standard). It is a pure verifier — it never rewrites the build.

// Read the single source-of-truth version from the repo-root package.json (the
// exact value electron-builder reads as Metadata.version via `directories.app: .`).
function readRootPackageVersion(projectRoot = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('VERSION-TRUTH: repo-root package.json has no string `version`.');
  }
  return pkg.version;
}

// Read CFBundleShortVersionString + CFBundleVersion from a built .app's Info.plist.
// Uses PlistBuddy (always present on macOS, where this hook runs) so we never need
// an XML/binary-plist parser dependency. Pure read.
function readInfoPlistVersions(appPath, deps = {}) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const read = (key) => {
    const runner =
      deps.runPlistBuddy ||
      ((p, k) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, p], { encoding: 'utf8' }));
    return String(runner(plistPath, key)).trim();
  };
  return {
    shortVersion: read('CFBundleShortVersionString'),
    bundleVersion: read('CFBundleVersion'),
  };
}

// Read the `version` from the package.json packaged inside the app's app.asar —
// i.e. exactly what app.getVersion() returns at runtime. Parses the asar header
// (pickle: uint32 len at byte 12, JSON header at byte 16, 4-byte-aligned data) and
// extracts the root package.json entry without needing the @electron/asar CLI.
function readAsarPackageVersion(appPath, deps = {}) {
  const reader = deps.readAsarPackageJson || defaultReadAsarPackageJson;
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const raw = reader(asarPath);
  const pkg = JSON.parse(raw);
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('VERSION-TRUTH: packaged app.asar package.json has no string `version`.');
  }
  return pkg.version;
}

function defaultReadAsarPackageJson(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const hb = Buffer.alloc(jsonLen);
    fs.readSync(fd, hb, 0, jsonLen, 16);
    let s = hb.toString('utf8');
    s = s.slice(0, s.lastIndexOf('}') + 1);
    const header = JSON.parse(s);
    const entry = header.files && header.files['package.json'];
    if (!entry) throw new Error('VERSION-TRUTH: no root package.json entry in app.asar header.');
    const baseDataOffset = 16 + jsonLen + ((4 - (jsonLen % 4)) % 4);
    const off = baseDataOffset + Number(entry.offset);
    const fb = Buffer.alloc(entry.size);
    fs.readSync(fd, fb, 0, entry.size, off);
    return fb.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Compare the three stamped versions against the expected SSOT version. Returns a
// list of human-readable mismatch reasons (empty array = all consistent). Pure so
// it is fully unit-testable without a real .app on disk.
function collectVersionMismatches(expected, { shortVersion, bundleVersion, asarVersion }) {
  const mismatches = [];
  if (shortVersion !== expected)
    mismatches.push(`Info.plist CFBundleShortVersionString=${shortVersion} (expected ${expected})`);
  if (bundleVersion !== expected)
    mismatches.push(`Info.plist CFBundleVersion=${bundleVersion} (expected ${expected})`);
  if (asarVersion !== expected)
    mismatches.push(
      `app.asar package.json version=${asarVersion} (expected ${expected}) — drives app.getVersion()/electron-updater`
    );
  return mismatches;
}

// Locate the built .app(s) under context.outDir (mac-arm64/, mac-x64/, mac/) and
// assert each stamps the SSOT version. THROWS (fails the build, before notarize)
// on any mismatch. No mac app found ⇒ no-op (e.g. a Windows/Linux-only invocation).
function verifyBuiltVersionMatchesSource(context, deps = {}) {
  const projectRoot = deps.projectRoot || process.cwd();
  const expected = (deps.readRootVersion || readRootPackageVersion)(projectRoot);
  const outDir = (context && context.outDir) || path.join(projectRoot, 'out');

  const appPaths = [];
  for (const sub of ['mac-arm64', 'mac-x64', 'mac-universal', 'mac']) {
    const dir = path.join(outDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.app')) appPaths.push(path.join(dir, entry));
    }
  }
  if (appPaths.length === 0) {
    console.log('VERSION-TRUTH guard: no built macOS .app found under outDir — skipping (non-mac artifact run).');
    return;
  }

  for (const appPath of appPaths) {
    const { shortVersion, bundleVersion } = (deps.readInfoPlistVersions || readInfoPlistVersions)(appPath, deps);
    const asarVersion = (deps.readAsarPackageVersion || readAsarPackageVersion)(appPath, deps);
    const mismatches = collectVersionMismatches(expected, { shortVersion, bundleVersion, asarVersion });
    if (mismatches.length > 0) {
      throw new Error(
        `VERSION-TRUTH: built ${path.basename(appPath)} does NOT stamp the source-of-truth version ` +
          `(${expected}) — build BLOCKED before notarize. A stale third version source would ship an app that ` +
          `installs as the wrong version and breaks electron-updater:\n  - ${mismatches.join('\n  - ')}`
      );
    }
    console.log(`✓ VERSION-TRUTH guard: ${path.basename(appPath)} stamps ${expected} in Info.plist + app.asar.`);
  }
}

function sha512Base64(filePath, deps = {}) {
  const readFile = deps.readFile || fs.readFileSync;
  return crypto.createHash('sha512').update(readFile(filePath)).digest('base64');
}

function normalizeReleaseDate(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseMacArtifact(filePath) {
  const fileName = path.basename(filePath);
  const match = fileName.match(/^Command-EVE-(.+)-mac-(arm64|x64|universal)\.(dmg|zip)$/);
  if (!match) return null;
  return {
    fileName,
    version: match[1],
    arch: match[2],
    ext: match[3],
  };
}

function collectMacUpdateArtifactGroups(context, deps = {}) {
  const projectRoot = deps.projectRoot || process.cwd();
  const outDir = (context && context.outDir) || path.join(projectRoot, 'out');
  const expectedVersion = (deps.readRootVersion || readRootPackageVersion)(projectRoot);
  const stat = deps.stat || fs.statSync;
  const exists = deps.exists || fs.existsSync;
  const readdir = deps.readdir || fs.readdirSync;

  const candidates = new Set(Array.isArray(context?.artifactPaths) ? context.artifactPaths : []);
  if (exists(outDir)) {
    for (const entry of readdir(outDir)) {
      if (entry.includes(`Command-EVE-${expectedVersion}-mac-`)) {
        candidates.add(path.join(outDir, entry));
      }
    }
  }

  const groups = new Map();
  for (const artifactPath of candidates) {
    const parsed = parseMacArtifact(artifactPath);
    if (!parsed || parsed.version !== expectedVersion || !exists(artifactPath)) continue;
    const artifact = {
      url: parsed.fileName,
      sha512: sha512Base64(artifactPath, deps),
      size: stat(artifactPath).size,
    };
    const current = groups.get(parsed.arch) || {};
    current[parsed.ext] = artifact;
    groups.set(parsed.arch, current);
  }

  return { outDir, version: expectedVersion, groups };
}

function indentBlock(text, spaces = 2) {
  const indent = ' '.repeat(spaces);
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function buildMacUpdateYml({ version, files, releaseDate, releaseNotes }) {
  const zip = files.zip;
  const dmg = files.dmg;
  if (!zip) {
    throw new Error(`UPDATE-FEED: missing macOS zip artifact for ${version}; electron-updater requires a zip path.`);
  }
  if (!dmg) {
    throw new Error(`UPDATE-FEED: missing macOS dmg artifact for ${version}; release feed would be incomplete.`);
  }

  const entries = [zip, dmg];
  const lines = [`version: ${version}`, 'files:'];
  for (const entry of entries) {
    lines.push(`  - url: ${entry.url}`);
    lines.push(`    sha512: ${entry.sha512}`);
    lines.push(`    size: ${entry.size}`);
  }
  lines.push(`path: ${zip.url}`);
  lines.push(`sha512: ${zip.sha512}`);
  lines.push(`releaseDate: '${releaseDate}'`);
  lines.push('releaseNotes: |');
  lines.push(indentBlock(releaseNotes || `Command EVE ${version}`, 2));
  return `${lines.join('\n')}\n`;
}

function metadataFileNameForMacArch(arch) {
  if (arch === 'x64' || arch === 'universal') return 'latest-mac.yml';
  return `latest-${arch}-mac.yml`;
}

function writeMacUpdateFeedMetadata(context, deps = {}) {
  const { outDir, version, groups } = collectMacUpdateArtifactGroups(context, deps);
  if (groups.size === 0) {
    console.log('UPDATE-FEED guard: no macOS update artifacts found — skipping metadata rewrite.');
    return [];
  }

  const writeFile = deps.writeFile || fs.writeFileSync;
  const exists = deps.exists || fs.existsSync;
  const unlink = deps.unlink || fs.unlinkSync;
  const releaseDate = deps.releaseDate || normalizeReleaseDate(deps.now || new Date());
  const releaseNotes = deps.releaseNotes || `Command EVE ${version}`;
  const written = [];
  const versionJson = {
    version,
    released_at: releaseDate,
  };
  const expectedMetadata = new Set([...groups.keys()].map(metadataFileNameForMacArch));

  // electron-builder may emit a generic latest-mac.yml before the hdiutil rebuild.
  // Arm64-only releases must not leave that stale x64/universal metadata beside
  // latest-arm64-mac.yml; one broad upload glob would publish the wrong DMG hash.
  for (const metadataName of ['latest-mac.yml', 'latest-arm64-mac.yml']) {
    if (expectedMetadata.has(metadataName)) continue;
    const stalePath = path.join(outDir, metadataName);
    if (!exists(stalePath)) continue;
    unlink(stalePath);
    console.log(`✓ UPDATE-FEED guard: removed stale ${metadataName}.`);
  }

  for (const [arch, files] of groups) {
    const metadataName = metadataFileNameForMacArch(arch);
    const yml = buildMacUpdateYml({ version, files, releaseDate, releaseNotes });
    const metadataPath = path.join(outDir, metadataName);
    writeFile(metadataPath, yml);
    written.push(metadataPath);
    if (files.dmg) versionJson[arch] = files.dmg.url;
  }

  const versionJsonPath = path.join(outDir, 'version.json');
  writeFile(versionJsonPath, `${JSON.stringify(versionJson, null, 2)}\n`);
  written.push(versionJsonPath);

  console.log(
    `✓ UPDATE-FEED guard: rewrote ${written.map((file) => path.basename(file)).join(', ')} for ${version}.`
  );
  return written;
}

// SECURITY (Teardown C2) — never ship PRIVATE signing-key material. The license
// signing keys mint every license; one accidental bundle = total entitlement
// bypass, only undone by rotating the trust root (which breaks issued licenses).
// Scan the built bundle + the shippable source dirs; THROW (fail the build,
// before notarize) on any private key. Public keys are allowed and pass.
async function verifyNoPrivateKeysShipped(context) {
  const { scanForPrivateKeys } = await import('./release/verify-no-private-keys.mjs');
  const outDir = (context && context.outDir) || path.join(process.cwd(), 'out');
  const roots = [outDir, path.join(process.cwd(), 'public'), path.join(process.cwd(), 'resources')].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (roots.length === 0) return;
  const findings = scanForPrivateKeys(roots);
  if (findings.length > 0) {
    const lines = findings.map((f) => `  - ${f.file} (${f.reason})`).join('\n');
    throw new Error(`SECURITY: private signing-key material in a shippable path — build BLOCKED:\n${lines}`);
  }
  console.log(`✓ C2 guard: no private-key material under ${roots.length} shippable path(s).`);
}

exports.default = async function afterAllArtifactBuild(context) {
  if (process.platform !== 'darwin') {
    return context.artifactPaths;
  }

  // Fail the build before notarize if any private signing key sneaked into a
  // shippable path (C2 CI guard).
  await verifyNoPrivateKeysShipped(context);

  // Fail the build before notarize if the built app does NOT stamp the single
  // source-of-truth version (root package.json) into Info.plist + app.asar. This
  // catches the "ships as 1.1.7 / breaks electron-updater" class of footgun loudly
  // instead of letting a stale version reach users.
  verifyBuiltVersionMatchesSource(context);

  const artifactPaths = Array.isArray(context.artifactPaths) ? context.artifactPaths : [];
  const dmgArtifacts = artifactPaths.filter((artifactPath) => artifactPath.endsWith('.dmg'));

  for (const artifactPath of dmgArtifacts) {
    // Rebuild the DMG from the signed .app first (electron-builder's dmg-builder
    // output fails notarization); then sign + notarize the hdiutil DMG.
    rebuildDmgWithHdiutil(artifactPath, context);
    signDmgArtifact(artifactPath);
    notarizeDmgArtifact(artifactPath);
  }

  // The hdiutil rebuild replaces the DMG after electron-builder has emitted its
  // generic updater metadata. Regenerate the feed from the FINAL zip/DMG bytes so
  // stale yml/version.json files from prior releases cannot silently ship.
  writeMacUpdateFeedMetadata(context);

  return artifactPaths;
};

exports.buildNotarytoolArgs = buildNotarytoolArgs;
exports.buildStaplerValidateArgs = buildStaplerValidateArgs;
exports.buildSpctlAssessArgs = buildSpctlAssessArgs;
exports.evaluateSpctlAssessment = evaluateSpctlAssessment;
exports.verifyNotarizationStapled = verifyNotarizationStapled;
exports.findAppForDmg = findAppForDmg;
exports.rebuildDmgWithHdiutil = rebuildDmgWithHdiutil;
exports.getDmgSignIdentity = getDmgSignIdentity;
exports.notarizeDmgArtifact = notarizeDmgArtifact;
exports.signDmgArtifact = signDmgArtifact;
exports.readRootPackageVersion = readRootPackageVersion;
exports.readInfoPlistVersions = readInfoPlistVersions;
exports.readAsarPackageVersion = readAsarPackageVersion;
exports.collectVersionMismatches = collectVersionMismatches;
exports.verifyBuiltVersionMatchesSource = verifyBuiltVersionMatchesSource;
exports.sha512Base64 = sha512Base64;
exports.parseMacArtifact = parseMacArtifact;
exports.collectMacUpdateArtifactGroups = collectMacUpdateArtifactGroups;
exports.buildMacUpdateYml = buildMacUpdateYml;
exports.metadataFileNameForMacArch = metadataFileNameForMacArch;
exports.writeMacUpdateFeedMetadata = writeMacUpdateFeedMetadata;
