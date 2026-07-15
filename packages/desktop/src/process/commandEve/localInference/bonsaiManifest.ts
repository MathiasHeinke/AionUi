import path from 'node:path';

import {
  COMMAND_EVE_BONSAI_ACP_MODEL_ID,
  COMMAND_EVE_BONSAI_LOCAL_TIER_ID,
  COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID,
} from '../../../common/config/commandEveShell';

export const COMMAND_EVE_BONSAI_PILOT_VERSION = 'command-eve-bonsai-pilot/v0' as const;
export const COMMAND_EVE_BONSAI_MODEL_ID = COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID;
export { COMMAND_EVE_BONSAI_ACP_MODEL_ID, COMMAND_EVE_BONSAI_LOCAL_TIER_ID };
export const COMMAND_EVE_BONSAI_PILOT_ENV = 'COMMAND_EVE_BONSAI_PILOT' as const;

export type BonsaiPinnedArtifact = Readonly<{
  id: 'runtime' | 'model';
  url: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}>;

export const BONSAI_RUNTIME_ARTIFACT: BonsaiPinnedArtifact = Object.freeze({
  id: 'runtime',
  url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b9591-62061f9/llama-prism-b9591-62061f9-bin-macos-arm64.tar.gz',
  fileName: 'llama-prism-b9591-62061f9-bin-macos-arm64.tar.gz',
  sizeBytes: 11_164_682,
  sha256: 'e8dd4d8a23704afb02eda7136be3ed05f875c02bb82f413a5e897c9a50f774a8',
});

export const BONSAI_MODEL_ARTIFACT: BonsaiPinnedArtifact = Object.freeze({
  id: 'model',
  url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf/resolve/main/Ternary-Bonsai-27B-Q2_0.gguf?download=true',
  fileName: 'Ternary-Bonsai-27B-Q2_0.gguf',
  sizeBytes: 7_165_121_600,
  sha256: '868c11714cf8fe47f5ec9eeb2be0ab1a337112886f92ee0ede6b855c4fa31757',
});

export const BONSAI_RUNTIME_RELEASE = Object.freeze({
  tag: 'prism-b9591-62061f9',
  sourceCommit: '62061f91088281e65071cc38c5f69ee95c39f14e',
  archiveRoot: 'llama-prism-b9591-62061f9',
  serverFileName: 'llama-server',
  serverSha256: '7a36385c922c8984e7876773c65e5f4100e8d52c09d1c011d14b44e8ab61fc7c',
});

export type BonsaiPilotPaths = Readonly<{
  root: string;
  downloadsDir: string;
  modelDir: string;
  runtimeParentDir: string;
  runtimeDir: string;
  runtimeArchivePath: string;
  modelPath: string;
  serverPath: string;
  apiKeyPath: string;
  receiptPath: string;
  processReceiptPath: string;
  provisionProgressPath: string;
  logPath: string;
}>;

export function resolveBonsaiPilotPaths(userDataPath: string): BonsaiPilotPaths {
  const root = path.join(path.resolve(userDataPath), 'command-eve-runtime', 'local-inference', 'bonsai-27b');
  const downloadsDir = path.join(root, 'downloads');
  const modelDir = path.join(root, 'models');
  const runtimeParentDir = path.join(root, 'runtime');
  const runtimeDir = path.join(runtimeParentDir, BONSAI_RUNTIME_RELEASE.tag);
  return {
    root,
    downloadsDir,
    modelDir,
    runtimeParentDir,
    runtimeDir,
    runtimeArchivePath: path.join(downloadsDir, BONSAI_RUNTIME_ARTIFACT.fileName),
    modelPath: path.join(modelDir, BONSAI_MODEL_ARTIFACT.fileName),
    serverPath: path.join(runtimeDir, BONSAI_RUNTIME_RELEASE.serverFileName),
    apiKeyPath: path.join(root, 'server-api-key'),
    receiptPath: path.join(root, 'provision-receipt.json'),
    processReceiptPath: path.join(root, 'server-process.json'),
    provisionProgressPath: path.join(root, 'provision-progress.json'),
    logPath: path.join(root, 'server.log'),
  };
}

export function isBonsaiModelRequest(model: string | null | undefined): boolean {
  const normalized = String(model || '').trim();
  return normalized === COMMAND_EVE_BONSAI_MODEL_ID || normalized === COMMAND_EVE_BONSAI_ACP_MODEL_ID;
}

export function isBonsaiPilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMMAND_EVE_BONSAI_PILOT_ENV] === '1';
}
