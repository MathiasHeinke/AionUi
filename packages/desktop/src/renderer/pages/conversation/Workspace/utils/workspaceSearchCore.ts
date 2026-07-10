import type { IDirOrFile } from '@/common/adapter/ipcBridge';

export type WorkspaceLevelLoader = (path: string) => Promise<IDirOrFile[]>;

export interface RecursiveWorkspaceSearchOptions {
  rootPath: string;
  query: string;
  loadLevel: WorkspaceLevelLoader;
  maxDirectories?: number;
  maxResults?: number;
  concurrency?: number;
  ignoredDirectoryNames?: ReadonlySet<string>;
  shouldContinue?: () => boolean;
}

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.cache',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
]);

function getLevelChildren(level: IDirOrFile[]): IDirOrFile[] {
  if (level.length === 1 && !level[0]?.isFile) {
    return level[0]?.children ?? [];
  }
  return level;
}

function createSearchResult(node: IDirOrFile): IDirOrFile {
  return node.isDir ? { ...node, children: [] } : { ...node };
}

/**
 * Search the complete workspace through the conversation-scoped directory
 * endpoint. AionCore's `search` query only filters one directory level, so the
 * renderer performs a bounded breadth-first walk and returns flat, clickable
 * results under the existing workspace root.
 */
export async function searchWorkspaceRecursively({
  rootPath,
  query,
  loadLevel,
  maxDirectories = 512,
  maxResults = 200,
  concurrency = 8,
  ignoredDirectoryNames = DEFAULT_IGNORED_DIRECTORY_NAMES,
  shouldContinue = () => true,
}: RecursiveWorkspaceSearchOptions): Promise<IDirOrFile[]> {
  if (!shouldContinue()) return [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const initialLevel = await loadLevel(rootPath);
  if (!shouldContinue()) return [];
  if (!normalizedQuery || initialLevel.length === 0) return initialLevel;

  const root = initialLevel[0];
  if (!root) return [];

  const matches = new Map<string, IDirOrFile>();
  const directoryQueue: string[] = [];
  let scheduledDirectories = 1;

  const inspect = (children: IDirOrFile[]) => {
    for (const child of children) {
      if (!shouldContinue()) break;
      const searchablePath = `${child.name} ${child.relativePath ?? ''}`.toLocaleLowerCase();
      if (searchablePath.includes(normalizedQuery) && matches.size < maxResults) {
        matches.set(child.fullPath || child.relativePath || child.name, createSearchResult(child));
      }

      if (
        child.isDir &&
        child.fullPath &&
        !ignoredDirectoryNames.has(child.name) &&
        scheduledDirectories < maxDirectories &&
        matches.size < maxResults
      ) {
        directoryQueue.push(child.fullPath);
        scheduledDirectories += 1;
      }
    }
  };

  inspect(getLevelChildren(initialLevel));

  while (shouldContinue() && directoryQueue.length > 0 && matches.size < maxResults) {
    const batch = directoryQueue.splice(0, Math.max(1, concurrency));
    // oxlint-disable-next-line no-await-in-loop -- each batch may discover the next bounded breadth-first batch
    const levels = await Promise.all(batch.map((path) => loadLevel(path).catch((): IDirOrFile[] => [])));
    if (!shouldContinue()) return [];
    for (const level of levels) {
      inspect(getLevelChildren(level));
      if (matches.size >= maxResults) break;
    }
  }

  if (!shouldContinue()) return [];

  return [
    {
      ...root,
      children: [...matches.values()].toSorted((a, b) =>
        (a.relativePath || a.name).localeCompare(b.relativePath || b.name)
      ),
    },
  ];
}
