// What a mirrored transcript line SAYS about itself — §8.2, §25-B3c.
//
// Exam row C3: "the turn is mirrored into
// `.novakai/stores/transcriptLines.jsonl` with a typed human/assistant role" —
// `{"mirrored":[]}`. The mirror commits the Message and writes the ledger
// entry, and the entry records where the line came from, what happened to it,
// and which Message it became. It does not record WHOSE turn it was.
//
// `classifyTurn` decides that — `human` or `assistant` — and hands it to
// `NormalisedTranscriptTurn`, which Messaging gets. The durable transcript line
// dropped it. So §25-B3c's signal/noise projection is readable from the
// Messages and not from the transcript, and a line whose Message was later
// quarantined cannot say what it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { b3ok, type SystemCommandContext } from '@novakai/foundation/contract';

import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import type { MessagingMirrorPort, MirrorLedgerEntry } from '../core/mirror.js';
import type {
  SourceLine, SourcePrefixOutcome, SourceReadOutcome, TranscriptSourcePort,
} from '../contract/api.js';
import type { AgentId, AgentRunId, ProviderSessionId } from '../contract/records.js';

const AGENT = 'agent_aaaaaaaa-0000-4000-8000-000000000009' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-000000000009' as AgentRunId;
const SESSION = 'sess_11111111-0000-4000-8000-000000000009' as ProviderSessionId;
const THREAD = 'thread_ledger-role';

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000009' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000009' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000000a' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000000a' as never,
  contractVersion: 1,
});

const LINES: readonly SourceLine[] = [
  { position: '0000000000', role: 'user', text: 'what changed?', digest: 'd0' },
  { position: '0000000001', role: 'assistant', text: 'the ladder did', digest: 'd1' },
  { position: '0000000002', role: 'tool_result', text: 'exit 0', digest: 'd2' },
];

const SOURCE: TranscriptSourcePort = {
  async read(): Promise<SourceReadOutcome> {
    return { kind: 'lines', more: false, lines: LINES };
  },
  async readPrefixDigests(_binding, throughPosition): Promise<SourcePrefixOutcome> {
    return {
      kind: 'digests',
      digests: LINES
        .filter((line) => line.position <= throughPosition)
        .map((line) => ({ position: line.position, digest: line.digest })),
    };
  },
};

const MESSAGING: MessagingMirrorPort = {
  async commitTerminalOriginatedMessage(input) {
    return b3ok({ messageId: `message_${input.turn.sourcePosition}`, duplicate: false });
  },
  async currentEndpointClaimId() { return null; },
};

test('a mirrored transcript line names the role of the turn it mirrored', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-ledger-role-'));
  try {
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const api = composeB3Transcript({ store, source: SOURCE, messaging: MESSAGING });
    const bound = await api.bindTranscriptToRun(runtimeCtx(), {
      agentId: AGENT, agentRunId: RUN, provider: 'claude',
      providerSessionId: SESSION, threadId: THREAD,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;

    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bound.value.id, maxLines: 50,
    });
    assert.equal(ingested.ok, true,
      ingested.ok ? '' : `${ingested.error.code}: ${ingested.error.message}`);
    if (!ingested.ok) return;
    assert.equal(ingested.value.mirrored, 2);
    assert.equal(ingested.value.filtered, 1);

    const listed = await store.list<MirrorLedgerEntry>('transcriptLine');
    assert.equal(listed.ok, true);
    if (!listed.ok) return;

    const mirrored = listed.value.filter((entry) => entry.outcome === 'mirrored');
    assert.equal(mirrored.length, 2);
    const roles = mirrored
      .map((entry) => ({ at: entry.sourcePosition, role: entry.role }))
      .sort((left, right) => left.at.localeCompare(right.at));
    assert.deepEqual(roles, [
      { at: '0000000000', role: 'human' },
      { at: '0000000001', role: 'assistant' },
    ], 'a mirrored transcript line does not say whose turn it was');

    // A filtered line has no conversation role — that IS why it was filtered —
    // and saying `human` for a tool result would be worse than saying nothing.
    const filtered = listed.value.filter((entry) => entry.outcome === 'filtered');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.role, undefined,
      'a filtered line was given a conversation role it does not have');
    assert.equal(filtered[0]?.filterReason, 'non-conversation-role');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
