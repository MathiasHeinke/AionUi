import type { CommandEvePythonCodeSignature } from '@/process/commandEve/presentationPythonRuntimeCore';

export type VaultNativeOperation = 'snapshot' | 'read' | 'write' | 'restore' | 'delete' | 'list';

export type VaultNativeDirectoryIdentity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}>;

export type VaultNativeResult = Readonly<{
  ok: boolean;
  exists?: boolean;
  bytes_base64?: string;
  entries?: Array<{ name: string; bytes_base64: string }>;
  foreign_dir?: string;
  mutation_state?: 'committed' | 'not_committed' | 'ambiguous';
  transaction_id?: string;
  reason?: string;
}>;

export type VaultNativeRequest = Readonly<{
  operation: VaultNativeOperation;
  directory: string;
  directoryIdentity: VaultNativeDirectoryIdentity;
  fileName?: string;
  data?: Buffer;
}>;

export type VaultNativeTestHelper = Readonly<{
  pythonExecutable: string;
  appPath?: string;
  expectedInterpreter?: Readonly<{
    mode: number;
    size: number;
    sha256: string;
    codeSignature?: CommandEvePythonCodeSignature;
  }>;
  verifyAppSeal?: (appPath: string) => boolean;
  readCodeSignature?: (filePath: string) => CommandEvePythonCodeSignature | undefined;
  swapAwayThenBack?: VaultNativeOperation;
  exitAfterCommitBeforeStdout?: VaultNativeOperation;
  corruptStdoutAfterCommit?: VaultNativeOperation;
  corruptRecordAfterCommit?: VaultNativeOperation;
  recoveryUnavailableAfterCommit?: VaultNativeOperation;
  sleepAfterCommitMs?: number;
  timeoutMs?: number;
  beforeInterpreterLink?: () => void;
}>;
