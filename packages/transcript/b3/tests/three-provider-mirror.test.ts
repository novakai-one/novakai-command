/**
 * B3c EXIT PROOF — "all three provider conversation fixtures round-trip
 * exactly once" (§25-B3c, §24.2, §24.6).
 *
 * The same exchange, in claude's, codex's and kimi's own file shapes, read by
 * the PRODUCTION source adapter through the B2b normaliser that already knows
 * all three dialects. Nothing about the pipeline is stubbed except the
 * Messaging endpoint, which is recorded rather than faked away so the
 * assertions can read what it was actually asked to commit.
 *
 * Each fixture is five lines and must produce exactly two Messages:
 *
 *   human turn                → Message
 *   tool call                 → filtered
 *   tool result               → filtered
 *   assistant turn in ANSI    → Message, colour stripped
 *   usage readout             → filtered
 *
 * "Exactly once" is checked twice over: once for a single pass, and again for
 * a full re-ingest, because §24.6 requires that replay after any crash point
 * does not duplicate logical Message identity.
 *
 * §27 is checked by reading the fixture bytes before and after. Provider
 * originals remain untouched — the mirror is a copy, always.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import { createProviderFileSource } from '../adapters/source-provider-file.js';
import type { MessagingMirrorPort } from '../core/mirror.js';
import type { B3TranscriptContract } from '../contract/api.js';
import type { AgentId, AgentRunId, ProviderKind, ProviderSessionId } from '../contract/records.js';
import type { SystemCommandContext } from '@novakai/foundation/contract';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** What the exchange says, once Novakai is done with it. */
const EXPECTED = [
  { role: 'human', text: 'add the retry budget to the spawn path' },
  { role: 'assistant', text: 'Done — the retry budget is 3 attempts.' },
];

const PROVIDERS: ReadonlyArray<{
  readonly provider: ProviderKind;
  readonly fixture: string;
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly providerSessionId: ProviderSessionId;
}> = [
  {
    provider: 'claude', fixture: 'claude-conversation.jsonl',
    agentId: 'agent_aaaaaaaa-0000-4000-8000-00000000000a' as AgentId,
    agentRunId: 'agentRun_01900000-0000-7000-8000-00000000000a' as AgentRunId,
    providerSessionId: 'sess_aaaaaaaa-0000-4000-8000-00000000000a' as ProviderSessionId,
  },
  {
    provider: 'codex', fixture: 'codex-conversation.jsonl',
    agentId: 'agent_bbbbbbbb-0000-4000-8000-00000000000b' as AgentId,
    agentRunId: 'agentRun_01900000-0000-7000-8000-00000000000b' as AgentRunId,
    providerSessionId: 'sess_bbbbbbbb-0000-4000-8000-00000000000b' as ProviderSessionId,
  },
  {
    provider: 'kimi', fixture: 'kimi-conversation.jsonl',
    agentId: 'agent_cccccccc-0000-4000-8000-00000000000c' as AgentId,
    agentRunId: 'agentRun_01900000-0000-7000-8000-00000000000c' as AgentRunId,
    providerSessionId: 'sess_cccccccc-0000-4000-8000-00000000000c' as ProviderSessionId,
  },
];

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

/**
 * Messaging, recorded. It enforces the one rule the proof depends on —
 * one logical Message per transcript line — the way the real acceptance
 * transaction does, by idempotency key rather than by trusting the caller.
 */
class RecordingMessaging implements MessagingMirrorPort {
  readonly committed: Array<{ role: string; text: string; lineId: string }> = [];
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
    this.committed.push({
      role: input.turn.role, text: input.turn.text, lineId: input.turn.transcriptLineId,
    });
    return { ok: true as const, value: { messageId, duplicate: false } };
  }

  async currentEndpointClaimId(): Promise<string | null> { return 'agentEndpoint_live'; }
}

interface Rig {
  readonly api: B3TranscriptContract;
  readonly messaging: RecordingMessaging;
  readonly root: string;
}

function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-three-provider-'));
  const messaging = new RecordingMessaging();
  const api = composeB3Transcript({
    store: createTranscriptStore({ root, dataRoot: path.join(root, 'stores') }),
    // The PRODUCTION source adapter over the provider's real file shape.
    source: createProviderFileSource({
      locate: (binding) => path.join(
        fixtureDir,
        PROVIDERS.find((entry) => entry.provider === binding.provider)?.fixture ?? '',
      ),
    }),
    messaging,
  });
  return { api, messaging, root };
}

for (const target of PROVIDERS) {
  test(`${target.provider}: a conversation fixture round-trips exactly once`, async () => {
    const harness = rig();
    const fixturePath = path.join(fixtureDir, target.fixture);
    const before = readFileSync(fixturePath);
    try {
      const bound = await harness.api.bindTranscriptToRun(runtimeCtx(), {
        agentId: target.agentId,
        agentRunId: target.agentRunId,
        provider: target.provider,
        providerSessionId: target.providerSessionId,
        threadId: `thread_${target.provider}`,
      });
      assert.equal(bound.ok, true);
      if (!bound.ok) return;

      const ingested = await harness.api.ingestTranscriptSource(transcriptCtx(), {
        bindingId: bound.value.id, maxLines: 100,
      });
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      if (!ingested.ok) return;

      assert.equal(ingested.value.mirrored, 2,
        `${target.provider} mirrored ${String(ingested.value.mirrored)} turns, not 2`);
      assert.equal(ingested.value.quarantined, 0);
      assert.deepEqual(
        harness.messaging.committed.map((entry) => ({ role: entry.role, text: entry.text })),
        EXPECTED,
        `${target.provider} did not produce the expected conversation`,
      );

      // Red gate 17 and its twin: the tool lines and the usage readout are
      // transcript evidence, and the ANSI colour never reached the Message.
      assert.equal(ingested.value.filtered, 3);
      for (const entry of harness.messaging.committed) {
        assert.equal(entry.text.includes(String.fromCharCode(27)), false,
          'an escape sequence survived into a Message');
      }

      // §24.6: replay does not duplicate logical Message identity.
      const again = await harness.api.ingestTranscriptSource(transcriptCtx(), {
        bindingId: bound.value.id, maxLines: 100,
      });
      assert.equal(again.ok, true);
      assert.equal(harness.messaging.committed.length, 2,
        `${target.provider} committed a Message twice on re-ingest`);

      // §27: the provider's own file is untouched, byte for byte.
      assert.deepEqual(readFileSync(fixturePath), before,
        `${target.provider}'s original transcript was modified`);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
}

test('all three providers together produce six Messages and no collisions', async () => {
  // Run in ONE store. If two providers' line ids collided, the second
  // provider's turns would be silently recognised as already-mirrored — which
  // is the failure a per-provider test cannot see.
  const harness = rig();
  try {
    for (const target of PROVIDERS) {
      const bound = await harness.api.bindTranscriptToRun(runtimeCtx(), {
        agentId: target.agentId,
        agentRunId: target.agentRunId,
        provider: target.provider,
        providerSessionId: target.providerSessionId,
        threadId: `thread_${target.provider}`,
      });
      assert.equal(bound.ok, true);
      if (!bound.ok) return;
      const ingested = await harness.api.ingestTranscriptSource(transcriptCtx(), {
        bindingId: bound.value.id, maxLines: 100,
      });
      assert.equal(ingested.ok && ingested.value.mirrored, 2);
    }
    assert.equal(harness.messaging.committed.length, 6);
    assert.equal(new Set(harness.messaging.committed.map((entry) => entry.lineId)).size, 6,
      'two providers produced the same transcript line id');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
