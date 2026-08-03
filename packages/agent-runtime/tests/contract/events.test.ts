// The public event stream (§15, §12.2 `subscribeRunEvents`).
//
// Thirty event kinds were published into a function that dropped them: nothing
// kept them, nothing served them, and `subscribeEvents` was not on the wire at
// all (hold-out H3). §24.4's second host has to be able to "subscribe from a
// cursor", and §15 is specific about what a cursor must do when it can no
// longer be honoured — a typed gap, never a silent resume at "now".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalRequestHash, deriveClientOpId, deterministicId, mintRunOperationId,
  mintRuntimeEpochId,
  type RecordEnvelope,
} from '@novakai/foundation/contract';
import { createRunsRig, type RunsRig } from '../runs-harness.js';
import { createRunsStore } from '../../core/runs-store.js';
import type { AgentRun, RunOperation } from '../../contract/runs.js';

async function withRig<T>(work: (rig: RunsRig) => Promise<T>): Promise<T> {
  const rig = createRunsRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

const spawnInput = (roleProfileId: string, displayName: string) => ({
  roleProfileId: roleProfileId as never,
  displayName,
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

test('a spawn leaves events a consumer can read from the start of the stream', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('event-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Watched'));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);

    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true, page.ok ? '' : page.error.message);
    if (!page.ok) return;
    const kinds = page.value.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.operation.stage.changed'), true,
      `the spawn ladder published nothing readable: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.includes('agent.run.lifecycle.changed'), true);

    // §15: every event carries the whole envelope, not just a payload.
    const first = page.value.events[0]!;
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.sourceOwner, 'agent-runtime');
    assert.equal(typeof first.eventId, 'string');
    assert.equal(typeof first.traceId, 'string');
    assert.equal(typeof first.committedAt, 'string');
    assert.equal(typeof first.cursor, 'string');
  });
});

test('a cursor resumes exactly where its holder stopped reading', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('cursor-role');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'First'));
    assert.equal(first.ok, true);

    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const seen = page.value.events.length;
    assert.equal(seen > 0, true);

    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Second'));
    assert.equal(second.ok, true);

    const rest = await rig.runtime.readRunEvents(rig.principal(), {
      after: page.value.nextCursor, limit: 100,
    });
    assert.equal(rest.ok, true, rest.ok ? '' : rest.error.message);
    if (!rest.ok) return;
    assert.equal(rest.value.events.length > 0, true, 'the second spawn published nothing');
    for (const event of rest.value.events) {
      assert.equal(page.value.events.some((old) => old.eventId === event.eventId), false,
        'a cursor handed back an event its holder had already read');
    }
  });
});

test('a cursor this stream cannot honour is a typed gap, not a silent resume', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('gap-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Gapped'));
    assert.equal(spawned.ok, true);

    // A cursor minted by a Runtime that is gone. §20's last row: "event cursor
    // expired → typed gap"; the forbidden action is skipping history quietly.
    const stale = await rig.runtime.readRunEvents(rig.principal(), {
      after: 'aaaaaaaaaaaa.3' as never, limit: 10,
    });
    assert.equal(stale.ok, false, 'a foreign cursor was silently resumed');
    if (!stale.ok) {
      assert.equal(stale.error.code, 'CursorExpired');
      assert.equal(typeof stale.error.details['newestCursor'], 'string');
    }

    const nonsense = await rig.runtime.readRunEvents(rig.principal(), {
      after: 'not-a-cursor' as never, limit: 10,
    });
    assert.equal(nonsense.ok, false);
    if (!nonsense.ok) assert.equal(nonsense.error.code, 'ValidationFailed');
  });
});

test('subscribing from a cursor yields the events that follow it', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('subscribe-role');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Before'));
    assert.equal(first.ok, true);
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;

    const received: string[] = [];
    const stream = rig.runtime.subscribeRunEvents(rig.principal(), page.value.nextCursor);
    const reading = (async () => {
      for await (const event of stream) {
        if (!event.ok) break;
        received.push(event.value.kind);
        if (received.length >= 3) break;
      }
    })();

    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'After'));
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    await reading;
    assert.equal(received.length, 3, 'the subscription delivered nothing after the cursor');
  });
});

test('occurrence lookup retains event generation and fails when completeness is unproven', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('occurrence-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Occurrence'));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    await rig.runtime.publishCapabilityEvent('agent.run.activity.changed', {
      agentRunId: spawned.value.run.id,
      activityGeneration: 12,
      previous: {
        activity: 'idle', activityGeneration: 11, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:00:11.000Z',
      },
      current: {
        activity: 'unknown', activityGeneration: 12,
        uncertaintyCodes: ['provider-liveness-unknown'],
        observedAt: '2026-08-04T00:00:12.000Z',
      },
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.activity.changed',
    )!;
    const occurrence = await rig.runtime.getRunOccurrenceEvent(
      rig.principal(), event.eventId,
    );
    assert.equal(occurrence.ok, true, occurrence.ok ? '' : occurrence.error.message);
    if (!occurrence.ok || occurrence.value === null) return;
    assert.equal(occurrence.value.occurrenceKind, 'run-disconnected');
    assert.equal(occurrence.value.activityGeneration, 12);

    const missing = await rig.runtime.getRunOccurrenceEvent(
      rig.principal(), 'event_not-retained',
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, 'RuntimeUnavailable');
      assert.equal(missing.error.details['reason'], 'retained-event-completeness-unproven');
    }
  });
});

test('AMD-003 #31: exact occurrence lookup survives a Runtime restart', async () => {
  const first = createRunsRig();
  try {
    const role = first.agents.defineRole('retained-occurrence-role');
    const spawned = await first.runtime.spawnAgent(
      first.human(), spawnInput(role, 'Retained occurrence'),
    );
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    await first.runtime.publishCapabilityEvent('agent.run.activity.changed', {
      agentRunId: spawned.value.run.id,
      activityGeneration: 12,
      previous: {
        activity: 'idle', activityGeneration: 11, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:00:11.000Z',
      },
      current: {
        activity: 'unknown', activityGeneration: 12,
        uncertaintyCodes: ['provider-liveness-unknown'],
        observedAt: '2026-08-04T00:00:12.000Z',
      },
    }, 'agent-runtime');
    const page = await first.runtime.readRunEvents(first.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.activity.changed',
    )!;

    const restarted = createRunsRig({
      root: first.root,
      agents: first.agents,
      terminal: first.terminal,
      providers: first.providers,
      messagingEndpoint: first.messagingEndpoint,
      transcriptCustody: first.transcriptCustody,
      notifications: first.notifications,
    });
    const retained = await restarted.runtime.getRunOccurrenceEvent(
      restarted.principal(), event.eventId,
    );
    assert.equal(retained.ok, true, retained.ok ? '' : retained.error.message);
    if (!retained.ok || retained.value === null) return;
    assert.equal(retained.value.eventId, event.eventId);
    assert.equal(retained.value.occurrenceKind, 'run-disconnected');
    assert.equal(retained.value.activityGeneration, 12);
  } finally {
    first.close();
  }
});

test('AMD-003 #40: final occurrence discriminant rejects invalid reconciledFinal shapes', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('final-discriminant-role');
    const spawned = await rig.runtime.spawnAgent(
      rig.human(), spawnInput(role, 'Final discriminant'),
    );
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const store = createRunsStore({ root: rig.root, dataRoot: `${rig.root}/stores` });
    const interrupted = await store.update<AgentRun>(
      'sys_agent_runtime',
      spawned.value.run.id,
      {
        lifecycle: 'interrupted',
        finalAt: '2026-08-04T00:00:12.000Z',
        finalReason: 'runtime-reconciled-missing',
      },
      spawned.value.run.recordVersion,
      deriveClientOpId(`test:interrupt:${String(spawned.value.run.id)}`),
    );
    assert.equal(interrupted.ok, true, interrupted.ok ? '' : interrupted.error.message);
    if (!interrupted.ok) return;
    await rig.runtime.publishCapabilityEvent('agent.run.lifecycle.changed', {
      agentRunId: spawned.value.run.id,
      activityGeneration: interrupted.value.activityGeneration,
      toLifecycle: 'interrupted',
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const malformed = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.lifecycle.changed'
        && candidate.payload['toLifecycle'] === 'interrupted',
    )!;
    const rejected = await rig.runtime.getRunOccurrenceEvent(
      rig.principal(), malformed.eventId,
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'RecoveryRequired');
      assert.equal(rejected.error.details['stage'], 'occurrence-derivation');
    }
  });
});

test('AMD-003 #25: a final Run cannot yield a run-disconnected occurrence', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('final-disconnect-role');
    const spawned = await rig.runtime.spawnAgent(
      rig.human(), spawnInput(role, 'Final disconnect'),
    );
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId: spawned.value.run.agentId,
      expectedLiveRunId: spawned.value.run.id,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;
    await rig.runtime.publishCapabilityEvent('agent.run.activity.changed', {
      agentRunId: spawned.value.run.id,
      activityGeneration: 22,
      previous: {
        activity: 'idle', activityGeneration: 21, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:00:21.000Z',
      },
      current: {
        activity: 'unknown', activityGeneration: 22,
        uncertaintyCodes: ['provider-liveness-unknown'],
        observedAt: '2026-08-04T00:00:22.000Z',
      },
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.activity.changed',
    )!;
    const occurrence = await rig.runtime.getRunOccurrenceEvent(rig.principal(), event.eventId);
    assert.equal(occurrence.ok, true, occurrence.ok ? '' : occurrence.error.message);
    if (occurrence.ok) assert.equal(occurrence.value, null);
  });
});

test('AMD-003 #26: child help rejects untyped recovery evidence', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('typed-help-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Typed help'));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    await rig.runtime.publishCapabilityEvent('runtime.recovery.required', {
      agentRunId: spawned.value.run.id,
      reason: 'a typed recovery reason',
      evidenceRefs: ['event_valid', 7],
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'runtime.recovery.required',
    )!;
    const rejected = await rig.runtime.getRunOccurrenceEvent(rig.principal(), event.eventId);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'RecoveryRequired');
  });
});

test('AMD-003 #27: operation occurrence refuses multiple target Runs', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('operation-cardinality-role');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Operation one'));
    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Operation two'));
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    if (!first.ok || !second.ok) return;
    const store = createRunsStore({ root: rig.root, dataRoot: `${rig.root}/stores` });
    const operationId = mintRunOperationId('receipt_operation-cardinality');
    const seeded = await store.create<RunOperation>('sys_agent_runtime', {
      id: operationId,
      kind: 'runOperation',
      schemaVersion: 1,
      createdAt: '2026-08-04T00:01:00.000Z' as never,
      permissionLevel: 'private',
      createdBy: 'sys_agent_runtime',
      kindOfOperation: 'continue',
      commandReceiptId: 'receipt_operation-cardinality' as never,
      runtimeEpochId: mintRuntimeEpochId(),
      oldRunId: first.value.run.id,
      newRunId: second.value.run.id,
      currentStage: 'recovery-required',
      completedStages: [],
      compensation: [],
      state: 'recovery-required',
    }, deriveClientOpId('test:operation-cardinality'));
    assert.equal(seeded.ok, true, seeded.ok ? '' : seeded.error.message);
    if (!seeded.ok) return;
    await rig.runtime.publishCapabilityEvent('agent.run.operation.stage.changed', {
      operationId,
      stage: 'recovery-required',
      reason: 'two target Runs are ambiguous',
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 200 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.operation.stage.changed'
        && candidate.payload['operationId'] === operationId,
    )!;
    const rejected = await rig.runtime.getRunOccurrenceEvent(rig.principal(), event.eventId);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'RecoveryRequired');
      assert.deepEqual(rejected.error.details['resolvedTargetAgentRunIds'], [
        first.value.run.id, second.value.run.id,
      ].sort());
    }
  });
});

test('AMD-003 #31: duplicate event IDs with different payloads fail closed', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('duplicate-event-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Duplicate event'));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    await rig.runtime.publishCapabilityEvent('agent.run.activity.changed', {
      agentRunId: spawned.value.run.id,
      activityGeneration: 2,
      previous: {
        activity: 'idle', activityGeneration: 1, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:00:01.000Z',
      },
      current: {
        activity: 'unknown', activityGeneration: 2,
        uncertaintyCodes: ['provider-liveness-unknown'],
        observedAt: '2026-08-04T00:00:02.000Z',
      },
    }, 'agent-runtime');
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const event = [...page.value.events].reverse().find(
      (candidate) => candidate.kind === 'agent.run.activity.changed',
    )!;
    const payload = { ...event.payload, activityGeneration: 999 };
    const evidenceDigest = canonicalRequestHash({
      event: { ...event, payload }, runFacts: null,
    });
    const store = createRunsStore({ root: rig.root, dataRoot: `${rig.root}/stores` });
    const duplicate = await store.create<RecordEnvelope<string, 'runOccurrenceEvent'>>(
      'sys_agent_runtime',
      {
        id: deterministicId('runOccurrenceEvent', ['corrupt-duplicate', event.eventId]),
        kind: 'runOccurrenceEvent',
        schemaVersion: 1,
        createdAt: event.committedAt,
        permissionLevel: 'team',
        createdBy: 'sys_agent_runtime',
        eventId: event.eventId,
        eventKind: event.kind,
        occurredAt: event.occurredAt,
        committedAt: event.committedAt,
        sourceOwner: event.sourceOwner,
        traceId: event.traceId,
        cursor: event.cursor,
        payload,
        canonicalPayloadDigest: canonicalRequestHash(payload),
        canonicalEvidenceDigest: evidenceDigest,
      },
      deriveClientOpId(`test:duplicate-event:${event.eventId}`),
    );
    assert.equal(duplicate.ok, true, duplicate.ok ? '' : duplicate.error.message);
    const rejected = await rig.runtime.getRunOccurrenceEvent(rig.principal(), event.eventId);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'RecoveryRequired');
      assert.equal(rejected.error.details['stage'], 'occurrence-derivation');
    }
  });
});
