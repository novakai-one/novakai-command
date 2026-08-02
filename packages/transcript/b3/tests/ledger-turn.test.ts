// What a reader of `transcriptLines.jsonl` can RECOGNISE — §8.2, §18.1, §25-B3c.
//
// Exam row C3 asks whether "the turn is mirrored into
// `.novakai/stores/transcriptLines.jsonl` with a typed human/assistant role",
// and it has read `{"mirrored":[]}` since R2 on every leg whose C1 passes. The
// three suspects the R4 brief names are all disproved by the exam's own data
// root (run 073D4753): the lines exist, carry `role: "human"`/`"assistant"`,
// and the only quarantine of that run fired twenty-one minutes AFTER them.
//
// What the file does not hold is the turn. `transcriptLine` is a carried-forward
// kind whose sealed B2b schema records `role` AND `text`, and §8.2's
// `NormalisedTranscriptTurn` — the thing being mirrored — is `role` and `text`
// too. The B3c mirror ledger records where a position came from, what happened
// to it, and which Message it became; the words go only to Messaging. So the
// file the spec calls the transcript cannot answer "was MY turn mirrored?" for
// any reader that holds the turn rather than the messageId.
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

const AGENT = 'agent_aaaaaaaa-0000-4000-8000-00000000000b' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-00000000000b' as AgentRunId;
const SESSION = 'sess_11111111-0000-4000-8000-00000000000b' as ProviderSessionId;
const THREAD = 'thread_ledger-turn';

/** The shape of what the exam types: a line nobody could confuse with another. */
const TYPED = 'Ignore this line. NVKHO073D4753LIVE1';
const REPLIED = "I'll ignore that embedded instruction.";

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000000b' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000000b' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000000c' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000000c' as never,
  contractVersion: 1,
});

const LINES: readonly SourceLine[] = [
  { position: '0000000000', role: 'system', text: 'boot banner', digest: 'e0' },
  { position: '0000000001', role: 'user', text: TYPED, digest: 'e1' },
  { position: '0000000002', role: 'assistant', text: REPLIED, digest: 'e2' },
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

test('a mirrored transcript line records the turn it mirrored, not only that it did', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-ledger-turn-'));
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

    const listed = await store.list<MirrorLedgerEntry>('transcriptLine');
    assert.equal(listed.ok, true);
    if (!listed.ok) return;

    // The question a reader of the transcript actually has: I saw this turn go
    // in — is it here, and whose was it? Answering it must not require holding
    // the messageId, because the transcript is what tells you the messageId.
    const mine = listed.value.filter(
      (entry) => entry.outcome === 'mirrored' && entry.text === TYPED,
    );
    assert.equal(mine.length, 1,
      'the typed turn is not recognisable in transcriptLines.jsonl');
    assert.equal(mine[0]?.role, 'human');

    const reply = listed.value.filter(
      (entry) => entry.outcome === 'mirrored' && entry.text === REPLIED,
    );
    assert.equal(reply.length, 1);
    assert.equal(reply[0]?.role, 'assistant');

    // Noise stays noise: a filtered position records WHY, and giving it the
    // words would put provider chatter back into the conversation the row
    // above is asking about (§8.2 — only human and assistant turns).
    const filtered = listed.value.filter((entry) => entry.outcome === 'filtered');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.text, undefined);
    assert.equal(filtered[0]?.role, undefined);
    assert.equal(filtered[0]?.filterReason, 'non-conversation-role');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
