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
  PageOptions,
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
  ArtifactStoreReadFailedError,
  StoredArtifactInvalidError,
} from '../contract/errors.js';
import type { ArtifactsContext } from './composition.js';
import {
  artifactBytesExist,
  artifactIdFor,
  persistArtifactBytes,
  prepareArtifactBytesRoot,
  readArtifactBytes,
} from './byte-storage.js';
import {
  acquireArtifactPublication,
  releaseArtifactPublication,
} from './publication-lock.js';

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

function storeReadFailed(
  operation: 'get' | 'list',
  cause: unknown,
): ArtifactStoreReadFailedError {
  return err(
    'ArtifactStoreReadFailed',
    `artifact ${operation} storage read failed: ${String(cause)}`,
    { operation, cause: String(cause) },
    true,
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

function equivalentValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function differingInputFields(
  stored: ArtifactT | null,
  input: PutArtifactInputT,
  durableBytes: Uint8Array,
): string[] {
  const differing: string[] = [];
  if (!Buffer.from(durableBytes).equals(Buffer.from(input.bytes))) {
    differing.push('bytes');
  }
  if (!stored) return differing;
  if (stored.mimeType !== input.mimeType) differing.push('mimeType');
  if (stored.originPath !== input.originPath) differing.push('originPath');
  if (stored.permissionLevel !== (input.permissionLevel ?? 'private')) {
    differing.push('permissionLevel');
  }
  if (!equivalentValue(stored.sourceAttribution, input.sourceAttribution)) {
    differing.push('sourceAttribution');
  }
  return differing;
}

function idempotencyConflict(
  artifactId: ArtifactId,
  clientOpId: ClientOpId,
  differingFields: string[],
): ArtifactsError {
  return err(
    'ArtifactIdempotencyConflict',
    `clientOpId "${clientOpId}" was reused with different artifact input`,
    { artifactId, clientOpId, differingFields },
    false,
  );
}

async function appendArtifactRecord(
  ctx: ArtifactsContext,
  record: ArtifactT,
  clientOpId: ClientOpId,
): Promise<Result<ArtifactT, ArtifactsError>> {
  const artifactId = record.id;
  const before = ctx.failpoint(
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
  const after = ctx.failpoint(
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

async function publishArtifact(
  ctx: ArtifactsContext,
  input: PutArtifactInputT,
  artifactId: ArtifactId,
  clientOpId: ClientOpId,
): Promise<Result<ArtifactT, ArtifactsError>> {
  if (artifactBytesExist(ctx.bytesRoot, artifactId)) {
    const bytes = await readArtifactBytes(ctx.bytesRoot, artifactId);
    if (!bytes.ok) return bytes;
    const replay = await replayArtifact(ctx, artifactId, clientOpId);
    if (!replay.ok) return replay;
    const differing = differingInputFields(replay.value, input, bytes.value);
    if (differing.length > 0) {
      return {
        ok: false,
        error: idempotencyConflict(
          artifactId,
          clientOpId,
          differing,
        ),
      };
    }
    return appendArtifactRecord(
      ctx,
      artifactRecord(artifactId, input),
      clientOpId,
    );
  }
  const persisted = await persistArtifactBytes(
    ctx.bytesRoot,
    artifactId,
    input.bytes,
    ctx.failpoint,
  );
  if (!persisted.ok) return persisted;
  return appendArtifactRecord(
    ctx,
    artifactRecord(artifactId, input),
    clientOpId,
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
  const artifactId = artifactIdFor(clientOpId);
  const prepared = await prepareArtifactBytesRoot(
    ctx.bytesRoot,
    artifactId,
  );
  if (!prepared.ok) return prepared;
  const acquired = await acquireArtifactPublication(
    ctx.bytesRoot,
    artifactId,
    ctx.publicationLockTimeoutMs,
  );
  if (!acquired.ok) return acquired;
  try {
    const published = await publishArtifact(
      ctx,
      parsed.data,
      artifactId,
      clientOpId,
    );
    const released = await releaseArtifactPublication(acquired.value);
    return released.ok ? published : released;
  } catch (cause) {
    await releaseArtifactPublication(acquired.value);
    throw cause;
  }
}

export async function getArtifactMeta(
  ctx: ArtifactsContext,
  artifactId: ArtifactId,
): Promise<Result<ArtifactT | Absent, ArtifactsError>> {
  let found;
  try {
    found = await getObjectWithReadFailure<ArtifactT>(
      ctx.handle,
      'artifact',
      artifactId as unknown as ObjectId,
    );
  } catch (cause) {
    return { ok: false, error: storeReadFailed('get', cause) };
  }
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
  page?: PageOptions,
): Promise<Result<Page<ArtifactT>, ArtifactsError>> {
  let listed;
  try {
    listed = await listObjects<ArtifactT>(
      ctx.handle,
      'artifact',
      undefined,
      page,
    );
  } catch (cause) {
    return { ok: false, error: storeReadFailed('list', cause) };
  }
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

export async function listAllArtifacts(
  ctx: ArtifactsContext,
): Promise<Result<ArtifactT[], ArtifactsError>> {
  const items: ArtifactT[] = [];
  let cursor: string | undefined;
  do {
    const page = await listArtifacts(
      ctx,
      cursor === undefined ? undefined : { cursor },
    );
    if (!page.ok) return page;
    items.push(...page.value.items);
    cursor = page.value.nextCursor;
  } while (cursor !== undefined);
  return { ok: true, value: items };
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
