import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

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

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

async function existingLease(file: string): Promise<LeaseRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<LeaseRecord>;
    return value.kind === 'messagingWriterLease' && value.schemaVersion === 1
      && typeof value.id === 'string' && typeof value.pid === 'number'
      ? value as LeaseRecord : undefined;
  } catch { return undefined; }
}

/** Holds one process-level writer lane for the lifetime of its store adapter. */
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
    let handle;
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
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const current = await existingLease(file);
      if (current !== undefined && processAlive(current.pid)) {
        throw new Error(`Messaging writer lane ${lane} is held by PID ${current.pid}`);
      }
      await unlink(file).catch(() => undefined);
    } finally {
      await handle?.close();
    }
  }
  throw new Error(`Messaging writer lane ${lane} could not be acquired`);
}
