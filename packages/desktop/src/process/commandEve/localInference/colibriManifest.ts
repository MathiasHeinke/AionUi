import path from 'node:path';

import {
  COMMAND_EVE_COLIBRI_ACP_MODEL_ID,
  COMMAND_EVE_COLIBRI_LOCAL_TIER_ID,
  COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID,
} from '../../../common/config/commandEveShell';

export const COMMAND_EVE_COLIBRI_VERSION = 'command-eve-colibri/v0' as const;
export const COMMAND_EVE_COLIBRI_MODEL_ID = COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID;
export { COMMAND_EVE_COLIBRI_ACP_MODEL_ID, COMMAND_EVE_COLIBRI_LOCAL_TIER_ID };

export const COLIBRI_SOURCE = Object.freeze({
  repository: 'JustVugg/colibri',
  commit: 'd4b4f33f22d0ddfb29d3386111a05ff1b2485322',
  url: 'https://github.com/JustVugg/colibri/archive/d4b4f33f22d0ddfb29d3386111a05ff1b2485322.tar.gz',
  fileName: 'colibri-d4b4f33f22d0ddfb29d3386111a05ff1b2485322.tar.gz',
  archiveRoot: 'colibri-d4b4f33f22d0ddfb29d3386111a05ff1b2485322',
  sizeBytes: 1_405_674,
  sha256: '765be6d3c49dbde810fbb93212ab68898c4b4e5a3001a472bff7c9b663d689f9',
  license: 'Apache-2.0',
});

export const COLIBRI_MODEL_SNAPSHOT = Object.freeze({
  repository: 'annelo/GLM-5.2-FP8-Uncensored-Colibri-Int4',
  revision: '5bba67e2e9d7e6d565655f2d923c64247f919db4',
  fileCount: 170,
  totalSizeBytes: 383_957_283_536,
  treeSha256: '7eb139ed5b5a9b2d0e8dbd8adf082b26bb261a5dcf79b7c44ca46085cb4ed543',
  license: 'MIT',
});

export const COLIBRI_MTP_PINS = Object.freeze([
  {
    path: 'out-mtp-00000.safetensors',
    sizeBytes: 3_527_131_672,
    sha256: 'dc020ddbb87347f7e6711c9e8cd2715ac79a2a9f2b4599ff11b7980a35e3cf88',
  },
  {
    path: 'out-mtp-00001.safetensors',
    sizeBytes: 5_366_238_584,
    sha256: '172b49be499a1070505cd13718c47c82165c663d6422e537b1335aae28c331bf',
  },
  {
    path: 'out-mtp-00002.safetensors',
    sizeBytes: 1_065_950_496,
    sha256: '534a1a2a05188dc372f1e0e4f6d72503cbe86fc9a94f085dc6a6a0941b45975d',
  },
]);

export type ColibriPaths = Readonly<{
  root: string;
  downloadsDir: string;
  sourceArchivePath: string;
  runtimeParentDir: string;
  runtimeDir: string;
  cliPath: string;
  enginePath: string;
  modelDir: string;
  receiptPath: string;
  processReceiptPath: string;
  provisionProgressPath: string;
  apiKeyPath: string;
  logPath: string;
}>;

export function resolveColibriPaths(userDataPath: string): ColibriPaths {
  const root = path.join(path.resolve(userDataPath), 'command-eve-runtime', 'local-inference', 'colibri-glm-5-2');
  const runtimeParentDir = path.join(root, 'runtime');
  const runtimeDir = path.join(runtimeParentDir, COLIBRI_SOURCE.commit);
  const downloadsDir = path.join(root, 'downloads');
  return {
    root,
    downloadsDir,
    sourceArchivePath: path.join(downloadsDir, COLIBRI_SOURCE.fileName),
    runtimeParentDir,
    runtimeDir,
    cliPath: path.join(runtimeDir, 'c', 'coli'),
    enginePath: path.join(runtimeDir, 'c', 'glm'),
    modelDir: path.join(root, 'model'),
    receiptPath: path.join(root, 'provision-receipt.json'),
    processReceiptPath: path.join(root, 'server-process.json'),
    provisionProgressPath: path.join(root, 'provision-progress.json'),
    apiKeyPath: path.join(root, 'server-api-key'),
    logPath: path.join(root, 'server.log'),
  };
}

export function isColibriModelRequest(model: string | null | undefined): boolean {
  const normalized = String(model || '').trim();
  return normalized === COMMAND_EVE_COLIBRI_MODEL_ID || normalized === COMMAND_EVE_COLIBRI_ACP_MODEL_ID;
}
