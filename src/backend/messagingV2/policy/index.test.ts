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
  [personIdForAgentId(badId), fakeSession(personIdForAgentId(badId), 'policy store on fire', written)],
  [personIdForAgentId(goodId), fakeSession(personIdForAgentId(goodId), null, written)],
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
  [personIdForAgentId(badId), {
    principal: { personId: personIdForAgentId(badId) },
    getPolicy: () => Promise.resolve({ kind: 'ok', value: { contact: { allowlist: [] }, 'dnd': {} } }),
    setContactPolicy: () => Promise.resolve({ kind: 'error', error: { name: 'NotAuthenticated', message: 'ended' } }),
  } as unknown as MessagingSession],
]);
const outcomeFailures = await bootstrap.sync(erroring, null);
assert.equal(outcomeFailures.length, 1, 'an error outcome is collected, not swallowed');

rmSync(scratch, { recursive: true, force: true });
console.log('contact bootstrap resilience tests passed');

// --- D-N8-2: externals are fleet co-members of EVERYONE -------------------------

{
  const n8Scratch = scratchStores();
  const n8Model = new ObjectModel({ storesDir: n8Scratch });
  const crewId = n8Model.createTeam({ name: 'Crew', missionId: 'mission_alpha' });
  const agentId = n8Model.createAgent({ name: 'worker-a', provider: 'claude', teamId: crewId, missionId: 'mission_alpha' });
  const partner = 'person_ext-partner-chris' as PersonId;
  const human = 'person_user-chris' as PersonId;

  const n8Written: PersonId[][] = [];
  const agentSession = fakeSession(personIdForAgentId(agentId), null, n8Written);
  const partnerSession = fakeSession(partner, null, n8Written);
  const humanSession = fakeSession(human, null, n8Written);
  const n8Bootstrap = createContactBootstrap(n8Model, () => [partner]);
  const n8Failures = await n8Bootstrap.sync(
    new Map<string, MessagingSession>([[personIdForAgentId(agentId), agentSession], [partner, partnerSession]]),
    humanSession,
  );
  assert.equal(n8Failures.length, 0, 'a clean sync with externals collects nothing');
  const agentList = n8Written[0] ?? [];
  assert.ok(agentList.includes(partner), "after external add + sync, the agent's allowlist includes the external");
  const partnerList = n8Written[1] ?? [];
  assert.ok(partnerList.includes(personIdForAgentId(agentId)), "the external's allowlist includes every agent");
  assert.ok(partnerList.includes(human), "the external's allowlist includes the human");
  const humanList = n8Written[2] ?? [];
  assert.ok(humanList.includes(partner), "the human's allowlist includes the external (D-N6-5 parity)");
  rmSync(n8Scratch, { recursive: true, force: true });
  console.log('D-N8-2 external co-membership tests passed');
}
