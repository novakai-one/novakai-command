// B3c identity kernel (B3V4-P2 §4.1–4.2).
//
// Every B3c identity is DETERMINISTIC, and that is load-bearing rather than
// stylistic: each one names a fact a crash-and-retry has to land on again. A
// random id would make the retry a second endpoint claim, a second inbox item,
// a second binding — the duplicate-acceptance failure §13.6 and §13.9 forbid.
//
// Red gate 3's rule applies here too: a well-formed body under the wrong
// prefix is refused, not shrugged at.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidId,
  mintAgentEndpointClaimId, mintAgentInboxItemId, mintMessagingStoreOpId,
  mintObservedSubagentId, mintStoreRouteCutoverId, mintTranscriptBindingId,
  type IdFormat,
} from '../contract/index.js';

const IDENTITIES: ReadonlyArray<{
  readonly name: string;
  readonly mint: () => string;
  readonly prefix: string;
  readonly format: IdFormat;
}> = [
  {
    name: 'AgentEndpointClaimId',
    mint: () => mintAgentEndpointClaimId('agent_a', 3),
    prefix: 'agentEndpoint', format: 'base32sha256',
  },
  {
    name: 'AgentInboxItemId',
    mint: () => mintAgentInboxItemId('agent_a', 'msg_1'),
    prefix: 'agentInbox', format: 'base32sha256',
  },
  {
    name: 'MessagingStoreOpId',
    mint: () => mintMessagingStoreOpId('acceptance:msg_1'),
    prefix: 'messagingStoreOp', format: 'base32sha256',
  },
  {
    name: 'TranscriptBindingId',
    mint: () => mintTranscriptBindingId('agentRun_a', 'claude', 'sess_1'),
    prefix: 'transcriptBinding', format: 'base32sha256',
  },
  {
    name: 'ObservedSubagentId',
    mint: () => mintObservedSubagentId('transcriptBinding_a', 'native-7'),
    prefix: 'observedSubagent', format: 'base32sha256',
  },
  {
    name: 'StoreRouteCutoverId',
    mint: () => mintStoreRouteCutoverId('.novakai/stores'),
    prefix: 'storeRouteCutover', format: 'base32sha256',
  },
];

test('every minted B3c identity validates under its own prefix and format', () => {
  for (const identity of IDENTITIES) {
    const minted = identity.mint();
    assert.equal(isValidId(minted, identity.prefix, identity.format), true,
      `${identity.name} minted ${minted}, which its own validator rejects`);
  }
});

test('no B3c identity validates as any OTHER B3c identity', () => {
  for (const identity of IDENTITIES) {
    const minted = identity.mint();
    for (const other of IDENTITIES) {
      if (other.prefix === identity.prefix) continue;
      assert.equal(isValidId(minted, other.prefix, other.format), false,
        `a ${identity.name} was accepted as a ${other.name}`);
    }
  }
});

test('B3c identities are deterministic: the same fact mints the same id', () => {
  assert.equal(mintAgentEndpointClaimId('agent_a', 3), mintAgentEndpointClaimId('agent_a', 3));
  assert.equal(mintAgentInboxItemId('agent_a', 'msg_1'), mintAgentInboxItemId('agent_a', 'msg_1'));
  assert.equal(
    mintTranscriptBindingId('agentRun_a', 'claude', 'sess_1'),
    mintTranscriptBindingId('agentRun_a', 'claude', 'sess_1'),
  );
});

test('a different fact mints a different id — including one field apart', () => {
  // The generation is what separates the old endpoint claim from the new one
  // during a continuation (§13.6). If it did not change the id, the transfer
  // would overwrite the record it is supposed to hand over FROM.
  assert.notEqual(mintAgentEndpointClaimId('agent_a', 3), mintAgentEndpointClaimId('agent_a', 4));
  assert.notEqual(mintAgentInboxItemId('agent_a', 'msg_1'), mintAgentInboxItemId('agent_b', 'msg_1'));
  assert.notEqual(
    mintTranscriptBindingId('agentRun_a', 'claude', 'sess_1'),
    mintTranscriptBindingId('agentRun_a', 'codex', 'sess_1'),
  );
  assert.notEqual(
    mintObservedSubagentId('transcriptBinding_a', 'native-7'),
    mintObservedSubagentId('transcriptBinding_a', 'native-8'),
  );
});

test('field boundaries are separated: no two field splits collide', () => {
  // §4.1 joins fields with U+001F precisely so that ("ab","c") and ("a","bc")
  // are different tuples. Naive concatenation makes them the same id, and two
  // different Agents would then share one endpoint claim.
  assert.notEqual(
    mintAgentInboxItemId('agent_ab', 'c'),
    mintAgentInboxItemId('agent_a', 'bc'),
  );
});
