// WebUI 状态接口 / WebUI status interface
export interface WebUIStatus {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  adminUsername: string;
  initialPassword?: string;
}

export interface ElectronDesktopShellAPI {
  openExternal: (url: string) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  showItemInFolder: (filePath: string) => Promise<void>;
}

export interface ElectronBridgeAPI {
  emit: (name: string, data: unknown) => Promise<unknown> | void;
  on: (callback: (event: { value: string }) => void) => void;
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile?: (file: File) => string;
  // Feedback log collection / 收集反馈日志
  collectFeedbackLogs?: () => Promise<{ filename: string; data: number[] } | null>;
  // Feedback screenshot capture / 反馈截图
  captureFeedbackScreenshot?: () => Promise<{ filename: string; data: number[] } | null>;
  // Privileged desktop shell operations are validated in the main process.
  desktopShell?: ElectronDesktopShellAPI;
}

export type BackendStartupFailureReason =
  | 'backend_component_mismatch'
  | 'backend_incompatible_runtime'
  | 'backend_incomplete_installation'
  | 'backend_instance_conflict'
  | 'backend_package_architecture_mismatch'
  | 'backend_startup_failed';

export type BackendIncompleteInstallationKind = 'missing_backend_binary' | 'missing_directory_resources';

export interface BackendStartupFailureInfo {
  incompleteInstallationKind?: BackendIncompleteInstallationKind;
  missingBackendBinary?: boolean;
  missingBundledAioncoreDir?: boolean;
  missingHubDir?: boolean;
  missingPetStatesDir?: boolean;
  missingPwaDir?: boolean;
  reason: BackendStartupFailureReason;
  backendBoundaryCode?: string;
  backendBoundaryStage?: string;
  runtime?: 'glibc';
  requiredVersions?: string[];
  missingResources?: string[];
  missingRuntimeDir?: boolean;
  packageArch?: string;
  deviceArch?: string;
  expectedDownloadArch?: string;
  isRosettaTranslated?: boolean;
  unsupportedArgument?: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
    __initialLanguage?: string | null;
    __backendStartupFailed?: boolean;
    __backendStartupFailure?: BackendStartupFailureInfo | null;
  }
}
