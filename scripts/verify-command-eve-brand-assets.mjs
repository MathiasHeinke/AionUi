#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import sharp from 'sharp';
import { isOpaqueWhitePixel } from './command-eve-brand-contract.mjs';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pngContracts = [
  ['resources/command-eve-icon-master.png', 1024],
  ['resources/icon.png', 1024],
  ['resources/app.png', 1024],
  ['resources/app_dev.png', 1024],
  ['packages/desktop/src/renderer/assets/logos/brand/app.png', 1024],
  ['mobile/assets/images/icon.png', 1024],
  ['resources/aionui_logo_no_border.png', 1024],
  ['public/pwa/icon-180.png', 180],
  ['public/pwa/icon-192.png', 192],
  ['public/pwa/icon-512.png', 512],
];

async function inspectEveRaster(filePath, expectedSize, options = {}) {
  const image = sharp(filePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const dimensionsMatch = options.minimumSize
    ? info.width >= expectedSize && info.height >= expectedSize
    : info.width === expectedSize && info.height === expectedSize;
  if (!dimensionsMatch || info.channels !== 4) {
    const qualifier = options.minimumSize ? 'at least ' : '';
    throw new Error(`${path.relative(repoRoot, filePath)} must be ${qualifier}${expectedSize}x${expectedSize} RGBA.`);
  }

  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const corners = [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ];
  if (corners.some((alpha) => alpha !== 0)) {
    throw new Error(`${path.relative(repoRoot, filePath)} has non-transparent corner alpha: ${corners.join(', ')}.`);
  }

  let transparentPixels = 0;
  let opaqueWhitePixels = 0;
  let darkPixels = 0;
  let orangePixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [red, green, blue, alpha] = data.subarray(offset, offset + info.channels);
    if (alpha === 0) transparentPixels += 1;
    if (isOpaqueWhitePixel(red, green, blue, alpha)) opaqueWhitePixels += 1;
    if (alpha >= 250 && red <= 35 && green <= 45 && blue <= 65) darkPixels += 1;
    if (alpha >= 250 && red >= 220 && green >= 75 && green <= 150 && blue <= 55) orangePixels += 1;
  }
  const pixelCount = info.width * info.height;
  if (transparentPixels < pixelCount * 0.02) {
    throw new Error(`${path.relative(repoRoot, filePath)} lacks the transparent squircle corners.`);
  }
  if (opaqueWhitePixels > 0) {
    throw new Error(
      `${path.relative(repoRoot, filePath)} contains ${opaqueWhitePixels} opaque-white pixel(s); legacy AionUi/fringe detected.`
    );
  }
  if (darkPixels < pixelCount * 0.5 || orangePixels < pixelCount * 0.05) {
    throw new Error(`${path.relative(repoRoot, filePath)} does not match the dark/orange Command EVE brand contract.`);
  }
}

async function verifySvgParity() {
  const publicLogo = await readFile(path.join(repoRoot, 'public', 'command-eve-logo.svg'), 'utf8');
  const rendererLogo = await readFile(
    path.join(repoRoot, 'packages', 'desktop', 'src', 'renderer', 'assets', 'logo.svg'),
    'utf8'
  );
  if (rendererLogo !== publicLogo) {
    throw new Error('Renderer logo.svg must be byte-identical to public/command-eve-logo.svg.');
  }
  const legacyAliasLogo = await readFile(path.join(repoRoot, 'resources', 'aionui_logo_black_bg.svg'), 'utf8');
  if (legacyAliasLogo !== publicLogo) {
    throw new Error('Legacy-named resource SVG must contain the canonical Command EVE mark.');
  }
  if (!publicLogo.includes('⌘') || !publicLogo.toLowerCase().includes('#f97316')) {
    throw new Error('Command EVE SVG must contain the canonical orange command mark.');
  }
  if (/AionUI Logo|fill=["']white["']|M40 20 Q38 22 25 40/i.test(publicLogo)) {
    throw new Error('Legacy AionUi SVG glyph detected in the Command EVE brand surface.');
  }
}

async function verifyPlatformContainers() {
  if (process.platform !== 'darwin') return;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'command-eve-brand-verify-'));
  try {
    const containers = [
      ['resources/app.icns', 'icns', 1024],
      ['resources/app.ico', 'ico', 256],
    ];
    for (const [relativePath, format, expectedSize] of containers) {
      const source = path.join(repoRoot, relativePath);
      const output = path.join(tempRoot, `${format}.png`);
      await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', output]);
      await inspectEveRaster(output, expectedSize, { minimumSize: true });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  for (const [relativePath, expectedSize] of pngContracts) {
    await inspectEveRaster(path.join(repoRoot, relativePath), expectedSize);
  }
  await verifySvgParity();
  await verifyPlatformContainers();
  console.log(`Command EVE brand gate PASS (${pngContracts.length} PNG surfaces + SVG parity + platform containers).`);
}

await main();
