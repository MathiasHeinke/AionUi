import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ProjectWorkspaceRegistryStore } from './storage/registryStore';

/**
 * Seat bootstrap for project workspaces (live-gap fix).
 *
 * Without seeded realms/roots the catalogs of a fresh seat are empty, so the
 * projects UI cannot offer any placement and the create flow is unusable —
 * the same class of gap as the previously unwired service layer. This seeds
 * the two default realms ("Privat" / "Geschäftlich") with one app-managed
 * root each, idempotently: existing realms/roots are never modified, and
 * deterministic ids make a repeated call a pure no-op.
 */

const DEFAULT_REALMS = [
  { slug: 'privat', label: 'Privat', order: 0 },
  { slug: 'geschaeftlich', label: 'Geschäftlich', order: 1 },
] as const;

function deterministicUuid(seed: string): string {
  const digest = Buffer.from(crypto.createHash('sha256').update(seed).digest().subarray(0, 16));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ensureProjectWorkspaceSeatBootstrap(input: {
  registry: ProjectWorkspaceRegistryStore;
  seat_id: string;
  data_path: string;
}): void {
  const { registry, seat_id, data_path } = input;
  registry.initializeSeat(seat_id);

  for (const def of DEFAULT_REALMS) {
    let catalogs = registry.readSeatCatalogs(seat_id);
    if (!catalogs.realms.realms.some((realm) => realm.path_slug === def.slug)) {
      registry.upsertRealm({
        seat_id,
        expected_revision: catalogs.realms.revision,
        realm: {
          realm_id: deterministicUuid(`realm:${seat_id}:${def.slug}`),
          label: def.label,
          path_slug: def.slug,
          status: 'active',
          order: def.order,
        },
      });
      catalogs = registry.readSeatCatalogs(seat_id);
    }
    const realm = catalogs.realms.realms.find((candidate) => candidate.path_slug === def.slug);
    if (!realm) continue;
    if (catalogs.roots.roots.some((root) => root.realm_id === realm.realm_id)) continue;
    const rootPath = path.join(data_path, 'projects', def.slug);
    fs.mkdirSync(rootPath, { recursive: true });
    const global = registry.readGlobalRoots();
    registry.registerRoot({
      seat_id,
      expected_seat_revision: catalogs.roots.revision,
      expected_global_revision: global.revision,
      root: {
        root_id: deterministicUuid(`root:${seat_id}:${def.slug}`),
        realm_id: realm.realm_id,
        label: def.label,
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
  }
}
