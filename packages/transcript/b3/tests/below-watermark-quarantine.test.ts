/**
 * Spec ruling Q9 — a rewrite BELOW the mirror watermark, through the
 * PRODUCTION source adapter and a real file on disk (§8.2, §13.9).
 *
 * `mirror.test.ts` proves the pipeline quarantines when the source disagrees
 * with the ledger. That is decided against a fixture object, so it cannot
 * prove the thing exam rows F2/F3 actually caught: whether the adapter that
 * reads a provider's real `.jsonl` can SEE a historical rewrite at all. The
 * exam rewrote source position 6 with the watermark at 19, and the product
 * re-read only from the watermark — so the conflict was invisible, the
 * watermark advanced 19 → 21, and the turn appended past the conflict
 * committed as a Message.
 *
 * The file here is a COPY of the fixture, never the fixture itself: §27 says
 * provider originals are never written, and a corruption test that mutates one
 * would be breaking the rule it exists to protect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import { createProviderFileSource } from '../adapters/source-provider-file.js';
import type { MessagingMirrorPort } from '../core/mirror.js';
import type { AgentId, AgentRunId, ProviderSessionId } from '../contract/records.js';
import type { SystemCommandContext } from '@novakai/foundation/contract';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-conversation.jsonl', import.meta.url));

const AGENT = 'agent_dddddddd-0000-4000-8000-00000000000d' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-00000000000d' as AgentRunId;
const SESSION = 'sess_dddddddd-0000-4000-8000-00000000000d' as ProviderSessionId;

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000000d' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000000d' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-00000000000e' as never,
  traceId: 'trace_00000000-0000-4000-8000-00000000000e' as never,
  contractVersion: 1,
});

class RecordingMessaging implements MessagingMirrorPort {
  readonly committed: string[] = [];
  private readonly byLine = new Map<string, string>();
  async commitTerminalOriginatedMessage(input: {
    readonly turn: { readonly transcriptLineId: string; readonly text: string };
  }) {
    const seen = this.byLine.get(input.turn.transcriptLineId);
    if (seen !== undefined) {
      return { ok: true as const, value: { messageId: seen, duplicate: true } };
    }
    const messageId = `message_${String(this.committed.length + 1)}`;
    this.byLine.set(input.turn.transcriptLineId, messageId);
    this.committed.push(input.turn.text);
    return { ok: true as const, value: { messageId, duplicate: false } };
  }
  async currentEndpointClaimId(): Promise<string | null> { return 'agentEndpoint_live'; }
}

const humanTurn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, parentUuid: null, sessionId: 'b3c_claude_session',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

interface Rig {
  readonly api: ReturnType<typeof composeB3Transcript>;
  readonly messaging: RecordingMessaging;
  readonly root: string;
  readonly sourcePath: string;
}

function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-q9-'));
  const sourcePath = path.join(root, 'session.jsonl');
  copyFileSync(FIXTURE, sourcePath);
  const messaging = new RecordingMessaging();
  const api = composeB3Transcript({
    store: createTranscriptStore({ root, dataRoot: path.join(root, 'stores') }),
    source: createProviderFileSource({ locate: () => sourcePath }),
    messaging,
  });
  return { api, messaging, root, sourcePath };
}

async function bindAndMirror(harness: Rig): Promise<string> {
  const bound = await harness.api.bindTranscriptToRun(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN, provider: 'claude',
    providerSessionId: SESSION, threadId: 'thread_q9',
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('bind failed');
  const first = await harness.api.ingestTranscriptSource(transcriptCtx(), {
    bindingId: bound.value.id, maxLines: 100,
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.value.mirrored, 2);
  assert.equal(first.ok && first.value.nextWatermark, '0000000004');
  return bound.value.id;
}

const rowsOf = (contents: string): string[] => contents.replace(/\n$/, '').split('\n');

test('a real provider file rewritten below the watermark is quarantined, not mirrored past', async () => {
  const harness = rig();
  const human = { id: 'human_chris' as never, kind: 'human' as const, verifiedScopes: [] };
  try {
    const bindingId = await bindAndMirror(harness);

    // The exam's mutation, on a real file: rewrite the ALREADY-MIRRORED human
    // turn at position 0 — four positions below the watermark — and append a
    // fresh turn beyond it, exactly the way a provider appending to a rewritten
    // file would.
    const rows = rowsOf(readFileSync(harness.sourcePath, 'utf8'));
    rows[0] = humanTurn('b3c_claude_u1', 'add the retry budget to the spawn path CORRUPTED');
    rows.push(humanTurn('b3c_claude_u2', 'and one more turn after the corruption'));
    writeFileSync(harness.sourcePath, `${rows.join('\n')}\n`, 'utf8');

    const ingested = await harness.api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.quarantined, 1,
      'the production adapter could not see a rewrite below its own watermark');
    assert.equal(ingested.value.haltedBy, 'quarantine');

    const binding = await harness.api.getTranscriptBinding(human, RUN);
    assert.equal(binding.ok && binding.value.sourceDiscoveryState, 'corrupt');
    assert.equal(binding.ok && binding.value.quarantinedPosition, '0000000000');
    assert.equal(binding.ok && binding.value.watcherState, 'recovery-required');
    // F3, in its own words: the watermark does not move and the turn appended
    // beyond the conflict is NOT committed as a Message.
    assert.equal(binding.ok && binding.value.mirrorWatermark, '0000000004');
    assert.equal(harness.messaging.committed.length, 2);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('a line deleted below the watermark is corruption too, named at the shift', async () => {
  // The other half of "the committed prefix is no longer the prefix that was
  // committed". Deleting a row shifts every position after it, so the ledger
  // and the source stop describing the same conversation — and the quarantine
  // names the FIRST position where they diverge, not the last one a forward
  // re-read happens to touch.
  const harness = rig();
  const human = { id: 'human_chris' as never, kind: 'human' as const, verifiedScopes: [] };
  try {
    const bindingId = await bindAndMirror(harness);
    const rows = rowsOf(readFileSync(harness.sourcePath, 'utf8'));
    rows.splice(1, 1);
    rows.push(humanTurn('b3c_claude_u3', 'a turn appended over a deletion'));
    rows.push(humanTurn('b3c_claude_u5', 'and another, so the batch reaches past the watermark'));
    writeFileSync(harness.sourcePath, `${rows.join('\n')}\n`, 'utf8');

    const ingested = await harness.api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok && ingested.value.quarantined, 1);
    const binding = await harness.api.getTranscriptBinding(human, RUN);
    assert.equal(binding.ok && binding.value.sourceDiscoveryState, 'corrupt');
    assert.equal(binding.ok && binding.value.quarantinedPosition, '0000000001');
    assert.equal(harness.messaging.committed.length, 2);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('an honest append below an untouched prefix still mirrors', async () => {
  // The guard has to be complete WITHOUT being trigger-happy: the ordinary
  // case — a provider appending to a file it has not rewritten — must still
  // reach Messaging, or the fix for F2 would silently stop the mirror.
  const harness = rig();
  try {
    const bindingId = await bindAndMirror(harness);
    const rows = rowsOf(readFileSync(harness.sourcePath, 'utf8'));
    rows.push(humanTurn('b3c_claude_u4', 'the next honest turn'));
    writeFileSync(harness.sourcePath, `${rows.join('\n')}\n`, 'utf8');

    const ingested = await harness.api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.quarantined, 0);
    assert.equal(ingested.value.mirrored, 1);
    assert.equal(ingested.value.nextWatermark, '0000000005');
    assert.deepEqual(harness.messaging.committed.slice(-1), ['the next honest turn']);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
