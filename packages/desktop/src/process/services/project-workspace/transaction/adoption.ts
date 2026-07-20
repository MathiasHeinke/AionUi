import fs from 'node:fs';
import path from 'node:path';
import type { ProjectIdentityTuple } from '@/common/types/project-workspace/identity';
import { assertIdentityTuple } from '@/common/types/project-workspace/identity';
import { manifestIdentity, parseProjectManifest } from '@/common/types/project-workspace/manifest';
import { rootComparisonKey } from '../storage/rootPolicy';

const SCAFFOLD_FILES = [
  '.command-eve/project.json',
  'AGENTS.md',
  'memory-bank/system-index.md',
  'memory-bank/projectbrief.md',
  'memory-bank/activeContext.md',
  'memory-bank/progress.md',
  'memory-bank/knowledge-index.md',
  'docs/wiki/project.md',
  'docs/decisions/README.md',
  'docs/page-index.md',
] as const;

export type AdoptionInspection = {
  action: 'preview' | 'continue_existing' | 'reject';
  needs_confirmation: boolean;
  missing: string[];
  collisions: string[];
  reason_code?:
    | 'adoption.manifest-corrupt'
    | 'adoption.foreign-ownership'
    | 'adoption.schema-unsupported'
    | 'adoption.root-unowned'
    | 'adoption.root-overlap'
    | 'adoption.collision'
    | 'adoption.symlink';
};

function ownedRootRelationship(directory: string, root: string): 'direct' | 'nested' | 'outside' {
  const directoryKey = rootComparisonKey(directory);
  const rootKey = rootComparisonKey(root);
  if (rootComparisonKey(path.dirname(directory)) === rootKey && directoryKey !== rootKey) return 'direct';
  return directoryKey.startsWith(`${rootKey}/`) ? 'nested' : 'outside';
}

export function inspectProjectAdoption(input: {
  directory: string;
  expected_identity: ProjectIdentityTuple;
  owned_root_path: string;
  registered_project_paths?: string[];
}): AdoptionInspection {
  try {
    assertIdentityTuple(input.expected_identity);
  } catch {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.collision',
    };
  }
  let directory: string;
  let root: string;
  try {
    const directoryStat = fs.lstatSync(input.directory);
    if (directoryStat.isSymbolicLink()) {
      return {
        action: 'reject',
        needs_confirmation: false,
        missing: [],
        collisions: [],
        reason_code: 'adoption.symlink',
      };
    }
    if (!directoryStat.isDirectory()) {
      return {
        action: 'reject',
        needs_confirmation: false,
        missing: [],
        collisions: [],
        reason_code: 'adoption.collision',
      };
    }
    directory = fs.realpathSync.native(input.directory);
    root = fs.realpathSync.native(input.owned_root_path);
  } catch {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.root-unowned',
    };
  }
  const relationship = ownedRootRelationship(directory, root);
  if (relationship !== 'direct') {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: relationship === 'nested' ? 'adoption.root-overlap' : 'adoption.root-unowned',
    };
  }
  const overlapping = (input.registered_project_paths ?? []).some((registered) => {
    const candidateKey = rootComparisonKey(directory);
    const registeredKey = rootComparisonKey(registered);
    return (
      candidateKey === registeredKey ||
      candidateKey.startsWith(`${registeredKey}/`) ||
      registeredKey.startsWith(`${candidateKey}/`)
    );
  });
  if (overlapping) {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.root-overlap',
    };
  }

  for (const relative of SCAFFOLD_FILES) {
    const segments = relative.split('/');
    let current = directory;
    for (const segment of segments) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) break;
      try {
        const currentStat = fs.lstatSync(current);
        if (currentStat.isSymbolicLink()) {
          return {
            action: 'reject',
            needs_confirmation: false,
            missing: [],
            collisions: [],
            reason_code: 'adoption.symlink',
          };
        }
        const isLeaf = segment === segments.at(-1) && current === path.join(directory, relative);
        if ((!isLeaf && !currentStat.isDirectory()) || (isLeaf && !currentStat.isFile())) {
          return {
            action: 'reject',
            needs_confirmation: false,
            missing: [],
            collisions: [],
            reason_code: 'adoption.collision',
          };
        }
      } catch {
        return {
          action: 'reject',
          needs_confirmation: false,
          missing: [],
          collisions: [],
          reason_code: 'adoption.manifest-corrupt',
        };
      }
    }
  }

  const manifestFile = path.join(directory, '.command-eve', 'project.json');
  if (!fs.existsSync(manifestFile)) {
    const collisions = SCAFFOLD_FILES.filter((relative) => fs.existsSync(path.join(directory, relative)));
    const missing = SCAFFOLD_FILES.filter((relative) => !fs.existsSync(path.join(directory, relative)));
    return { action: 'preview', needs_confirmation: true, missing: [...missing], collisions: [...collisions] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as unknown;
  } catch {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.manifest-corrupt',
    };
  }
  const parsed = parseProjectManifest(raw);
  if (parsed.ok === false) {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code:
        parsed.reason_code === 'schema.unsupported' ? 'adoption.schema-unsupported' : 'adoption.manifest-corrupt',
    };
  }
  const identity = manifestIdentity(parsed.value);
  if (identity.seat_id !== input.expected_identity.seat_id || identity.realm_id !== input.expected_identity.realm_id) {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.foreign-ownership',
    };
  }
  if (
    identity.root_id !== input.expected_identity.root_id ||
    identity.workspace_root_ref !== input.expected_identity.workspace_root_ref ||
    identity.project_id !== input.expected_identity.project_id
  ) {
    return {
      action: 'reject',
      needs_confirmation: false,
      missing: [],
      collisions: [],
      reason_code: 'adoption.collision',
    };
  }
  return { action: 'continue_existing', needs_confirmation: false, missing: [], collisions: [] };
}
