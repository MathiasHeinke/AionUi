import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import { parseProjectManifest } from '@/common/types/project-workspace/manifest';
import { ensurePrivateDirectory, writeFileAtomic } from '../storage/atomicJson';

export const PROJECT_SCAFFOLD_DIRECTORIES = [
  '.command-eve',
  '.command-eve/receipts',
  'memory-bank',
  'docs',
  'docs/wiki',
  'docs/decisions',
] as const;

export function projectScaffoldFileContents(manifest: ProjectManifestV1): Record<string, string> {
  return {
    '.command-eve/project.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'AGENTS.md': [
      '# Project Workspace',
      '',
      'Read `memory-bank/system-index.md` before loading project context.',
      'Treat `.command-eve/project.json` as identity metadata and never rewrite opaque IDs during display renames.',
      'Keep execution ledgers separate from project knowledge.',
      '',
    ].join('\n'),
    'memory-bank/system-index.md': [
      '# System Index',
      '',
      '- Project brief: `projectbrief.md`',
      '- Active context: `activeContext.md`',
      '- Progress: `progress.md`',
      '- Knowledge catalog: `knowledge-index.md`',
      '- Wiki: `../../docs/wiki/project.md`',
      '- Decisions: `../../docs/decisions/README.md`',
      '',
    ].join('\n'),
    'memory-bank/projectbrief.md': [
      '# Project Brief',
      '',
      `Project: ${manifest.title}`,
      '',
      'Scope is intentionally unfilled.',
      '',
    ].join('\n'),
    'memory-bank/activeContext.md': ['# Active Context', '', 'No active execution context yet.', ''].join('\n'),
    'memory-bank/progress.md': ['# Progress', '', 'No milestones recorded yet.', ''].join('\n'),
    'memory-bank/knowledge-index.md': ['# Knowledge Index', '', 'No curated sources recorded yet.', ''].join('\n'),
    'docs/wiki/project.md': [
      `# ${manifest.title}`,
      '',
      `Project ID: \`${manifest.project_id}\``,
      `Workspace root ref: \`${manifest.workspace_root_ref}\``,
      '',
      'This local file is the canonical project wiki entry.',
      '',
    ].join('\n'),
    'docs/decisions/README.md': ['# Decisions', '', 'Add explicit decision records here.', ''].join('\n'),
    'docs/page-index.md': [
      '# Page Index',
      '',
      '- `wiki/project.md` — canonical project page',
      '- `decisions/README.md` — decision log entrypoint',
      '',
    ].join('\n'),
  };
}

export function sha256Contents(contents: string | Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

export type MaterializedScaffold = {
  created_files: Array<{ relative_path: string; sha256: string }>;
  created_directories: string[];
};

export function validateMaterializedProjectScaffold(
  projectPath: string,
  manifest: ProjectManifestV1,
  materialized: MaterializedScaffold
): boolean {
  const expectedFiles = projectScaffoldFileContents(manifest);
  const expectedEntries = Object.entries(expectedFiles).toSorted(([left], [right]) => left.localeCompare(right));
  if (
    materialized.created_files.length !== expectedEntries.length ||
    materialized.created_directories.length !== PROJECT_SCAFFOLD_DIRECTORIES.length ||
    materialized.created_directories.some((entry, index) => entry !== PROJECT_SCAFFOLD_DIRECTORIES[index])
  ) {
    return false;
  }
  for (const relativeDirectory of PROJECT_SCAFFOLD_DIRECTORIES) {
    try {
      const stat = fs.lstatSync(path.join(projectPath, relativeDirectory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  for (const [index, [relativePath, contents]] of expectedEntries.entries()) {
    const recorded = materialized.created_files[index];
    const file = path.join(projectPath, relativePath);
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        recorded.relative_path !== relativePath ||
        recorded.sha256 !== sha256Contents(contents) ||
        sha256Contents(fs.readFileSync(file)) !== recorded.sha256
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    const parsed = parseProjectManifest(
      JSON.parse(fs.readFileSync(path.join(projectPath, '.command-eve', 'project.json'), 'utf8'))
    );
    return parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(manifest);
  } catch {
    return false;
  }
}

export function materializeProjectScaffold(
  stagingPath: string,
  manifest: ProjectManifestV1,
  beforeMutation: (targetPath: string) => void = () => undefined
): MaterializedScaffold {
  const parsed = parseProjectManifest(manifest);
  if (parsed.ok === false) throw new Error(parsed.reason_code);
  beforeMutation(stagingPath);
  fs.mkdirSync(stagingPath, { mode: 0o700 });
  for (const relative of PROJECT_SCAFFOLD_DIRECTORIES) {
    const directory = path.join(stagingPath, relative);
    beforeMutation(directory);
    ensurePrivateDirectory(directory);
  }
  const files = projectScaffoldFileContents(parsed.value);
  const createdFiles = Object.entries(files)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, contents]) => {
      const file = path.join(stagingPath, relativePath);
      beforeMutation(file);
      writeFileAtomic(file, contents);
      return { relative_path: relativePath, sha256: sha256Contents(contents) };
    });
  return { created_files: createdFiles, created_directories: [...PROJECT_SCAFFOLD_DIRECTORIES] };
}
