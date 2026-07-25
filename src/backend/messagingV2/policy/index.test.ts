/**
 * Team contact bootstrap resilience tests (D-N2-5 hardening, audit #6): a
 * session whose policy write fails must NOT abort the sync — the failure is
 * collected and every other session's allowlist is still written. Run with
 * `npx tsx src/backend/messagingV2/policy/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { PersonId } from '../../../../packages/messaging/public/contract/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { createContactBootstrap } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-policy-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

/** A minimal fake session: records allowlists, or poisons the write. */
function fakeSession(personId: PersonId, poison: string | null, written: PersonId[][]): MessagingSession {
  return {
    principal: { personId },
    getPolicy: () => Promise.resolve({
      kind: 'ok',
      value: { contact: { allowlist: [] }, 'dnd': { enabled: false } },
    }),
    setContactPolicy: (input: unknown) => {
      if (poison !== null) return Promise.reject(new Error(poison));
      written.push((input as { allowlist: PersonId[] }).allowlist);
      return Promise.resolve({ kind: 'ok', value: { revision: 1 } });
    },
  } as unknown as MessagingSession;
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const goodId = model.createAgent({ name: 'worker-good', provider: 'claude', teamId, missionId: 'mission_alpha' });
const badId = model.createAgent({ name: 'worker-bad', provider: 'claude', teamId, missionId: 'mission_alpha' });

const written: PersonId[][] = [];
const sessions = new Map<string, MessagingSession>([
  [badId, fakeSession(personIdForAgentId(badId), 'policy store on fire', written)],
  [goodId, fakeSession(personIdForAgentId(goodId), null, written)],
]);

const bootstrap = createContactBootstrap(model);
const failures = await bootstrap.sync(sessions, null);

assert.equal(failures.length, 1, 'the poisoned session is collected as a failure, never thrown');
assert.match(failures[0]?.detail ?? '', /policy store on fire/);
assert.equal(failures[0]?.personId, personIdForAgentId(badId));
assert.equal(written.length, 1, 'the healthy session still got its allowlist written');
assert.ok(written[0]?.includes(personIdForAgentId(badId)), 'co-membership content is intact');

// An Outcome-error (not a throw) is a failure too — honesty both ways.
const erroring = new Map<string, MessagingSession>([
  [badId, {
    principal: { personId: personIdForAgentId(badId) },
    getPolicy: () => Promise.resolve({ kind: 'ok', value: { contact: { allowlist: [] }, 'dnd': {} } }),
    setContactPolicy: () => Promise.resolve({ kind: 'error', error: { name: 'NotAuthenticated', message: 'ended' } }),
  } as unknown as MessagingSession],
]);
const outcomeFailures = await bootstrap.sync(erroring, null);
assert.equal(outcomeFailures.length, 1, 'an error outcome is collected, not swallowed');

rmSync(scratch, { recursive: true, force: true });
console.log('contact bootstrap resilience tests passed');
