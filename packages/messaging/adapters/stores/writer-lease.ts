import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MessagingError } from '../../contract/types.js';
import { isErrno } from '../../core/thrown.js';
import { isRecord } from './foundation-operations.js';

interface LeaseRecord {
  readonly id: string;
  readonly kind: 'messagingWriterLease';
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly pid: number;
  readonly lane: string;
}

export interface MessagingWriterLease {
  release(): Promise<void>;
}

/** A process is alive unless the signal fails with ESRCH — anything else means it exists. */
const processAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return !isErrno(cause, 'ESRCH');
  }
};

/** A lease envelope carries our kind and schema — anything else is a foreign file. */
const isLeaseEnvelope = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value['kind'] === 'messagingWriterLease' && value['schemaVersion'] === 1;

/** The lease fields with their expected primitive types, or nothing when any is off. */
const leaseFields = (
  value: Record<string, unknown>,
): Pick<LeaseRecord, 'id' | 'pid' | 'createdAt' | 'lane'> | undefined => {
  const { id, pid, createdAt, lane } = value;
  if (typeof id !== 'string' || typeof createdAt !== 'string' || typeof lane !== 'string') {
    return undefined;
  }
  if (typeof pid !== 'number') return undefined;
  return { id, pid, createdAt, lane };
};

/** Parses a lease file; a malformed or foreign file is no lease at all. */
const parseLease = (value: unknown): LeaseRecord | undefined => {
  if (!isLeaseEnvelope(value)) return undefined;
  const fields = leaseFields(value);
  if (fields === undefined) return undefined;
  return { ...fields, kind: 'messagingWriterLease', schemaVersion: 1 };
};

async function existingLease(file: string): Promise<LeaseRecord | undefined> {
  try {
    return parseLease(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** The lease held by a live process, or by nobody once a stale file is removed. */
const leaseHolder = async (file: string, lane: string): Promise<void> => {
  const current = await existingLease(file);
  if (current !== undefined && processAlive(current.pid)) {
    throw new MessagingError('DependencyUnavailable', {
      message: `Messaging writer lane ${lane} is held by PID ${current.pid}`,
      retryable: true,
      fields: { dependency: 'writer-lease', lane, pid: current.pid },
    });
  }
  await unlink(file).catch(() => undefined);
};

/**
 * Holds one process-level writer lane for the lifetime of its store adapter.
 * Crash recovery: a lease whose process is dead (ESRCH) is stale and reclaimed
 * here on next open, so a crashed writer never blocks the lane forever.
 */
export async function acquireMessagingWriterLease(
  root: string,
  lane: string,
): Promise<MessagingWriterLease> {
  const directory = path.join(root, '.writer-leases');
  const file = path.join(directory, `${lane}.json`);
  await mkdir(directory, { recursive: true });
  const record: LeaseRecord = {
    id: `writerLease_${globalThis.crypto.randomUUID()}`,
    kind: 'messagingWriterLease', schemaVersion: 1,
    createdAt: new Date().toISOString(), pid: process.pid, lane,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = await tryAcquire(file, record, lane);
    if (lease !== undefined) return lease;
  }
  throw new MessagingError('DependencyUnavailable', {
    message: `Messaging writer lane ${lane} could not be acquired`,
    retryable: true,
    fields: { dependency: 'writer-lease', lane },
  });
}

/**
 * One acquisition attempt: create the lease file exclusively, or examine the
 * holder and steal the lane from a dead process. Any other failure propagates.
 */
async function tryAcquire(
  file: string,
  record: LeaseRecord,
  lane: string,
): Promise<MessagingWriterLease | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        const current = await existingLease(file);
        if (current?.id === record.id) await unlink(file).catch(() => undefined);
      },
    };
  } catch (cause) {
    if (!isErrno(cause, 'EEXIST')) throw cause;
    await leaseHolder(file, lane);
    return undefined;
  } finally {
    await handle?.close();
  }
}
