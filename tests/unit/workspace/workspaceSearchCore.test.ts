import { describe, expect, it, vi } from 'vitest';
import type { IDirOrFile } from '@/common/adapter/ipcBridge';
import { searchWorkspaceRecursively } from '@/renderer/pages/conversation/Workspace/utils/workspaceSearchCore';

const workspace = '/workspace';

function directory(name: string, relativePath: string, children: IDirOrFile[] = []): IDirOrFile {
  return {
    name,
    fullPath: relativePath ? `${workspace}/${relativePath}` : workspace,
    relativePath,
    isDir: true,
    isFile: false,
    children,
  };
}

function file(name: string, relativePath: string): IDirOrFile {
  return {
    name,
    fullPath: `${workspace}/${relativePath}`,
    relativePath,
    isDir: false,
    isFile: true,
  };
}

describe('searchWorkspaceRecursively', () => {
  it('finds files below collapsed directories and returns clickable paths', async () => {
    const levels = new Map<string, IDirOrFile[]>([
      [workspace, [directory('workspace', '', [directory('components', 'components'), directory('lib', 'lib')])]],
      [
        `${workspace}/components`,
        [directory('components', 'components', [file('Button.tsx', 'components/Button.tsx')])],
      ],
      [`${workspace}/lib`, [directory('lib', 'lib', [file('api.ts', 'lib/api.ts')])]],
    ]);
    const loadLevel = vi.fn(async (path: string) => levels.get(path) ?? []);

    const result = await searchWorkspaceRecursively({ rootPath: workspace, query: 'api', loadLevel });

    expect(result[0]?.children).toEqual([file('api.ts', 'lib/api.ts')]);
    expect(loadLevel).toHaveBeenCalledWith(`${workspace}/lib`);
  });

  it('does not traverse ignored dependency and build directories', async () => {
    const loadLevel = vi.fn(async (path: string) => {
      if (path === workspace) {
        return [directory('workspace', '', [directory('node_modules', 'node_modules'), directory('src', 'src')])];
      }
      if (path === `${workspace}/src`) {
        return [directory('src', 'src', [file('api.ts', 'src/api.ts')])];
      }
      throw new Error(`Unexpected traversal: ${path}`);
    });

    const result = await searchWorkspaceRecursively({ rootPath: workspace, query: 'api', loadLevel });

    expect(result[0]?.children?.map((entry) => entry.relativePath)).toEqual(['src/api.ts']);
    expect(loadLevel).not.toHaveBeenCalledWith(`${workspace}/node_modules`);
  });

  it('honors directory and result limits', async () => {
    const loadLevel = vi.fn(async (path: string) => {
      if (path === workspace) {
        return [directory('workspace', '', [directory('one', 'one'), directory('two', 'two')])];
      }
      const name = path.split('/').pop()!;
      return [directory(name, name, [file(`${name}-match.ts`, `${name}/${name}-match.ts`)])];
    });

    const result = await searchWorkspaceRecursively({
      rootPath: workspace,
      query: 'match',
      loadLevel,
      maxDirectories: 2,
      maxResults: 1,
    });

    expect(result[0]?.children).toHaveLength(1);
    expect(loadLevel).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling stale recursive work after cancellation', async () => {
    let active = true;
    const loadLevel = vi.fn(async (path: string) => {
      if (path === workspace) {
        return [directory('workspace', '', [directory('one', 'one'), directory('two', 'two')])];
      }
      active = false;
      return [directory('one', 'one', [file('match.ts', 'one/match.ts')])];
    });

    const result = await searchWorkspaceRecursively({
      rootPath: workspace,
      query: 'match',
      loadLevel,
      concurrency: 1,
      shouldContinue: () => active,
    });

    expect(result).toEqual([]);
    expect(loadLevel).toHaveBeenCalledTimes(2);
    expect(loadLevel).not.toHaveBeenCalledWith(`${workspace}/two`);
  });
});
