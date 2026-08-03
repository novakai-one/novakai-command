import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, mintClientOpId, mintTraceCorrelationId,
} from '@novakai/foundation/contract';
import type {
  WatchEvaluationProgress, WatchRuleAdmissionEvent,
} from '../contract/index.js';
import {
  composeSupervision, createSupervisionStore,
  subscribeWatchRuleAdmissionSignals, type SupervisionStore,
} from '../core/index.js';

const RULE_ID = 'watchRule_019fd000-0000-7000-8000-0000000000a1' as never;
const EVALUATION_ID = `watchEvaluation_${'a'.repeat(52)}` as never;
const TRACE_ID = 'trace_123e4567-e89b-42d3-a456-426614174000' as never;

function progress(): WatchEvaluationProgress {
  return {
    kind: 'watchEvaluation', id: EVALUATION_ID, schemaVersion: 1,
    recordVersion: 1 as never,
    createdAt: '2026-08-04T00:00:00.000Z' as never,
    permissionLevel: 'private', createdBy: 'sys_supervision',
    lastMutation: { state: 'legacy-no-trace' },
    commandReceiptId: `receipt_${'b'.repeat(52)}` as never,
    trigger: { kind: 'event', eventId: 'event_source' },
    orderedWatchRuleIds: [RULE_ID],
    attemptOrdinal: 0,
    completed: [0, 1].map((offset) => ({
      attemptOrdinal: 0,
      watchRuleId: RULE_ID,
      evaluatedRecordVersion: (offset + 3) as never,
      outcome: {
        kind: 'pair-not-admitted' as const,
        signalEventId: `event_${offset === 0 ? 'c' : 'd'}`,
        signalOccurredAt: `2026-08-04T00:00:0${String(offset)}.000Z` as never,
        signalTraceId: TRACE_ID,
        subject: {
          kind: 'agent',
          agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
        },
        condition: { kind: 'idle-for-ms' as const, value: 1_000 },
        reason: 'the subject has no single authoritative Run-local clock for this condition',
      },
    })),
    nextRuleIndex: 1,
    state: 'completed',
  };
}

function storeWith(item: WatchEvaluationProgress): SupervisionStore {
  return {
    create: async () => { throw new Error('not used'); },
    update: async () => { throw new Error('not used'); },
    read: async () => { throw new Error('not used'); },
    list: async () => ({ ok: true as const, value: [item] }),
  } as unknown as SupervisionStore;
}

const operator = {
  id: 'ops_admission' as never,
  kind: 'operations' as const,
  verifiedScopes: ['supervision:watch:repair' as never],
};

test('admission signal subscription replays durable pair refusals and resumes from its cursor', async () => {
  const store = storeWith(progress());
  const firstStream = subscribeWatchRuleAdmissionSignals(store, operator)[Symbol.asyncIterator]();
  const first = await firstStream.next();
  assert.equal(first.done, false);
  assert.equal(first.value.ok, true);
  if (first.value.ok) {
    const event: WatchRuleAdmissionEvent = first.value.value;
    assert.equal(event.kind, 'supervision.watch-rule-admission.changed');
    assert.equal(event.payload.watchEvaluationId, EVALUATION_ID);
    assert.equal(event.payload.watchRuleId, RULE_ID);
    assert.equal(event.payload.evaluatedRecordVersion, 3);
    assert.deepEqual(event.payload.subject, {
      kind: 'agent', agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
    });

    const resumed = subscribeWatchRuleAdmissionSignals(
      store, operator, event.cursor,
    )[Symbol.asyncIterator]();
    const second = await resumed.next();
    assert.equal(second.done, false);
    assert.equal(second.value.ok, true);
    if (second.value.ok) assert.equal(second.value.value.eventId, 'event_d');
    await resumed.return?.();
  }
  await firstStream.return?.();
});

test('admission signals require the repair scope', async () => {
  const stream = subscribeWatchRuleAdmissionSignals(storeWith(progress()), {
    id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
  })[Symbol.asyncIterator]();
  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(first.value.ok, false);
  if (!first.value.ok) assert.equal(first.value.error.code, 'PermissionDenied');
});

test('a persisted R pair records, signals, and never blocks later evaluation completion', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-admission-r-pair-'));
  try {
    const real = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    let exposeCorruption = false;
    const corruptView = <Value>(value: Value): Value => {
      if (!exposeCorruption || value === null || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      if (record['kind'] !== 'watchRule') return value;
      return {
        ...record,
        subject: {
          kind: 'agent', agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
        },
        condition: { kind: 'idle-for-ms', value: 1_000 },
      } as Value;
    };
    const store: SupervisionStore = {
      create: (...args) => real.create(...args),
      update: (...args) => real.update(...args),
      read: (async (kind, id) => {
        const read = await real.read(kind, id);
        return read.ok ? b3ok(corruptView(read.value)) : read;
      }) as SupervisionStore['read'],
      list: (async (kind, filter) => {
        const listed = await real.list(kind, filter);
        return listed.ok ? b3ok(listed.value.map(corruptView)) : listed;
      }) as SupervisionStore['list'],
    };
    const supervision = composeSupervision({
      root, dataRoot: path.join(root, 'stores'), store,
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    });
    const human = {
      id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [],
    };
    const created = await supervision.createWatchRule({
      principal: human, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      subject: {
        kind: 'agent-run',
        agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never,
      },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: human.id },
      deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    exposeCorruption = true;
    const evaluated = await supervision.evaluateEvent({
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1,
    }, { event: {
      eventId: 'event_unrelated', kind: 'agent.run.lifecycle.changed', schemaVersion: 1,
      occurredAt: '2026-08-04T00:00:00.000Z' as never,
      committedAt: '2026-08-04T00:00:00.000Z' as never,
      sourceOwner: 'agent-runtime', traceId: TRACE_ID, cursor: 'runtime.1' as never,
      payload: {
        agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
        toLifecycle: 'ready',
      },
    } });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok) return;
    assert.deepEqual(evaluated.value, []);
    const storedProgress = await supervision.listWatchEvaluationProgress(operator, {
      outcomeKind: 'pair-not-admitted', limit: 20,
    });
    assert.equal(storedProgress.ok, true);
    if (!storedProgress.ok) return;
    assert.equal(storedProgress.value.items.length, 1);
    assert.equal(storedProgress.value.items[0]!.state, 'completed');

    const stream = supervision.subscribeWatchRuleAdmissionSignals(operator)[Symbol.asyncIterator]();
    const signalled = await stream.next();
    assert.equal(signalled.done, false);
    assert.equal(signalled.value.ok, true);
    if (signalled.value.ok) {
      assert.equal(signalled.value.value.payload.watchRuleId, created.value.id);
      assert.equal(signalled.value.value.payload.subject.kind, 'agent');
      assert.equal(signalled.value.value.payload.condition.kind, 'idle-for-ms');
    }
    await stream.return?.();
    const notifications = await supervision.listNotifications(human, { limit: 20 });
    assert.equal(notifications.ok, true);
    if (notifications.ok) assert.equal(notifications.value.items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
