// B3b identity kernel (B3V4-P2 §4.1–4.2).
//
// Red gate 3 says AgentId, AgentRunId, ProviderSessionId, TerminalSessionId,
// controller id and provider-native id are NOT interchangeable. That is only
// true if the validators say so — a well-formed body under the wrong prefix
// must be refused, not shrugged at.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicId, isValidId,
  mintAgentRelationshipId, mintAgentRunId, mintControlReplacementPlanId,
  mintDelegationGrantId, mintProviderSessionId, mintResolvedLaunchPlanId,
  mintAgentRoleProfileId, mintRunContinuationId, mintRunOperationId,
  mintSupervisionAssignmentId, mintTreeMutationFenceId,
  type IdFormat,
} from '../contract/index.js';

/** Every B3b identity: what mints it, its prefix, and its body format (§4.1). */
const IDENTITIES: ReadonlyArray<{
  readonly name: string;
  readonly mint: () => string;
  readonly prefix: string;
  readonly format: IdFormat;
}> = [
  { name: 'AgentRoleProfileId', mint: mintAgentRoleProfileId, prefix: 'agentRole', format: 'uuidv7' },
  { name: 'ResolvedLaunchPlanId', mint: mintResolvedLaunchPlanId, prefix: 'launchPlan', format: 'uuidv7' },
  { name: 'DelegationGrantId', mint: mintDelegationGrantId, prefix: 'delegationGrant', format: 'uuidv7' },
  { name: 'ControlReplacementPlanId', mint: mintControlReplacementPlanId, prefix: 'controlReplacement', format: 'uuidv7' },
  { name: 'RunContinuationId', mint: mintRunContinuationId, prefix: 'runContinuation', format: 'uuidv7' },
  { name: 'SupervisionAssignmentId', mint: mintSupervisionAssignmentId, prefix: 'supervisionAssignment', format: 'uuidv7' },
  { name: 'TreeMutationFenceId', mint: mintTreeMutationFenceId, prefix: 'treeFence', format: 'uuidv7' },
  { name: 'AgentRunId', mint: mintAgentRunId, prefix: 'agentRun', format: 'uuidv7' },
  // §4.1 + AMD-001 §4: inherited Agents identities keep their existing UUIDv4.
  { name: 'ProviderSessionId', mint: mintProviderSessionId, prefix: 'sess', format: 'uuidv4' },
];

test('every minted B3b identity validates under its own prefix and format', () => {
  for (const identity of IDENTITIES) {
    const minted = identity.mint();
    assert.equal(isValidId(minted, identity.prefix, identity.format), true,
      `${identity.name} minted ${minted}, which its own validator rejects`);
  }
});

test('no B3b identity validates as any OTHER B3b identity', () => {
  for (const identity of IDENTITIES) {
    const minted = identity.mint();
    for (const other of IDENTITIES) {
      if (other.prefix === identity.prefix) continue;
      assert.equal(isValidId(minted, other.prefix, other.format), false,
        `a ${identity.name} was accepted as a ${other.name}`);
    }
  }
});

test('a body that is well-formed for the WRONG format is still refused', () => {
  // §4.1's "reject the wrong prefix even if the remaining string is otherwise
  // valid" has a twin: the right prefix with the wrong version. A v4 body under
  // a v7 identity is not a near-miss — it names a different minting authority.
  const v4Body = mintProviderSessionId().slice('sess_'.length);
  assert.equal(isValidId(`agentRole_${v4Body}`, 'agentRole', 'uuidv7'), false,
    'a UUIDv4 body was accepted as a UUIDv7 identity');
  const v7Body = mintAgentRunId().slice('agentRun_'.length);
  assert.equal(isValidId(`sess_${v7Body}`, 'sess', 'uuidv4'), false,
    'a UUIDv7 body was accepted as an inherited UUIDv4 identity');
});

test('a B3b id is refused under the B3a identities it must never substitute for', () => {
  const runId = mintAgentRunId();
  // The three §4.1 rows red gate 3 names explicitly.
  assert.equal(isValidId(runId, 'terminal', 'uuidv7'), false, 'a Run id passed as a terminal session id');
  assert.equal(isValidId(runId, 'sess', 'uuidv4'), false, 'a Run id passed as a ProviderSession id');
  assert.equal(isValidId(runId, 'controller', 'uuidv7'), false, 'a Run id passed as a controller id');
  assert.equal(isValidId(mintProviderSessionId(), 'agentRun', 'uuidv7'), false,
    'a ProviderSession id passed as a Run id');
});

test('deterministic identities are stable, tuple-sensitive and correctly prefixed', () => {
  const edge = mintAgentRelationshipId('agent_parent', 'agent_child');
  assert.equal(edge, mintAgentRelationshipId('agent_parent', 'agent_child'),
    'the same parent/child pair must produce the same edge id');
  assert.notEqual(edge, mintAgentRelationshipId('agent_child', 'agent_parent'),
    'direction must change the edge id — an edge is not symmetric');
  assert.equal(isValidId(edge, 'agentRelationship', 'base32sha256'), true);

  const operation = mintRunOperationId('receipt_abc');
  assert.equal(operation, mintRunOperationId('receipt_abc'));
  assert.notEqual(operation, mintRunOperationId('receipt_abd'));
  assert.equal(isValidId(operation, 'runOperation', 'base32sha256'), true);
});

test('a field carrying the tuple separator is refused, not hashed', () => {
  // §4.1 joins fields with U+001F. A field allowed to CONTAIN that byte makes
  // ["a<SEP>b","c"] and ["a","b","c"] the same tuple — one record able to claim
  // another record's deterministic identity. Every B3 field is a validated id
  // today, so no public door can reach it; it is refused at the source anyway,
  // because "unreachable right now" is not the same fact as "safe".
  const separator = String.fromCharCode(0x1f);
  assert.throws(
    () => deterministicId('agentRelationship', [`a${separator}b`, 'c']),
    /separator/,
    'a field containing the tuple separator was hashed instead of refused',
  );
  // The honest tuples on either side of it stay distinct.
  assert.notEqual(
    deterministicId('agentRelationship', ['ab', 'c']),
    deterministicId('agentRelationship', ['a', 'bc']),
  );
});
