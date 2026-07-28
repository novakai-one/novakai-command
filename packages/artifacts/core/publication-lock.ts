import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { ArtifactsError } from '../contract/errors.js';

export interface ArtifactPublicationLease {
  readonly artifactId: ArtifactId;
  readonly lockDir: string;
  readonly locksRoot: string;
  readonly token: string;
}

function publicationLockFailed(
  artifactId: ArtifactId,
  phase: 'acquire' | 'release',
  cause: unknown,
): ArtifactsError {
  return err(
    'ArtifactPublicationLockFailed',
    `artifact publication lock ${phase} failed: ${String(cause)}`,
    { artifactId, phase, cause: String(cause) },
    true,
  );
}

function publicationBusy(
  artifactId: ArtifactId,
  waitedMs: number,
  timeoutMs: number,
): ArtifactsError {
  return err(
    'ArtifactPublicationBusy',
    `artifact publication remained busy after ${waitedMs}ms`,
    { artifactId, waitedMs, timeoutMs },
    true,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireArtifactPublication(
  bytesRoot: string,
  artifactId: ArtifactId,
  timeoutMs: number,
): Promise<Result<ArtifactPublicationLease, ArtifactsError>> {
  const locksRoot = path.join(bytesRoot, '.publication-locks');
  const lockDir = path.join(locksRoot, `${artifactId}.lock`);
  try {
    await mkdir(locksRoot, { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: publicationLockFailed(artifactId, 'acquire', cause),
    };
  }
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      const token = randomUUID();
      try {
        await writeFile(
          path.join(lockDir, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          { flag: 'wx' },
        );
      } catch (cause) {
        await rm(lockDir, { recursive: true, force: true });
        return {
          ok: false,
          error: publicationLockFailed(artifactId, 'acquire', cause),
        };
      }
      return {
        ok: true,
        value: { artifactId, lockDir, locksRoot, token },
      };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        try {
          await mkdir(locksRoot, { recursive: true });
          continue;
        } catch (recreateCause) {
          return {
            ok: false,
            error: publicationLockFailed(
              artifactId,
              'acquire',
              recreateCause,
            ),
          };
        }
      }
      if (code !== 'EEXIST') {
        return {
          ok: false,
          error: publicationLockFailed(artifactId, 'acquire', cause),
        };
      }
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      return {
        ok: false,
        error: publicationBusy(artifactId, waitedMs, timeoutMs),
      };
    }
    await delay(Math.min(10, timeoutMs - waitedMs));
  }
}

export async function releaseArtifactPublication(
  lease: ArtifactPublicationLease,
): Promise<Result<null, ArtifactsError>> {
  try {
    const owner = JSON.parse(
      await readFile(path.join(lease.lockDir, 'owner.json'), 'utf8'),
    ) as { token?: string };
    if (owner.token !== lease.token) {
      return {
        ok: false,
        error: publicationLockFailed(
          lease.artifactId,
          'release',
          'publication lock owner changed',
        ),
      };
    }
    await rm(lease.lockDir, { recursive: true, force: true });
    try {
      await rmdir(lease.locksRoot);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw cause;
    }
    return { ok: true, value: null };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      error: publicationLockFailed(lease.artifactId, 'release', cause),
    };
  }
}
