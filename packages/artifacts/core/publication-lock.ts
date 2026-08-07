import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  rmdir,
  stat,
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

interface PublicationOwner {
  pid: number;
  token: string;
}

const ABANDONED_ACQUIRE_MS = 30_000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPublicationOwner(
  lockDir: string,
): Promise<PublicationOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(lockDir, 'owner.json'), 'utf8'),
    ) as { pid?: unknown; token?: unknown };
    return Number.isInteger(parsed.pid) && typeof parsed.token === 'string'
      ? { pid: parsed.pid as number, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

async function reclaimAbandonedPublication(
  lockDir: string,
): Promise<boolean> {
  const firstOwner = await readPublicationOwner(lockDir);
  if (firstOwner) {
    if (isPidAlive(firstOwner.pid)) return false;
    const confirmed = await readPublicationOwner(lockDir);
    if (
      !confirmed
      || confirmed.token !== firstOwner.token
      || isPidAlive(confirmed.pid)
    ) {
      return false;
    }
    await rm(lockDir, { recursive: true, force: true });
    return true;
  }
  let firstStat;
  try {
    firstStat = await stat(lockDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw cause;
  }
  if (Date.now() - firstStat.mtimeMs < ABANDONED_ACQUIRE_MS) return false;
  if (await readPublicationOwner(lockDir)) return false;
  let confirmedStat;
  try {
    confirmedStat = await stat(lockDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw cause;
  }
  if (
    confirmedStat.ino !== firstStat.ino
    || confirmedStat.mtimeMs !== firstStat.mtimeMs
  ) {
    return false;
  }
  await rm(lockDir, { recursive: true, force: true });
  return true;
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
      try {
        if (await reclaimAbandonedPublication(lockDir)) continue;
      } catch (reclaimCause) {
        return {
          ok: false,
          error: publicationLockFailed(
            artifactId,
            'acquire',
            reclaimCause,
          ),
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
