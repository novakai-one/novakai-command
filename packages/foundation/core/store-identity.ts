import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoreId, StoreIdentity } from '../contract/store-identity.js';

const STORE_ID = /^store_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const filename = 'store-identity.jsonl';

function parseIdentity(text: string, file: string): StoreIdentity {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim() !== '');
  if (line === undefined) throw new Error(`Foundation store identity is empty: ${file}`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error(`Foundation store identity is invalid JSON: ${file}`, { cause });
  }
  const record = value as Partial<StoreIdentity>;
  if (record.kind !== 'storeIdentity' || record.schemaVersion !== 1
    || typeof record.id !== 'string' || !STORE_ID.test(record.id)
    || typeof record.createdAt !== 'string') {
    throw new Error(`Foundation store identity has an invalid record: ${file}`);
  }
  return record as StoreIdentity;
}

async function readIdentity(file: string): Promise<StoreIdentity> {
  return parseIdentity(await readFile(file, 'utf8'), file);
}

/** Idempotently creates or reads the durable identity of one `.novakai` root. */
export async function ensureStoreIdentity(root: string): Promise<StoreIdentity> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, filename);
  try {
    return await readIdentity(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const identity: StoreIdentity = {
    id: `store_${globalThis.crypto.randomUUID()}` as StoreId,
    kind: 'storeIdentity',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8');
    await handle.sync();
    return identity;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return readIdentity(file);
    throw cause;
  } finally {
    await handle?.close();
  }
}
