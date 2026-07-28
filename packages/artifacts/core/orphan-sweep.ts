import { createHash } from 'node:crypto';
import {
  readdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  recordSystemAction,
} from '@novakai/foundation/dist/contract/index.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type {
  OrphanEntryType,
  OrphanSweepResult,
} from '../contract/schemas.js';
import type { ArtifactsError } from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';
import { listAllArtifacts } from './artifacts.js';
import {
  acquireArtifactPublication,
  releaseArtifactPublication,
} from './publication-lock.js';

interface OrphanEntry {
  artifactId: ArtifactId;
  entryType: OrphanEntryType;
  name: string;
}

function sweepClientOpId(orphan: OrphanEntry): ClientOpId {
  const hex = createHash('sha256')
    .update(`${orphan.artifactId}\0${orphan.entryType}\0${orphan.name}`)
    .digest('hex');
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
  return `op_${uuid}` as ClientOpId;
}

function orphanEntry(name: string): OrphanEntry | null {
  const temp = /^\.(artifact_[^.]+)\.[^.]+\.tmp$/.exec(name);
  if (temp) {
    return {
      artifactId: temp[1] as ArtifactId,
      entryType: 'temp',
      name,
    };
  }
  if (!/^artifact_[A-Za-z0-9-]+$/.test(name)) return null;
  return {
    artifactId: name as ArtifactId,
    entryType: 'final',
    name,
  };
}

async function scanOrphans(
  bytesRoot: string,
): Promise<Result<OrphanEntry[], ArtifactsError>> {
  try {
    const entries = await readdir(bytesRoot, { withFileTypes: true });
    return {
      ok: true,
      value: entries
        .filter((entry) => entry.isFile())
        .map((entry) => orphanEntry(entry.name))
        .filter((entry): entry is OrphanEntry => entry !== null)
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: [] };
    }
    return {
      ok: false,
      error: err(
        'ArtifactOrphanScanFailed',
        `artifact orphan scan failed: ${String(cause)}`,
        { cause: String(cause) },
        true,
      ),
    };
  }
}

async function traceOrphan(
  ctx: ArtifactsContext,
  orphan: OrphanEntry,
): Promise<Result<null, ArtifactsError>> {
  const before = ctx.failpoint(
    orphan.artifactId,
    'artifacts.sweep.before-trace-append',
  );
  if (before) return { ok: false, error: before };
  let traced: Awaited<ReturnType<typeof recordSystemAction>>;
  try {
    traced = await recordSystemAction(ctx.handle, {
      action: 'artifact.orphan.sweep',
      target: { kind: 'artifact', id: orphan.artifactId },
      clientOpId: sweepClientOpId(orphan),
      meta: {
        entryType: orphan.entryType,
        status: 'accepted',
      },
    });
  } catch (cause) {
    return {
      ok: false,
      error: err(
        'ArtifactOrphanTraceFailed',
        `artifact orphan trace failed: ${String(cause)}`,
        {
          artifactId: orphan.artifactId,
          entryType: orphan.entryType,
          cause: String(cause),
        },
        true,
      ),
    };
  }
  if (!traced.ok) return traced;
  const after = ctx.failpoint(
    orphan.artifactId,
    'artifacts.sweep.after-trace-append',
  );
  return after
    ? { ok: false, error: after }
    : { ok: true, value: null };
}

async function deleteOrphan(
  ctx: ArtifactsContext,
  orphan: OrphanEntry,
): Promise<Result<null, ArtifactsError>> {
  const before = ctx.failpoint(
    orphan.artifactId,
    'artifacts.sweep.before-delete',
  );
  if (before) return { ok: false, error: before };
  try {
    await unlink(path.join(ctx.bytesRoot, orphan.name));
  } catch (cause) {
    return {
      ok: false,
      error: err(
        'ArtifactOrphanDeleteFailed',
        `artifact orphan delete failed: ${String(cause)}`,
        {
          artifactId: orphan.artifactId,
          entryType: orphan.entryType,
          cause: String(cause),
        },
        true,
      ),
    };
  }
  const after = ctx.failpoint(
    orphan.artifactId,
    'artifacts.sweep.after-delete',
  );
  return after
    ? { ok: false, error: after }
    : { ok: true, value: null };
}

async function sweepOrphan(
  ctx: ArtifactsContext,
  orphan: OrphanEntry,
): Promise<Result<null, ArtifactsError>> {
  const acquired = await acquireArtifactPublication(
    ctx.bytesRoot,
    orphan.artifactId,
    ctx.publicationLockTimeoutMs,
  );
  if (!acquired.ok) return acquired;
  const traced = await traceOrphan(ctx, orphan);
  const result = traced.ok
    ? await deleteOrphan(ctx, orphan)
    : traced;
  const released = await releaseArtifactPublication(acquired.value);
  return released.ok ? result : released;
}

export async function sweepOrphans(
  ctx: ArtifactsContext,
): Promise<Result<OrphanSweepResult, ArtifactsError>> {
  const listed = await listAllArtifacts(ctx);
  if (!listed.ok) return listed;
  const recordedIds = new Set(listed.value.map((item) => item.id));
  const scanned = await scanOrphans(ctx.bytesRoot);
  if (!scanned.ok) return scanned;
  const orphans = scanned.value.filter(
    (entry) => entry.entryType === 'temp'
      || !recordedIds.has(entry.artifactId),
  );
  const swept: OrphanSweepResult['swept'] = [];
  for (const orphan of orphans) {
    const result = await sweepOrphan(ctx, orphan);
    if (!result.ok) return result;
    swept.push({
      artifactId: orphan.artifactId,
      entryType: orphan.entryType,
    });
  }
  return { ok: true, value: { swept } };
}
