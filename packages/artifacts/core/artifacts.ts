import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  rename,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createObject,
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
    file = await open(tempPath, 'wx');
    await file.writeFile(parsed.data.bytes);
    effect = 'temp-fsync';
    await file.sync();
    await file.close();
    file = undefined;
    effect = 'rename';
    await rename(tempPath, finalPath);
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
