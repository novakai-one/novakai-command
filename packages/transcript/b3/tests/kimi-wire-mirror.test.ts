/**
 * The kimi human turn, end to end — exam rows C1/C3-kimi.
 *
 * `three-provider-mirror.test.ts` proves kimi round-trips, against a fixture in
 * the `{"kind":"event","envelope":{…}}` shape. The kimi CLI on this machine
 * writes a different file, and it is the one the exam typed into:
 *
 *   ~/.kimi-code/sessions/wd_<workspace>/session_<native>/agents/main/wire.jsonl
 *   {"type":"turn.prompt","input":[{"type":"text","text":"…"}],"origin":…}
 *   {"type":"context.append_message","message":{"role":"user","content":[…]}}
 *
 * kimi records one typed turn TWICE — once as the prompt it was handed, once
 * as the message it appended to context. The B2b normaliser reads both as
 * `user`, so one human turn arrives at the mirror as two conversation turns at
 * two source positions, and C1's "exactly one committed Novakai Message" is
 * false by two. The first of the pair also carries `[{"type":"text","text":…}]`
 * as its text, because a serialised content array is what the prompt row holds
 * — so the Message it produced was a data structure, not a sentence.
 *
 * This fixture is the real shape, trimmed: nine rows in the order kimi writes
 * them, read by the PRODUCTION source adapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import { createProviderFileSource } from '../adapters/source-provider-file.js';
import type { MessagingMirrorPort, MirrorLedgerEntry } from '../core/mirror.js';
import type { AgentId, AgentRunId, ProviderSessionId } from '../contract/records.js';
import type { SystemCommandContext } from '@novakai/foundation/contract';

const FIXTURE = fileURLToPath(new URL('./fixtures/kimi-wire-session.jsonl', import.meta.url));

const AGENT = 'agent_eeeeeeee-0000-4000-8000-00000000000e' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-00000000000e' as AgentRunId;
const SESSION = 'sess_eeeeeeee-0000-4000-8000-00000000000e' as ProviderSessionId;

const HUMAN_TURN = 'add the retry budget to the spawn path';

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000001e' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000001e' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000002e' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000002e' as never,
  contractVersion: 1,
});

class RecordingMessaging implements MessagingMirrorPort {
  readonly committed: Array<{ role: string; text: string }> = [];
  private readonly byLine = new Map<string, string>();
  async commitTerminalOriginatedMessage(input: {
    readonly turn: {
      readonly transcriptLineId: string; readonly role: string; readonly text: string;
    };
  }) {
    const seen = this.byLine.get(input.turn.transcriptLineId);
    if (seen !== undefined) {
      return { ok: true as const, value: { messageId: seen, duplicate: true } };
    }
    const messageId = `message_${String(this.committed.length + 1)}`;
    this.byLine.set(input.turn.transcriptLineId, messageId);
    this.committed.push({ role: input.turn.role, text: input.turn.text });
    return { ok: true as const, value: { messageId, duplicate: false } };
  }
  async currentEndpointClaimId(): Promise<string | null> { return 'agentEndpoint_live'; }
}

test('one human turn typed into kimi becomes exactly one Message, in words', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-kimi-wire-'));
  const messaging = new RecordingMessaging();
  const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
  const api = composeB3Transcript({
    store,
    source: createProviderFileSource({ locate: () => FIXTURE }),
    messaging,
  });
  try {
    const bound = await api.bindTranscriptToRun(runtimeCtx(), {
      agentId: AGENT, agentRunId: RUN, provider: 'kimi',
      providerSessionId: SESSION, threadId: 'thread_kimi_wire',
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;

    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bound.value.id, maxLines: 100,
    });
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    if (!ingested.ok) return;

    // C1, in its own words: EXACTLY one Message for the typed turn.
    const human = messaging.committed.filter((entry) => entry.role === 'human');
    assert.equal(human.length, 1,
      `one typed turn produced ${String(human.length)} human Messages: `
      + JSON.stringify(human.map((entry) => entry.text.slice(0, 60))));
    assert.equal(human[0]?.text, HUMAN_TURN,
      'the Message carries a serialised provider payload instead of what was typed');

    // The other direction still works, and the ANSI never reaches the Message.
    assert.deepEqual(messaging.committed.map((entry) => entry.role), ['human', 'assistant']);
    assert.equal(messaging.committed[1]?.text, 'Done — the retry budget is 3 attempts.');

    // C3: the mirror wrote a typed role down, and the prompt row is on record
    // as filtered rather than silently dropped — a turn nobody can account for
    // is the failure mode the ledger exists to prevent.
    const ledger = await store.list<MirrorLedgerEntry>('transcriptLine', { bindingId: bound.value.id });
    assert.equal(ledger.ok, true);
    if (!ledger.ok) return;
    const outcomes = ledger.value
      .slice()
      .sort((left, right) => (left.sourcePosition < right.sourcePosition ? -1 : 1))
      .map((entry) => `${entry.sourcePosition}:${entry.outcome}${entry.role === undefined ? '' : `:${entry.role}`}`);
    assert.deepEqual(outcomes, [
      '0000000000:filtered',
      '0000000001:filtered',
      '0000000002:filtered',
      '0000000003:filtered',
      '0000000004:filtered',
      '0000000005:mirrored:human',
      '0000000006:filtered',
      '0000000007:mirrored:assistant',
      '0000000008:filtered',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
