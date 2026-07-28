import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createObject,
  getObjectByClientOpId,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
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
  const replay = await getObjectByClientOpId<ArtifactT>(
    ctx.handle,
    'artifact',
    clientOpId,
  );
  if (!replay.ok) return replay;
  if (replay.value) {
    const stored = Artifact.safeParse(replay.value.object);
    const replayId = (
      typeof replay.value.object.id === 'string'
        ? replay.value.object.id
        : 'artifact_unknown'
    ) as ArtifactId;
    return stored.success
      ? { ok: true, value: stored.data as ArtifactT }
      : {
          ok: false,
          error: storedArtifactInvalid(replayId, stored.error),
        };
  }

  const artifactId = `artifact_${randomUUID()}` as ArtifactId;
  const tempPath = path.join(
    ctx.bytesRoot,
    `.${artifactId}.${randomUUID()}.tmp`,
  );
  const finalPath = path.join(ctx.bytesRoot, artifactId);
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
  const created = await createObject<ArtifactT>(
    ctx.handle,
    record,
    clientOpId,
  );
  if (!created.ok) return created;
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
