/**
 * §13.9 — "the mirror watermark advances only after a durable filtered outcome
 * or durable Message/effect result."
 *
 * `PromoteMirrorWatermarkInput.outcomeRefs` is that sentence made into an
 * argument: the caller names the durable outcomes that justify the advance.
 * Nothing read it. `promoteMirrorWatermark` checked the CAS and the quarantine
 * flag and then wrote whatever `nextWatermark` said — so any caller could push
 * a healthy binding's watermark to any string, and every source position it
 * skipped would never be read again. Those turns are not lost noisily; they are
 * simply never mirrored, and nothing afterwards says a gap exists.
 *
 * `outcomeRefs: []` is the shape the shipped tests pass, which is how it
 * survived: an empty list is exactly the claim "nothing justifies this", and it
 * was accepted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import { mirrorLedgerId } from '../core/mirror.js';
import type { MessagingMirrorPort } from '../core/mirror.js';
import type {
  B3TranscriptContract, SourceLine, SourceReadOutcome, TranscriptSourcePort,
} from '../contract/api.js';
import type { AgentId, AgentRunId, ProviderSessionId } from '../contract/records.js';
import type { SystemCommandContext } from '@novakai/foundation/contract';

const AGENT = 'agent_aaaaaaaa-0000-4000-8000-000000000001' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-000000000001' as AgentRunId;
const SESSION = 'sess_11111111-0000-4000-8000-000000000001' as ProviderSessionId;
const THREAD = 'thread_conversation-1';

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000001' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000001' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000002' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000002' as never,
  contractVersion: 1,
});

class FixtureSource implements TranscriptSourcePort {
  lines: SourceLine[] = [];
  async read(
    _binding: unknown, fromPosition: string | undefined, maxLines: number,
  ): Promise<SourceReadOutcome> {
    // INCLUSIVE of the watermark line: see TranscriptSourcePort.read.
    const found = fromPosition === undefined
      ? -1
      : this.lines.findIndex((entry) => entry.position === fromPosition);
    const start = found === -1 ? 0 : found;
    const window = this.lines.slice(start, start + maxLines);
    return { kind: 'lines', lines: window, more: start + maxLines < this.lines.length };
  }
}

/** Commits once per transcript line, like the real one, and nothing else. */
class SilentMessaging implements MessagingMirrorPort {
  private readonly byLine = new Map<string, string>();
  async commitTerminalOriginatedMessage(input: {
    readonly turn: { readonly transcriptLineId: string };
  }) {
    const seen = this.byLine.get(input.turn.transcriptLineId);
    if (seen !== undefined) {
      return { ok: true as const, value: { messageId: seen, duplicate: true } };
    }
    const messageId = `message_${String(this.byLine.size + 1)}`;
    this.byLine.set(input.turn.transcriptLineId, messageId);
    return { ok: true as const, value: { messageId, duplicate: false } };
  }
  async currentEndpointClaimId(): Promise<string | null> { return 'agentEndpoint_live'; }
}

interface Rig {
  readonly api: B3TranscriptContract;
  readonly source: FixtureSource;
  readonly root: string;
}

function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-watermark-'));
  const source = new FixtureSource();
  const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
  const api = composeB3Transcript({
    store, source, messaging: new SilentMessaging() as never,
  });
  return { api, source, root };
}

async function bind(api: B3TranscriptContract): Promise<string> {
  const bound = await api.bindTranscriptToRun(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN, provider: 'claude',
    providerSessionId: SESSION, threadId: THREAD,
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('bind failed');
  return bound.value.id;
}

test('the watermark refuses to advance on outcomes that do not exist', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [
      { position: '1', role: 'user', text: 'one', digest: 'd-1' },
      { position: '2', role: 'assistant', text: 'two', digest: 'd-2' },
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.nextWatermark, '2');

    // Position 9 was never discovered, never mirrored, never filtered. Nothing
    // durable says anything happened there, and the caller claims nothing.
    const empty = await api.promoteMirrorWatermark(transcriptCtx(), {
      bindingId: bindingId as never,
      expectedWatermark: '2',
      nextWatermark: '9',
      outcomeRefs: [],
    });
    assert.equal(empty.ok, false,
      'the watermark advanced past positions 3-9 on a claim of nothing at all');
    if (empty.ok) return;
    assert.equal(empty.error.code, 'ValidationFailed');

    // Naming an outcome that does not exist is the same lie with more typing.
    const invented = await api.promoteMirrorWatermark(transcriptCtx(), {
      bindingId: bindingId as never,
      expectedWatermark: '2',
      nextWatermark: '9',
      outcomeRefs: [mirrorLedgerId(bindingId, '9')],
    });
    assert.equal(invented.ok, false,
      'the watermark advanced on an outcome reference that resolves to nothing');

    const still = await api.getTranscriptBinding(
      { id: 'person_chris' as never, kind: 'human', verifiedScopes: [] }, RUN,
    );
    assert.equal(still.ok && still.value.mirrorWatermark, '2',
      'a refused promotion moved the watermark anyway');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the watermark advances when the outcome it names is durable', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [
      { position: '1', role: 'user', text: 'one', digest: 'd-1' },
      { position: '2', role: 'assistant', text: 'two', digest: 'd-2' },
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 1,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.nextWatermark, '1');

    // Now mirror position 2 as well, so its outcome is durable on disk. The
    // read is INCLUSIVE of the watermark line, so this pass re-reads 1 (a
    // recognised duplicate) and commits 2.
    const second = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 2,
    });
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    if (!second.ok) return;
    assert.equal(second.value.nextWatermark, '2');

    const promoted = await api.promoteMirrorWatermark(transcriptCtx(), {
      bindingId: bindingId as never,
      expectedWatermark: '2',
      nextWatermark: '2',
      outcomeRefs: [mirrorLedgerId(bindingId, '2')],
    });
    assert.equal(promoted.ok, true,
      promoted.ok ? '' : `a promotion naming a REAL durable outcome was refused: `
        + `${promoted.error.code} — ${promoted.error.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
