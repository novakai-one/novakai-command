// A5-04: resolving a role NAME is the owner's query, not the caller's filter.
//
// Chris types "builder"; ids are for machines. Somebody has to turn the one
// into the other, and until this slice that somebody was the CLI: `roleIdFor`
// called `b3.agent.getRoles`, pulled the whole list across the wire and ran
// `filter(role => role.name === given && role.status === 'active')` in the
// client. Three things are wrong with that, and only the third is obvious:
//
//   1. the answer depends on WHICH client asked — the Shell, a script and the
//      CLI can each spell "matches" differently, and two of them will be wrong;
//   2. the client sees every role profile in the system in order to pick one,
//      which is a listing it was never entitled to for this question;
//   3. `status === 'active'` is the client's own policy. A5-04 says the match
//      runs over NON-ARCHIVED profiles, and whether a retired role may be
//      LAUNCHED from is the launch plan's judgement (`retiredRole` in
//      plans.ts), made once, where the rest of the launch policy lives.
//
// So the amendment's last line — "The query never chooses" — is the whole
// point: the owner answers exactly one question (which profile is named this)
// and refuses when the answer is not exactly one.
//
// NOTE on "non-archived": `AgentRoleProfile.status` is `'active' | 'retired'`
// (records.ts:141). There is no `archived` state on this record — that value
// belongs to `Agent` (records.ts:170). Applied literally, "non-archived"
// therefore excludes nothing, which is also the only reading that keeps the
// query out of the launch policy's job. Reported as a drafting residual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRig, roleInput } from './harness.js';
import type { AgentRoleProfileId } from '@novakai/foundation/contract';

async function withRig<T>(work: (rig: ReturnType<typeof createRig>) => Promise<T>): Promise<T> {
  const rig = createRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

type Rig = ReturnType<typeof createRig>;

/** Create one role profile and hand back its id. */
async function defineRole(
  rig: Rig, name: string, status: 'active' | 'retired' = 'active',
): Promise<AgentRoleProfileId> {
  const created = await rig.agents.createRoleProfile(rig.human(), roleInput({ name, status }));
  assert.equal(created.ok, true, `role "${name}" was not created`);
  if (!created.ok) throw new Error('unreachable');
  return created.value.id;
}

interface Issue { readonly path: string; readonly message: string }

const issuesOf = (error: { details: Readonly<Record<string, unknown>> }): readonly Issue[] =>
  (error.details['issues'] ?? []) as readonly Issue[];

/** A5-04's ambiguous form lists every candidate id; the paths say which are which. */
const candidatesIn = (error: { details: Readonly<Record<string, unknown>> }): readonly string[] =>
  issuesOf(error).filter((issue) => issue.path.startsWith('candidates'))
    .map((issue) => issue.message);

test('an exact name resolves to that profile', async () => {
  await withRig(async (rig) => {
    const builder = await defineRole(rig, 'builder');
    await defineRole(rig, 'auditor');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'builder');
    assert.equal(resolved.ok, true, 'an exact, unique name did not resolve');
    if (!resolved.ok) return;
    assert.equal(resolved.value.id, builder);
    assert.equal(resolved.value.name, 'builder');
  });
});

test('the match is case-sensitive: "Builder" is not "builder"', async () => {
  await withRig(async (rig) => {
    await defineRole(rig, 'builder');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'Builder');
    assert.equal(resolved.ok, false, 'a case-folded name was treated as a match');
    if (resolved.ok) return;
    assert.equal(resolved.error.code, 'ValidationFailed');
    assert.deepEqual(candidatesIn(resolved.error), []);
  });
});

test('the match is whole-string: a prefix names nothing', async () => {
  await withRig(async (rig) => {
    await defineRole(rig, 'builder');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'build');
    assert.equal(resolved.ok, false, 'a prefix was treated as a match');
    if (resolved.ok) return;
    assert.equal(resolved.error.code, 'ValidationFailed');
  });
});

test('no match is ValidationFailed, and it names the field that was wrong', async () => {
  await withRig(async (rig) => {
    await defineRole(rig, 'builder');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'nobody');
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error.code, 'ValidationFailed');
    assert.deepEqual(issuesOf(resolved.error).map((issue) => issue.path), ['displayName']);
  });
});

test('an ambiguous name is refused, and EVERY candidate id is named', async () => {
  // Two profiles, one name. The client-side filter this replaces would have
  // failed here too — but only because both were `active`. The next test is
  // the one it would have got wrong.
  await withRig(async (rig) => {
    const first = await defineRole(rig, 'builder');
    const second = await defineRole(rig, 'builder');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'builder');
    assert.equal(resolved.ok, false, 'an ambiguous name resolved to one profile');
    if (resolved.ok) return;
    assert.equal(resolved.error.code, 'ValidationFailed');
    // Every candidate, not "the first two" and not a count: an operator whose
    // only way forward is to name it by id must be handed the ids.
    assert.deepEqual([...candidatesIn(resolved.error)].sort(), [first, second].sort());
  });
});

test('a retired profile still resolves — a lookup is not a launch policy', async () => {
  // The behaviour the client-side filter got wrong. `status === 'active'` made
  // a retired role INVISIBLE, so `nvk agent spawn --role builder` answered "no
  // active role is named builder" — which is false; there is one, and it is
  // retired. The launch plan already refuses it BY NAME (`retiredRole`), which
  // is the answer that tells the operator what actually happened.
  await withRig(async (rig) => {
    const retired = await defineRole(rig, 'archivist', 'retired');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'archivist');
    assert.equal(resolved.ok, true, 'a retired profile was hidden from the lookup');
    if (!resolved.ok) return;
    assert.equal(resolved.value.id, retired);
    assert.equal(resolved.value.status, 'retired');
  });
});

test('a retired profile is a candidate for ambiguity too', async () => {
  // The direct consequence of the previous test, and the one observable that
  // separates the two readings of "non-archived": under the client's old
  // `active` filter this resolved happily to the live profile, choosing on the
  // operator's behalf between two roles they gave one name.
  await withRig(async (rig) => {
    const live = await defineRole(rig, 'builder');
    const retired = await defineRole(rig, 'builder', 'retired');
    const resolved = await rig.agents.resolveRoleProfileByName(rig.principal(), 'builder');
    assert.equal(resolved.ok, false, 'the query chose the live profile for the caller');
    if (resolved.ok) return;
    assert.deepEqual([...candidatesIn(resolved.error)].sort(), [live, retired].sort());
  });
});
