/**
 * Response/request shape translators between the backend's snake_case DTOs
 * and the legacy camelCase IPC contract our tests assert against.
 *
 * Keeping these as plain Node helpers (not page-evaluated strings) means
 * they're unit-testable and don't require a browser context.
 */

export type ResponseMapperKey =
  | 'dirOrFileTree'
  | 'flatFileList'
  | 'snapshotCompare'
  | 'renameResult'
  | 'previewSnapshotInfo'
  | 'previewSnapshotContent'
  | 'extensionWebui'
  | 'channelPluginStatus'
  | 'teamAgent'
  | 'teamRecord'
  | 'teamList';

type DirOrFileRaw = {
  name: string;
  full_path?: string;
  fullPath?: string;
  relative_path?: string;
  relativePath?: string;
  is_dir?: boolean;
  isDir?: boolean;
  is_file?: boolean;
  isFile?: boolean;
  children?: DirOrFileRaw[];
};

function mapDirOrFile(entry: DirOrFileRaw): Record<string, unknown> {
  return {
    ...entry,
    fullPath: entry.full_path ?? entry.fullPath,
    relativePath: entry.relative_path ?? entry.relativePath,
    isDir: entry.is_dir ?? entry.isDir,
    isFile: entry.is_file ?? entry.isFile,
    children: Array.isArray(entry.children) ? entry.children.map(mapDirOrFile) : entry.children,
  };
}

function mapFlatFile(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    ...entry,
    fullPath: (entry.full_path as string | undefined) ?? (entry.fullPath as string | undefined),
    relativePath: (entry.relative_path as string | undefined) ?? (entry.relativePath as string | undefined),
  };
}

function mapFileChange(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    ...entry,
    filePath: (entry.file_path as string | undefined) ?? (entry.filePath as string | undefined),
    relativePath: (entry.relative_path as string | undefined) ?? (entry.relativePath as string | undefined),
  };
}

function mapTeamAgent(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    ...entry,
    backend: entry.backend ?? entry.assistant_backend,
    agent_type: entry.agent_type ?? entry.backend ?? entry.assistant_backend,
    custom_agent_id: entry.custom_agent_id ?? entry.assistant_id,
  };
}

function mapTeamRecord(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const raw = data as Record<string, unknown>;
  const agents = Array.isArray(raw.agents) ? raw.agents : Array.isArray(raw.assistants) ? raw.assistants : [];
  return {
    ...raw,
    agents: agents.map((entry) => mapTeamAgent(entry as Record<string, unknown>)),
  };
}

function mapExtensionWebui(data: unknown): unknown {
  if (!Array.isArray(data)) return data;

  const grouped = new Map<
    string,
    {
      extensionName: string;
      apiRoutes: Array<Record<string, unknown>>;
      staticAssets: Array<Record<string, unknown>>;
    }
  >();

  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const extensionName = String(raw.extension_name ?? raw.extensionName ?? '').trim();
    if (!extensionName) continue;

    const aggregate = grouped.get(extensionName) ?? { extensionName, apiRoutes: [], staticAssets: [] };
    const routes = Array.isArray(raw.routes) ? raw.routes : Array.isArray(raw.apiRoutes) ? raw.apiRoutes : [];
    for (const route of routes) {
      if (!route || typeof route !== 'object') continue;
      const value = route as Record<string, unknown>;
      aggregate.apiRoutes.push({
        path: value.path,
        method: value.method,
        handler: value.handler ?? value.entryPoint,
        ...(typeof value.auth === 'boolean' ? { auth: value.auth } : {}),
      });
    }

    const assets = Array.isArray(raw.staticAssets) ? raw.staticAssets : [];
    for (const asset of assets) {
      if (asset && typeof asset === 'object') aggregate.staticAssets.push(asset as Record<string, unknown>);
    }

    if (routes.length === 0 && typeof raw.directory === 'string') {
      const id = String(raw.id ?? '');
      aggregate.staticAssets.push({
        directory: raw.directory,
        urlPrefix: id.endsWith('-assets') ? `/${extensionName}/assets` : `/${extensionName}/${id}`,
      });
    }

    grouped.set(extensionName, aggregate);
  }

  return [...grouped.values()];
}

export const RESPONSE_MAPPERS: Record<ResponseMapperKey, (data: unknown) => unknown> = {
  dirOrFileTree: (data) => (Array.isArray(data) ? data.map(mapDirOrFile) : data),
  flatFileList: (data) => (Array.isArray(data) ? data.map((e) => mapFlatFile(e as Record<string, unknown>)) : data),
  snapshotCompare: (data) => {
    if (!data || typeof data !== 'object') return data;
    const d = data as { staged?: unknown; unstaged?: unknown };
    return {
      staged: Array.isArray(d.staged) ? d.staged.map((e) => mapFileChange(e as Record<string, unknown>)) : [],
      unstaged: Array.isArray(d.unstaged) ? d.unstaged.map((e) => mapFileChange(e as Record<string, unknown>)) : [],
    };
  },
  renameResult: (data) => {
    if (!data || typeof data !== 'object') return data;
    const d = data as Record<string, unknown>;
    return {
      ...d,
      newPath: (d.new_path as string | undefined) ?? (d.newPath as string | undefined),
    };
  },
  previewSnapshotInfo: (data) => {
    if (Array.isArray(data)) {
      return data.map((entry) => RESPONSE_MAPPERS.previewSnapshotInfo(entry));
    }
    if (!data || typeof data !== 'object') return data;
    const d = data as Record<string, unknown>;
    return {
      ...d,
      contentType: (d.content_type as string | undefined) ?? (d.contentType as string | undefined),
    };
  },
  previewSnapshotContent: (data) => {
    if (!data || typeof data !== 'object') return data;
    const d = data as Record<string, unknown>;
    const snapshot = d.snapshot as Record<string, unknown> | undefined;
    return {
      ...d,
      snapshot: snapshot
        ? {
            ...snapshot,
            contentType: (snapshot.content_type as string | undefined) ?? (snapshot.contentType as string | undefined),
          }
        : snapshot,
    };
  },
  extensionWebui: mapExtensionWebui,
  teamAgent: (data) => (data && typeof data === 'object' ? mapTeamAgent(data as Record<string, unknown>) : data),
  teamRecord: mapTeamRecord,
  teamList: (data) => (Array.isArray(data) ? data.map(mapTeamRecord) : data),
  channelPluginStatus: (data) =>
    Array.isArray(data)
      ? data.map((entry) => {
          const raw = entry as Record<string, unknown>;
          return {
            id: (raw.plugin_id ?? raw.id) as string,
            type: (raw.type ?? raw.plugin_type) as string,
            name: raw.name as string,
            enabled: raw.enabled as boolean,
            connected: (raw.connected ?? false) as boolean,
            status: raw.status as string | undefined,
            last_connected: raw.last_connected as number | undefined,
            activeUsers: (raw.active_users ?? 0) as number,
            botUsername: raw.bot_username as string | undefined,
            hasToken: (raw.has_token ?? false) as boolean,
            isExtension: raw.is_extension as boolean | undefined,
            extensionMeta: raw.extension_meta,
          };
        })
      : data,
};
