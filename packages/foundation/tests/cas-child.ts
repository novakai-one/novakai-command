// Two-process CAS test helper (S1): a child "process" that signals readiness,
// waits for the parent's go-barrier, then performs ONE updateObject at a fixed
// expectedVersion and prints the Result as a single JSON line on stdout.
// With the CAS check outside the mutation lock, two synchronized children both
// read v1 and both append v2 (no conflict). With the check inside the lock,
// exactly one wins; the loser gets a typed CasConflict.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  composeHandle, updateObject, type ClientOpId, type ObjectId,
} from '../contract/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout waiting for ${file}`);
    await sleep(5);
  }
}

async function main(): Promise<void> {
  const [root, id, expectedVersion, clientOpId] = process.argv.slice(2);
  writeFileSync(path.join(root, `ready_${clientOpId}`), String(process.pid));
  await waitFor(path.join(root, 'go'), 10_000);
  // drain any prior stdout ordering concerns: read the barrier once more
  readFileSync(path.join(root, 'go'));
  const handle = composeHandle({
    root, capability: 'shell', allowedKinds: ['settings', 'layout'], principal: 'person_race',
  });
  const res = await updateObject(
    handle, id as ObjectId, { value: Number(process.pid) },
    Number(expectedVersion), clientOpId as ClientOpId,
  );
  process.stdout.write(JSON.stringify(res.ok ? { ok: true, version: res.value.version } : { ok: false, code: res.error.code }) + '\n');
}

void main();
