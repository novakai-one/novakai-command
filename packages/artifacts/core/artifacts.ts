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
  ArtifactsError,
  StoredArtifactInvalidError,
} from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';
import {
  artifactBytesExist,
  artifactIdFor,
  persistArtifactBytes,
  readArtifactBytes,
} from './byte-storage.js';
import { injectedFailpoint } from './failpoints.js';

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

async function replayArtifact(
  ctx: ArtifactsContext,
  artifactId: ArtifactId,
  clientOpId: ClientOpId,
): Promise<Result<ArtifactT | null, ArtifactsError>> {
  const replay = await getObjectByClientOpId<ArtifactT>(
    ctx.handle,
    'artifact',
    clientOpId,
  );
  if (!replay.ok) return replay;
  if (!replay.value) return { ok: true, value: null };
  const stored = Artifact.safeParse(replay.value.object);
  return stored.success
    ? { ok: true, value: stored.data as ArtifactT }
    : {
        ok: false,
        error: storedArtifactInvalid(artifactId, stored.error),
      };
}

function artifactRecord(
  artifactId: ArtifactId,
  input: PutArtifactInputT,
): ArtifactT {
  return Artifact.parse({
    kind: 'artifact',
    id: artifactId,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: input.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation',
    ...(input.sourceAttribution === undefined
      ? {}
      : { sourceAttribution: input.sourceAttribution }),
    mimeType: input.mimeType,
    byteSize: input.bytes.byteLength,
    ...(input.originPath === undefined
      ? {}
      : { originPath: input.originPath }),
  }) as ArtifactT;
}

async function appendArtifactRecord(
  ctx: ArtifactsContext,
  record: ArtifactT,
  clientOpId: ClientOpId,
): Promise<Result<ArtifactT, ArtifactsError>> {
  const artifactId = record.id;
  const before = injectedFailpoint(
    artifactId,
    'artifacts.put.before-record-append',
  );
  if (before) return { ok: false, error: before };
  const created = await createObject<ArtifactT>(
    ctx.handle,
    record,
    clientOpId,
  );
  if (!created.ok) return created;
  const after = injectedFailpoint(
    artifactId,
    'artifacts.put.after-record-append',
  );
  if (after) return { ok: false, error: after };
  const stored = Artifact.safeParse(created.value.object);
  return stored.success
    ? { ok: true, value: stored.data as ArtifactT }
    : {
        ok: false,
        error: storedArtifactInvalid(artifactId, stored.error),
      };
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
  if (artifactBytesExist(ctx.bytesRoot, artifactId)) {
    const replay = await replayArtifact(ctx, artifactId, clientOpId);
    if (!replay.ok) return replay;
    if (replay.value) return { ok: true, value: replay.value };
  }
  const persisted = await persistArtifactBytes(
    ctx.bytesRoot,
    artifactId,
    parsed.data.bytes,
  );
  if (!persisted.ok) return persisted;
  return appendArtifactRecord(
    ctx,
    artifactRecord(artifactId, parsed.data),
    clientOpId,
  );
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
    return { ok: true, value: found.value };
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
  return readArtifactBytes(ctx.bytesRoot, artifactId);
}
