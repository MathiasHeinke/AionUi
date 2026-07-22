#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import sharp from 'sharp';
import { isOpaqueWhitePixel } from './command-eve-brand-contract.mjs';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const masterPath = path.join(repoRoot, 'resources', 'command-eve-icon-master.png');

const pngTargets = [
  ['resources/icon.png', 1024],
  ['resources/app.png', 1024],
  ['resources/app_dev.png', 1024],
  ['packages/desktop/src/renderer/assets/logos/brand/app.png', 1024],
  ['mobile/assets/images/icon.png', 1024],
  // Legacy filename retained only for compatibility; its content is canonical EVE.
  ['resources/aionui_logo_no_border.png', 1024],
  ['public/pwa/icon-180.png', 180],
  ['public/pwa/icon-192.png', 192],
  ['public/pwa/icon-512.png', 512],
];

const iconsetTargets = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

async function assertCanonicalMaster() {
  const image = sharp(masterPath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1024 || info.height !== 1024 || info.channels !== 4) {
    throw new Error('Command EVE icon master must be a 1024x1024 RGBA PNG.');
  }

  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const corners = [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ];
  if (corners.some((alpha) => alpha !== 0)) {
    throw new Error(`Command EVE icon master corners must be transparent; got alpha ${corners.join(', ')}.`);
  }

  let opaqueWhitePixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [red, green, blue, alpha] = data.subarray(offset, offset + info.channels);
    if (isOpaqueWhitePixel(red, green, blue, alpha)) opaqueWhitePixels += 1;
  }
  if (opaqueWhitePixels > 0) {
    throw new Error(`Command EVE icon master contains ${opaqueWhitePixels} opaque-white fringe pixel(s).`);
  }
}

async function writePng(relativePath, size) {
  const output = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(output), { recursive: true });
  await sharp(masterPath)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toFile(output);
}

async function generatePlatformContainers(tempRoot) {
  if (process.platform !== 'darwin') {
    throw new Error('ICNS/ICO regeneration requires macOS iconutil and sips.');
  }

  const iconset = path.join(tempRoot, 'CommandEVE.iconset');
  await mkdir(iconset, { recursive: true });
  for (const [name, size] of iconsetTargets) {
    await sharp(masterPath)
      .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, palette: false })
      .toFile(path.join(iconset, name));
  }
  await run('/usr/bin/iconutil', [
    '--convert',
    'icns',
    '--output',
    path.join(repoRoot, 'resources', 'app.icns'),
    iconset,
  ]);

  const icoSource = path.join(tempRoot, 'CommandEVE-256.png');
  await sharp(masterPath)
    .resize(256, 256, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toFile(icoSource);
  await run('/usr/bin/sips', ['-s', 'format', 'ico', icoSource, '--out', path.join(repoRoot, 'resources', 'app.ico')]);
}

async function main() {
  await assertCanonicalMaster();
  for (const [relativePath, size] of pngTargets) await writePng(relativePath, size);
  await copyFile(
    path.join(repoRoot, 'public', 'command-eve-logo.svg'),
    path.join(repoRoot, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo.svg')
  );
  // Keep upstream-compatible filenames from ever reintroducing the old AionUi glyph.
  await copyFile(
    path.join(repoRoot, 'public', 'command-eve-logo.svg'),
    path.join(repoRoot, 'resources', 'aionui_logo_black_bg.svg')
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'command-eve-icons-'));
  try {
    await generatePlatformContainers(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`Command EVE brand assets regenerated from ${path.relative(repoRoot, masterPath)}.`);
}

await main();
