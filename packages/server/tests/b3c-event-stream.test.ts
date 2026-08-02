// B3c — the six §15 event kinds reach `b3.agent.subscribeEvents` (surface #3).
//
// The requirement is not "events exist somewhere". It is that ONE cursor
// covers every capability, because §24.4's second-host harness subscribes to a
// single stream and two streams cannot be ordered against each other.
//
// So this reads the same wire method a second host would, from a cursor, and
// checks that Messaging's and Transcript's facts arrive on it — carrying their
// own `sourceOwner`, because they are their capabilities' facts and not the
// Runtime's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import type { RunEventPage } from '../../agent-runtime/contract/index.js';

const AGENT = 'agent_aaaaaaaa-0000-4000-8000-000000000001';
const RUN_1 = 'agentRun_01900000-0000-7000-8000-000000000001';
const RUN_2 = 'agentRun_01900000-0000-7000-8000-000000000002';
const TERMINAL_1 = 'terminal_01900000-0000-7000-8000-000000000001';
const TERMINAL_2 = 'terminal_01900000-0000-7000-8000-000000000002';

const human = {
  principal: { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000001' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000001' as never,
  contractVersion: 1 as const,
};
const runtimeCtx = {
  ...human,
  principal: { id: 'sys_agent_runtime' as never, kind: 'system' as const, verifiedScopes: [] },
};
const transcriptCtx = {
  ...human,
  principal: { id: 'sys_transcript' as never, kind: 'system' as const, verifiedScopes: [] },
};

test('messaging and transcript facts arrive on the ONE agent event stream', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-events-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const { messaging, transcript, runs } = host.runtime;

    const thread = await messaging.ensureDirectThread(human, {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: AGENT as never },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    const reserved = await messaging.reserveAgentEndpointClaim(runtimeCtx, {
      agentId: AGENT as never, agentRunId: RUN_1 as never,
      terminalSessionId: TERMINAL_1 as never, expectedEndpointGeneration: -1,
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    await messaging.activateAgentEndpointClaim(runtimeCtx, reserved.value.id);
    await messaging.sendAgentMessage(human, {
      target: { kind: 'agent', agentId: AGENT as never },
      threadId: thread.value.id, text: 'ping', clientMessageId: 'cmid-1',
    });
    await messaging.transferAgentEndpointClaim(runtimeCtx, {
      agentId: AGENT as never, expectedOldClaimId: reserved.value.id,
      newRunId: RUN_2 as never, newTerminalSessionId: TERMINAL_2 as never,
      oldFinalTranscriptWatermark: 'pos-1', expectedEndpointGeneration: 0,
    });

    const bound = await transcript.bindTranscriptToRun(runtimeCtx, {
      agentId: AGENT as never, agentRunId: RUN_1 as never, provider: 'claude',
      providerSessionId: 'sess_11111111-0000-4000-8000-000000000001' as never,
      threadId: thread.value.id,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    await transcript.ingestTranscriptSource(transcriptCtx, {
      bindingId: bound.value.id, maxLines: 10,
    });

    // Read the way a second host does: the published method, from the start.
    const page = await runs.readRunEvents(human.principal, { limit: 500 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const events = (page.value as RunEventPage).events;
    const kinds = new Set(events.map((event) => event.kind));

    for (const required of [
      'messaging.agent-message.committed',
      'messaging.agent-inbox.changed',
      'messaging.agent-endpoint.changed',
      'transcript.line.committed',
      'transcript.binding.changed',
    ]) {
      assert.equal(kinds.has(required), true,
        `${required} never reached the stream; saw ${[...kinds].join(', ')}`);
    }

    // §15: the event names the capability that OWNS the fact.
    const owners = new Map(events.map((event) => [event.kind, event.sourceOwner]));
    assert.equal(owners.get('messaging.agent-message.committed'), 'messaging');
    assert.equal(owners.get('transcript.binding.changed'), 'transcript');

    // One stream means one cursor. Resuming from an event's own cursor yields
    // only what came after it — the property a second host depends on.
    const mid = events[Math.floor(events.length / 2)];
    assert.notEqual(mid, undefined);
    const resumed = await runs.readRunEvents(human.principal, {
      after: mid!.cursor, limit: 500,
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    const resumedIds = (resumed.value as RunEventPage).events.map((event) => event.eventId);
    assert.equal(resumedIds.includes(mid!.eventId), false,
      'resuming from a cursor replayed the event it named');
    assert.equal(resumedIds.length < events.length, true);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
