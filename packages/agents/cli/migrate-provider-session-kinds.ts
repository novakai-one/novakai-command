// packages/agents/cli/migrate-provider-session-kinds.ts — SUPFIX-05.
//
// One-off, idempotent: any record stored under kind `providerSession` that is
// NOT a registry record is classified:
//
//   - parses as a B3 handle (POSITIVE validation, never "failed the other
//     parse") → re-created under its own kind `providerSessionHandle`, then
//     the original is quarantined (foundation tombstone — listObjects stops
//     returning it; the journal line itself is never rewritten);
//   - matches NEITHER shape → quarantined only, loudly reported, never moved.
//
// Runs through the foundation store handle (takes the store mutation lock).
// Run with the server STOPPED. Interrupted? Just re-run: every step is
// guarded by a read, so the second pass reports zero moved.
//
//   npx tsx cli/migrate-provider-session-kinds.ts --root /path/to/.novakai
//
import path from 'node:path';
import {
  composeHandle, createObject, getObject, listObjects, requestQuarantine,
} from '@novakai/foundation/dist/contract/index.js';
import type { ClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { parseProviderSessionRecord } from '../core/sessions/record-shape.js';

const argOf = (flag: string, fallback: string): string => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};

const root = path.resolve(argOf('--root', path.join(process.cwd(), '.novakai')));
const principal = argOf('--principal', 'person_chris');
const mintOpId = (): ClientOpId => `op_${globalThis.crypto.randomUUID()}` as ClientOpId;

/** POSITIVE B3 handle validation — a record moves only because it IS a B3
 *  handle, never merely because it failed the registry parse. */
function isB3HandleRecord(raw: Record<string, unknown>): boolean {
  if (typeof raw.agentId !== 'string') return false;
  if (typeof raw.provider !== 'string') return false;
  if (!('providerConversationId' in raw)
    || (raw.providerConversationId !== null && typeof raw.providerConversationId !== 'string')) return false;
  if (!('providerResumeHandle' in raw)
    || (raw.providerResumeHandle !== null && typeof raw.providerResumeHandle !== 'string')) return false;
  const discovery = raw.discovery as { state?: unknown } | undefined;
  if (discovery !== undefined
    && discovery?.state !== 'discovered'
    && discovery?.state !== 'failed-before-discovery') return false;
  return true;
}

const handle = composeHandle({
  root,
  dataRoot: path.join(root, 'stores'),
  capability: 'agents',
  allowedKinds: ['providerSession', 'providerSessionHandle'],
  principal,
});

const listed = await listObjects<Record<string, unknown>>(
  handle, 'providerSession', undefined, { limit: 10_000 },
);
if (!listed.ok) {
  console.error(`cannot list providerSession records: ${listed.error.code} ${listed.error.message}`);
  process.exit(1);
}

let untouched = 0;
let moved = 0;
let alreadyMoved = 0;
let quarantinedOnly = 0;
const failures: string[] = [];

for (const item of listed.value.items) {
  const object = item.object as Record<string, unknown>;
  const id = String(object.id ?? object.sessionId ?? '<no id>');
  if (parseProviderSessionRecord(object).ok) {
    untouched += 1;
    continue;
  }

  if (isB3HandleRecord(object)) {
    const existing = await getObject<Record<string, unknown>>(handle, 'providerSessionHandle', id as never);
    const alreadyThere = existing.ok && !isAbsent(existing.value);
    if (!alreadyThere) {
      const created = await createObject<Record<string, unknown>>(handle, {
        kind: 'providerSessionHandle' as const,
        id,
        schemaVersion: 1,
        createdAt: typeof object.createdAt === 'string' ? object.createdAt : new Date().toISOString(),
        permissionLevel: 'private' as const,
        createdBy: 'overridden-by-foundation',
        agentId: object.agentId,
        provider: object.provider,
        providerConversationId: object.providerConversationId ?? null,
        providerResumeHandle: object.providerResumeHandle ?? null,
        ...(typeof object.providerVersion === 'string' ? { providerVersion: object.providerVersion } : {}),
        discovery: object.discovery ?? { state: 'discovered' },
      }, mintOpId());
      if (!created.ok) {
        failures.push(`create providerSessionHandle "${id}": ${created.error.code} ${created.error.message}`);
        continue; // original NOT quarantined — nothing is lost, re-run resumes here
      }
    }
    const tombstoned = await requestQuarantine(handle, {
      target: { kind: 'providerSession', id } as never,
      clientOpId: mintOpId(),
    });
    if (!tombstoned.ok) {
      failures.push(`quarantine providerSession "${id}": ${tombstoned.error.code} ${tombstoned.error.message}`);
      continue;
    }
    if (alreadyThere) alreadyMoved += 1; else moved += 1;
    console.log(`moved "${id}" → providerSessionHandle (original quarantined)`);
    continue;
  }

  const tombstoned = await requestQuarantine(handle, {
    target: { kind: 'providerSession', id } as never,
    clientOpId: mintOpId(),
  });
  if (!tombstoned.ok) {
    failures.push(`quarantine neither-shape "${id}": ${tombstoned.error.code} ${tombstoned.error.message}`);
    continue;
  }
  quarantinedOnly += 1;
  console.log(`QUARANTINED "${id}" — matches neither the registry nor the B3 handle shape; left in the journal, excluded from reads`);
}

console.log(`done: ${untouched} registry record(s) untouched, ${moved} moved, ${alreadyMoved} finished from an interrupted run, ${quarantinedOnly} neither-shape quarantined`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAILED: ${failure}`);
  process.exit(1);
}
