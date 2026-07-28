import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createObject,
  getObjectByClientOpId,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
  mintClientOpId,
  recordSystemAction,
} from '@novakai/foundation/dist/contract/index.js';
import {
  err,
  type StoreError,
} from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
  ClientOpId,
  ObjectId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  Absent,
  Page,
  Result,
} from '@novakai/foundation/dist/contract/types.js';
import {
  Artifact,
  PutArtifactInput,
  type Artifact as ArtifactT,
  type OrphanEntryType,
  type OrphanSweepResult,
  type PutArtifactInput as PutArtifactInputT,
} from '../contract/schemas.js';
import type {
  ArtifactByteEffect,
  ArtifactsError,
  StoredArtifactInvalidError,
} from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';

function invalidInput(
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): StoreError {
  return err(
    'InvalidEnvelope',
    `artifact input rejected: ${error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')}`,
    {
      missingFields: [],
      invalidFields: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function missingClientOpId(): StoreError {
  return err(
    'InvalidEnvelope',
    'clientOpId is required for every Artifacts mutation',
    {
      missingFields: ['clientOpId'],
      invalidFields: [
        { field: 'clientOpId', reason: 'required non-empty string' },
      ],
    },
    false,
  );
}

function byteEffectFailed(
  artifactId: ArtifactId,
  effect: ArtifactByteEffect,
  cause: unknown,
): ArtifactsError {
  return err(
    'ArtifactByteEffectFailed',
    `artifact ${effect} failed: ${String(cause)}`,
    { artifactId, effect, cause: String(cause) },
    true,
  );
}

function storedArtifactInvalid(
  artifactId: ArtifactId,
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): StoredArtifactInvalidError {
  return err(
    'StoredArtifactInvalid',
    `stored artifact "${artifactId}" does not match the Artifacts schema`,
    {
      ref: { kind: 'artifact', id: artifactId },
      issues: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function injectedFailpoint(
  artifactId: ArtifactId,
  point: string,
): ArtifactsError | null {
  if (process.env.NVK_FAILPOINT !== point) return null;
  return err(
    'ArtifactFailpoint',
    `artifact failpoint injected at "${point}"`,
    { artifactId, point },
    true,
  );
}

function artifactIdFor(clientOpId: ClientOpId): ArtifactId {
  const hex = createHash('sha256').update(clientOpId).digest('hex');
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
  return `artifact_${uuid}` as ArtifactId;
}

export async function putArtifact(
  ctx: ArtifactsContext,
  input: PutArtifactInputT,
  clientOpId: ClientOpId,
): Promise<Result<ArtifactT, ArtifactsError>> {
  if (typeof clientOpId !== 'string' || clientOpId.length === 0) {
    return { ok: false, error: missingClientOpId() };
  }
  const parsed = PutArtifactInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: invalidInput(parsed.error) };
  }
  const artifactId = artifactIdFor(clientOpId);
  const tempPath = path.join(
    ctx.bytesRoot,
    `.${artifactId}.${randomUUID()}.tmp`,
  );
  const finalPath = path.join(ctx.bytesRoot, artifactId);
  if (existsSync(finalPath)) {
    const replay = await getObjectByClientOpId<ArtifactT>(
      ctx.handle,
      'artifact',
      clientOpId,
    );
    if (!replay.ok) return replay;
    if (replay.value) {
      const stored = Artifact.safeParse(replay.value.object);
      return stored.success
        ? { ok: true, value: stored.data as ArtifactT }
        : {
            ok: false,
            error: storedArtifactInvalid(artifactId, stored.error),
          };
    }
  }
  let file: FileHandle | undefined;
  let effect: ArtifactByteEffect = 'temp-write';
  try {
    await mkdir(ctx.bytesRoot, { recursive: true });
    const beforeWrite = injectedFailpoint(
      artifactId,
      'artifacts.put.before-temp-write',
    );
    if (beforeWrite) return { ok: false, error: beforeWrite };
    file = await open(tempPath, 'wx');
    await file.writeFile(parsed.data.bytes);
    const afterWrite = injectedFailpoint(
      artifactId,
      'artifacts.put.after-temp-write',
    );
    if (afterWrite) {
      await file.close();
      file = undefined;
      return { ok: false, error: afterWrite };
    }
    effect = 'temp-fsync';
    const beforeFsync = injectedFailpoint(
      artifactId,
      'artifacts.put.before-temp-fsync',
    );
    if (beforeFsync) {
      await file.close();
      file = undefined;
      return { ok: false, error: beforeFsync };
    }
    await file.sync();
    const afterFsync = injectedFailpoint(
      artifactId,
      'artifacts.put.after-temp-fsync',
    );
    if (afterFsync) {
      await file.close();
      file = undefined;
      return { ok: false, error: afterFsync };
    }
    await file.close();
    file = undefined;
    effect = 'rename';
    const beforeRename = injectedFailpoint(
      artifactId,
      'artifacts.put.before-rename',
    );
    if (beforeRename) return { ok: false, error: beforeRename };
    await rename(tempPath, finalPath);
    const afterRename = injectedFailpoint(
      artifactId,
      'artifacts.put.after-rename',
    );
    if (afterRename) return { ok: false, error: afterRename };
  } catch (cause) {
    if (file) {
      try {
        await file.close();
      } catch {
        // The originating byte effect remains the contract-visible failure.
      }
    }
    return { ok: false, error: byteEffectFailed(artifactId, effect, cause) };
  }

  const record = Artifact.parse({
    kind: 'artifact',
    id: artifactId,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: parsed.data.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation',
    ...(parsed.data.sourceAttribution === undefined
      ? {}
      : { sourceAttribution: parsed.data.sourceAttribution }),
    mimeType: parsed.data.mimeType,
    byteSize: parsed.data.bytes.byteLength,
    ...(parsed.data.originPath === undefined
      ? {}
      : { originPath: parsed.data.originPath }),
  }) as ArtifactT;
  const beforeRecordAppend = injectedFailpoint(
    artifactId,
    'artifacts.put.before-record-append',
  );
  if (beforeRecordAppend) {
    return { ok: false, error: beforeRecordAppend };
  }
  const created = await createObject<ArtifactT>(
    ctx.handle,
    record,
    clientOpId,
  );
  if (!created.ok) return created;
  const afterRecordAppend = injectedFailpoint(
    artifactId,
    'artifacts.put.after-record-append',
  );
  if (afterRecordAppend) {
    return { ok: false, error: afterRecordAppend };
  }
  const stored = Artifact.safeParse(created.value.object);
  return stored.success
    ? { ok: true, value: stored.data as ArtifactT }
    : {
        ok: false,
        error: storedArtifactInvalid(artifactId, stored.error),
      };
}

export async function getArtifactMeta(
  ctx: ArtifactsContext,
  artifactId: ArtifactId,
): Promise<Result<ArtifactT | Absent, ArtifactsError>> {
  const found = await getObjectWithReadFailure<ArtifactT>(
    ctx.handle,
    'artifact',
    artifactId as unknown as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) {
    return {
      ok: false,
      error: err(
        'NotFound',
        `no artifact with id "${artifactId}"`,
        { ref: { kind: 'artifact', id: artifactId } },
        false,
      ),
    };
  }
  const stored = Artifact.safeParse(found.value.object);
  return stored.success
    ? { ok: true, value: stored.data as ArtifactT }
    : {
        ok: false,
        error: storedArtifactInvalid(artifactId, stored.error),
      };
}

export async function listArtifacts(
  ctx: ArtifactsContext,
): Promise<Result<Page<ArtifactT>, ArtifactsError>> {
  const listed = await listObjects<ArtifactT>(ctx.handle, 'artifact');
  if (!listed.ok) return listed;
  const items: ArtifactT[] = [];
  for (const { object } of listed.value.items) {
    const stored = Artifact.safeParse(object);
    if (!stored.success) {
      const artifactId = (
        typeof object.id === 'string' ? object.id : 'artifact_unknown'
      ) as ArtifactId;
      return {
        ok: false,
        error: storedArtifactInvalid(artifactId, stored.error),
      };
    }
    items.push(stored.data as ArtifactT);
  }
  return {
    ok: true,
    value: {
      items,
      ...(listed.value.nextCursor === undefined
        ? {}
        : { nextCursor: listed.value.nextCursor }),
    },
  };
}

export async function getArtifactBytes(
  ctx: ArtifactsContext,
  artifactId: ArtifactId,
): Promise<Result<Uint8Array | Absent, ArtifactsError>> {
  const metadata = await getArtifactMeta(ctx, artifactId);
  if (!metadata.ok) return metadata;
  if (isAbsent(metadata.value)) {
    return { ok: true, value: metadata.value };
  }
  try {
    return {
      ok: true,
      value: await readFile(path.join(ctx.bytesRoot, artifactId)),
    };
  } catch (cause) {
    return {
      ok: false,
      error: err(
        'ArtifactBytesReadFailed',
        `artifact bytes could not be read: ${String(cause)}`,
        { artifactId, cause: String(cause) },
        false,
      ),
    };
  }
}

function orphanEntry(
  name: string,
): { artifactId: ArtifactId; entryType: OrphanEntryType } | null {
  const temp = /^\.(artifact_[^.]+)\.[^.]+\.tmp$/.exec(name);
  if (temp) {
    return {
      artifactId: temp[1] as ArtifactId,
      entryType: 'temp',
    };
  }
  if (/^artifact_[A-Za-z0-9-]+$/.test(name)) {
    return {
      artifactId: name as ArtifactId,
      entryType: 'final',
    };
  }
  return null;
}

export async function sweepOrphans(
  ctx: ArtifactsContext,
): Promise<Result<OrphanSweepResult, ArtifactsError>> {
  const listed = await listArtifacts(ctx);
  if (!listed.ok) return listed;
  const recordedIds = new Set(listed.value.items.map((item) => item.id));
  let names: string[];
  try {
    names = (await readdir(ctx.bytesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: { swept: [] } };
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

  const swept: OrphanSweepResult['swept'] = [];
  for (const name of names) {
    const orphan = orphanEntry(name);
    if (!orphan) continue;
    if (
      orphan.entryType === 'final'
      && recordedIds.has(orphan.artifactId)
    ) {
      continue;
    }
    const traced = await recordSystemAction(ctx.handle, {
      action: 'artifact.orphan.sweep',
      target: { kind: 'artifact', id: orphan.artifactId },
      clientOpId: mintClientOpId(),
      meta: { entryType: orphan.entryType },
    });
    if (!traced.ok) return traced;
    try {
      await unlink(path.join(ctx.bytesRoot, name));
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
    swept.push(orphan);
  }
  return { ok: true, value: { swept } };
}
