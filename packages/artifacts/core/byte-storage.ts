import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type {
  ArtifactByteEffect,
  ArtifactsError,
} from '../contract/errors.js';
import type { ArtifactFailpoint } from './failpoints.js';

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

async function closeAfterFailure(
  file: FileHandle,
  cause: unknown,
): Promise<string> {
  try {
    await file.close();
    return String(cause);
  } catch (closeCause) {
    return `${String(cause)}; close failed: ${String(closeCause)}`;
  }
}

async function writeTemp(
  tempPath: string,
  artifactId: ArtifactId,
  bytes: Uint8Array,
  failpoint: ArtifactFailpoint,
): Promise<Result<FileHandle, ArtifactsError>> {
  const before = failpoint(
    artifactId,
    'artifacts.put.before-temp-write',
  );
  if (before) return { ok: false, error: before };
  let file: FileHandle | undefined;
  try {
    file = await open(tempPath, 'wx');
    await file.writeFile(bytes);
    const after = failpoint(
      artifactId,
      'artifacts.put.after-temp-write',
    );
    if (!after) return { ok: true, value: file };
    const cause = await closeAfterFailure(file, after.message);
    return {
      ok: false,
      error: cause === after.message
        ? after
        : byteEffectFailed(artifactId, 'temp-write', cause),
    };
  } catch (cause) {
    const surfaced = file ? await closeAfterFailure(file, cause) : cause;
    return {
      ok: false,
      error: byteEffectFailed(artifactId, 'temp-write', surfaced),
    };
  }
}

async function fsyncTemp(
  file: FileHandle,
  artifactId: ArtifactId,
  failpoint: ArtifactFailpoint,
): Promise<Result<null, ArtifactsError>> {
  const before = failpoint(
    artifactId,
    'artifacts.put.before-temp-fsync',
  );
  if (before) {
    const cause = await closeAfterFailure(file, before.message);
    return {
      ok: false,
      error: cause === before.message
        ? before
        : byteEffectFailed(artifactId, 'temp-fsync', cause),
    };
  }
  try {
    await file.sync();
    const after = failpoint(
      artifactId,
      'artifacts.put.after-temp-fsync',
    );
    if (after) {
      const cause = await closeAfterFailure(file, after.message);
      return {
        ok: false,
        error: cause === after.message
          ? after
          : byteEffectFailed(artifactId, 'temp-fsync', cause),
      };
    }
    await file.close();
    return { ok: true, value: null };
  } catch (cause) {
    const surfaced = await closeAfterFailure(file, cause);
    return {
      ok: false,
      error: byteEffectFailed(artifactId, 'temp-fsync', surfaced),
    };
  }
}

async function renameTemp(
  tempPath: string,
  finalPath: string,
  artifactId: ArtifactId,
  failpoint: ArtifactFailpoint,
): Promise<Result<null, ArtifactsError>> {
  const before = failpoint(
    artifactId,
    'artifacts.put.before-rename',
  );
  if (before) return { ok: false, error: before };
  try {
    await rename(tempPath, finalPath);
  } catch (cause) {
    return {
      ok: false,
      error: byteEffectFailed(artifactId, 'rename', cause),
    };
  }
  const after = failpoint(
    artifactId,
    'artifacts.put.after-rename',
  );
  return after
    ? { ok: false, error: after }
    : { ok: true, value: null };
}

export function artifactIdFor(clientOpId: ClientOpId): ArtifactId {
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

export function artifactBytesExist(
  bytesRoot: string,
  artifactId: ArtifactId,
): boolean {
  return existsSync(path.join(bytesRoot, artifactId));
}

export async function prepareArtifactBytesRoot(
  bytesRoot: string,
  artifactId: ArtifactId,
): Promise<Result<null, ArtifactsError>> {
  try {
    await mkdir(bytesRoot, { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: byteEffectFailed(artifactId, 'temp-write', cause),
    };
  }
  return { ok: true, value: null };
}

export async function persistArtifactBytes(
  bytesRoot: string,
  artifactId: ArtifactId,
  bytes: Uint8Array,
  failpoint: ArtifactFailpoint,
): Promise<Result<null, ArtifactsError>> {
  const prepared = await prepareArtifactBytesRoot(bytesRoot, artifactId);
  if (!prepared.ok) return prepared;
  const tempPath = path.join(
    bytesRoot,
    `.${artifactId}.${randomUUID()}.tmp`,
  );
  const written = await writeTemp(tempPath, artifactId, bytes, failpoint);
  if (!written.ok) return written;
  const synced = await fsyncTemp(written.value, artifactId, failpoint);
  if (!synced.ok) return synced;
  return renameTemp(
    tempPath,
    path.join(bytesRoot, artifactId),
    artifactId,
    failpoint,
  );
}

export async function readArtifactBytes(
  bytesRoot: string,
  artifactId: ArtifactId,
): Promise<Result<Uint8Array, ArtifactsError>> {
  try {
    return {
      ok: true,
      value: await readFile(path.join(bytesRoot, artifactId)),
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        error: err(
          'ArtifactBytesMissing',
          `metadata exists but bytes are absent for "${artifactId}"`,
          { ref: { kind: 'artifact', id: artifactId } },
          false,
        ),
      };
    }
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
