import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, canonicalRequestHash, mintClientOpId, mintTraceCorrelationId,
} from '@novakai/foundation/contract';
import {
  isWatchEvaluationId,
  type Notification, type RunOccurrenceEventFacts, type RunUsageFacts,
  type WatchCondition, type WatchRule,
} from '../contract/index.js';
import { composeSupervision, type SupervisionCore } from '../core/index.js';

const PARENT_AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const CHILD_AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174001' as never;
const PARENT_RUN_ID = 'agentRun_019fd000-0000-7000-8000-000000000090' as never;
const RUN_IDS = [
  'agentRun_019fd000-0000-7000-8000-0000000000a1',
  'agentRun_019fd000-0000-7000-8000-0000000000a2',
] as const;
const SESSION_IDS = [
  'sess_123e4567-e89b-42d3-a456-426614174001',
  'sess_123e4567-e89b-42d3-a456-426614174002',
] as const;
const HUMAN = {
  id: 'person_chris' as never,
  kind: 'human' as const,
  verifiedScopes: ['supervision:watch:repair' as never],
};

interface LifecycleOwners {
  readonly events: Map<string, RunOccurrenceEventFacts>;
  related: boolean;
}

function publicEvent(
  eventId: string,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  occurredAt: string,
) {
  return {
    eventId,
    kind,
    schemaVersion: 1 as const,
    occurredAt: occurredAt as never,
    committedAt: occurredAt as never,
    sourceOwner: 'agent-runtime' as const,
    traceId: mintTraceCorrelationId(),
    cursor: `cursor-${eventId}` as never,
    payload,
  };
}

function baseFacts(
  event: ReturnType<typeof publicEvent>,
  runIndex: number,
  options: {
    readonly lifecycle?: RunUsageFacts['lifecycle'];
    readonly final?: boolean;
    readonly activityGeneration?: number;
  } = {},
) {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    committedAt: event.committedAt,
    sourceOwner: 'agent-runtime' as const,
    agentRunId: RUN_IDS[runIndex]! as never,
    agentId: CHILD_AGENT_ID,
    providerSessionId: SESSION_IDS[runIndex]! as never,
    lifecycle: options.lifecycle ?? 'ready',
    final: options.final ?? false,
    activityGeneration: (options.activityGeneration ?? 1) as never,
    canonicalPayloadDigest: canonicalRequestHash(event.payload),
  };
}

function compose(root: string, owners: LifecycleOwners): SupervisionCore {
  return composeSupervision({
    root,
    dataRoot: path.join(root, 'stores'),
    installAuthority: { resolve: async () => { throw new Error('not used'); } },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    watchRuleGeneration: { generationFor: async () => b3ok(1 as never) },
    occurrenceRelationships: {
      isDirectManagedChild: async (_principal, input) => b3ok(
        owners.related
          && input.childAgentId === CHILD_AGENT_ID
          && (input.parentAgentId === PARENT_AGENT_ID
            || input.parentAgentRunId === PARENT_RUN_ID),
      ),
    },
    usage: {
      runs: {
        getUsageRun: async () => b3ok(null as never),
        listUsageRuns: async () => b3ok([]),
        resolveUsageRunByProviderSession: async () => b3ok(null),
        resolveCurrentRunByAgent: async () => b3ok(null),
        getRunOccurrenceEvent: async (_principal, eventId) => b3ok(
          owners.events.get(eventId) ?? null,
        ),
      },
      evidence: {
        getProviderUsageEvidence: async () => b3ok(null),
        listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
      },
    },
  });
}

const humanContext = () => ({
  principal: HUMAN,
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1 as const,
});

const runtimeContext = () => ({
  principal: { id: 'sys_agent_runtime' as const, kind: 'system' as const, verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1 as const,
});

async function createRule(
  supervision: SupervisionCore,
  subject: Parameters<SupervisionCore['createWatchRule']>[1]['subject'],
  condition: WatchCondition,
): Promise<WatchRule> {
  const created = await supervision.createWatchRule(humanContext(), {
    subject,
    condition,
    recipient: { kind: 'human', principalId: HUMAN.id },
    deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
  });
  if (!created.ok) assert.fail(created.error.message);
  return created.value;
}

test('AMD-003 #24: stable Agent and children run-final rules distinguish equal-generation Runs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lifecycle-final-'));
  try {
    const owners: LifecycleOwners = { events: new Map(), related: true };
    const supervision = compose(root, owners);
    const agentRule = await createRule(
      supervision, { kind: 'agent', agentId: CHILD_AGENT_ID }, { kind: 'run-final' },
    );
    const childrenRule = await createRule(
      supervision, { kind: 'children-of', agentId: PARENT_AGENT_ID }, { kind: 'run-final' },
    );
    for (let index = 0; index < 2; index += 1) {
      const event = publicEvent(
        `event_run-final-${String(index)}`,
        'agent.run.lifecycle.changed',
        {
          agentRunId: RUN_IDS[index], toLifecycle: 'stopped', activityGeneration: 1,
        },
        `2026-08-04T00:01:0${String(index)}.000Z`,
      );
      owners.events.set(event.eventId, {
        ...baseFacts(event, index, { lifecycle: 'stopped', final: true }),
        kind: 'agent.run.lifecycle.changed',
        occurrenceKind: 'run-final',
        occurrence: { toLifecycle: 'stopped' },
      });
      const evaluated = await supervision.evaluateEvent(runtimeContext(), { event });
      assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
      if (evaluated.ok) assert.equal(evaluated.value.length, 2);
    }
    const stored = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    for (const rule of [agentRule, childrenRule]) {
      const rows: readonly Notification[] = stored.value.items.filter(
        (item: Notification) => item.watchRuleId === rule.id,
      );
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]!.id, rows[1]!.id);
      assert.equal(rows.every((item) => item.conditionGeneration === 1), true);
      assert.equal(rows.every((item) => 'conditionOccurrence' in item
        && item.conditionOccurrence?.kind === 'run-final'), true);
    }
    const restarted = compose(root, owners);
    const redelivered = await restarted.evaluateEvent(runtimeContext(), {
      event: publicEvent(
        'event_run-final-0', 'agent.run.lifecycle.changed',
        { agentRunId: RUN_IDS[0], toLifecycle: 'stopped', activityGeneration: 1 },
        '2026-08-04T00:01:00.000Z',
      ),
    });
    assert.deepEqual(redelivered, b3ok([]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #25: disconnect rules distinguish edges, absorb replay, and reject detach', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lifecycle-disconnect-'));
  try {
    const owners: LifecycleOwners = { events: new Map(), related: true };
    const supervision = compose(root, owners);
    const agentRule = await createRule(
      supervision, { kind: 'agent', agentId: CHILD_AGENT_ID }, { kind: 'run-disconnected' },
    );
    const childrenRule = await createRule(
      supervision, { kind: 'children-of', agentId: PARENT_AGENT_ID },
      { kind: 'run-disconnected' },
    );
    const events = [];
    for (let index = 0; index < 2; index += 1) {
      const generation = index + 2;
      const previous = {
        activity: 'idle', activityGeneration: generation - 1, uncertaintyCodes: [],
        observedAt: `2026-08-04T00:02:0${String(index)}.000Z`,
      };
      const current = {
        activity: 'unknown', activityGeneration: generation,
        uncertaintyCodes: ['provider-liveness-unknown'],
        observedAt: `2026-08-04T00:02:1${String(index)}.000Z`,
      };
      const event = publicEvent(
        `event_disconnect-${String(index)}`, 'agent.run.activity.changed',
        { agentRunId: RUN_IDS[0], activityGeneration: generation, previous, current },
        current.observedAt,
      );
      events.push(event);
      owners.events.set(event.eventId, {
        ...baseFacts(event, 0, { activityGeneration: generation }),
        kind: 'agent.run.activity.changed',
        occurrenceKind: 'run-disconnected',
        occurrence: { previous, current } as never,
      });
      const evaluated = await supervision.evaluateEvent(runtimeContext(), { event });
      assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
      if (evaluated.ok) assert.equal(evaluated.value.length, 2);
    }
    const replay = await supervision.evaluateEvent(runtimeContext(), { event: events[0]! });
    assert.deepEqual(replay, b3ok([]));

    const detachPayload = {
      agentRunId: RUN_IDS[0], activityGeneration: 4,
      previous: {
        activity: 'idle', activityGeneration: 3, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:02:20.000Z',
      },
      current: {
        activity: 'idle', activityGeneration: 4, uncertaintyCodes: [],
        observedAt: '2026-08-04T00:02:21.000Z',
      },
    };
    const detach = publicEvent(
      'event_controller-detach', 'agent.run.activity.changed', detachPayload,
      '2026-08-04T00:02:21.000Z',
    );
    owners.events.set(detach.eventId, {
      ...baseFacts(detach, 0, { activityGeneration: 4 }),
      kind: 'agent.run.activity.changed',
      occurrenceKind: 'run-disconnected',
      occurrence: { previous: detachPayload.previous, current: detachPayload.current } as never,
    });
    const ignored = await supervision.evaluateEvent(runtimeContext(), { event: detach });
    assert.deepEqual(ignored, b3ok([]));
    const stored = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(stored.ok, true);
    if (stored.ok) {
      for (const rule of [agentRule, childrenRule]) {
        const rows: readonly Notification[] = stored.value.items.filter(
          (item: Notification) => item.watchRuleId === rule.id,
        );
        assert.equal(rows.length, 2);
        assert.notEqual(rows[0]!.id, rows[1]!.id);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #26: child help enforces direct-child semantics for all three subjects', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lifecycle-help-'));
  try {
    const owners: LifecycleOwners = { events: new Map(), related: true };
    const supervision = compose(root, owners);
    const rules = [
      await createRule(
        supervision, { kind: 'agent', agentId: PARENT_AGENT_ID }, { kind: 'child-needs-help' },
      ),
      await createRule(
        supervision, { kind: 'agent-run', agentRunId: PARENT_RUN_ID },
        { kind: 'child-needs-help' },
      ),
      await createRule(
        supervision, { kind: 'children-of', agentId: PARENT_AGENT_ID },
        { kind: 'child-needs-help' },
      ),
    ];
    for (let index = 0; index < 2; index += 1) {
      const payload = {
        agentRunId: RUN_IDS[0], reason: `help-${String(index)}`,
        evidenceRefs: [`event_help-evidence-${String(index)}`],
      };
      const event = publicEvent(
        `event_child-help-${String(index)}`, 'runtime.recovery.required', payload,
        `2026-08-04T00:03:0${String(index)}.000Z`,
      );
      owners.events.set(event.eventId, {
        ...baseFacts(event, 0, { lifecycle: 'recovery-required' }),
        kind: 'runtime.recovery.required',
        occurrenceKind: 'child-needs-help',
        occurrence: { recoveryReason: payload.reason, evidenceRefs: payload.evidenceRefs },
      });
      const evaluated = await supervision.evaluateEvent(runtimeContext(), { event });
      assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
      if (evaluated.ok) assert.equal(evaluated.value.length, 3);
    }
    owners.related = false;
    const unrelatedPayload = {
      agentRunId: RUN_IDS[0], reason: 'not a child', evidenceRefs: ['event_unrelated'],
    };
    const unrelated = publicEvent(
      'event_child-help-unrelated', 'runtime.recovery.required', unrelatedPayload,
      '2026-08-04T00:03:10.000Z',
    );
    owners.events.set(unrelated.eventId, {
      ...baseFacts(unrelated, 0, { lifecycle: 'recovery-required' }),
      kind: 'runtime.recovery.required',
      occurrenceKind: 'child-needs-help',
      occurrence: { recoveryReason: unrelatedPayload.reason, evidenceRefs: unrelatedPayload.evidenceRefs },
    });
    const ignored = await supervision.evaluateEvent(runtimeContext(), { event: unrelated });
    assert.deepEqual(ignored, b3ok([]));
    const stored = await supervision.listNotifications(HUMAN, { limit: 30 });
    assert.equal(stored.ok, true);
    if (stored.ok) {
      for (const rule of rules) {
        assert.equal(stored.value.items.filter((item) => item.watchRuleId === rule.id).length, 2);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #27: operation failure collapses stages and distinguishes operations', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lifecycle-operation-'));
  try {
    const owners: LifecycleOwners = { events: new Map(), related: true };
    const supervision = compose(root, owners);
    const rules = [
      await createRule(
        supervision, { kind: 'agent', agentId: CHILD_AGENT_ID }, { kind: 'operation-failed' },
      ),
      await createRule(
        supervision, { kind: 'agent-run', agentRunId: RUN_IDS[0] as never },
        { kind: 'operation-failed' },
      ),
      await createRule(
        supervision, { kind: 'children-of', agentId: PARENT_AGENT_ID },
        { kind: 'operation-failed' },
      ),
    ];
    const operations = [
      `runOperation_${'a'.repeat(52)}`,
      `runOperation_${'b'.repeat(52)}`,
    ];
    for (const [operationIndex, operationId] of operations.entries()) {
      const repeats = operationIndex === 0 ? 2 : 1;
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const payload = {
          agentRunId: RUN_IDS[0], operationId,
          stage: repeat === 0 ? 'recovery-required' : 'compensating',
          reason: `operation-${String(operationIndex)}`,
        };
        const event = publicEvent(
          `event_operation-${String(operationIndex)}-${String(repeat)}`,
          'agent.run.operation.stage.changed', payload,
          `2026-08-04T00:04:${String(operationIndex)}${String(repeat)}.000Z`,
        );
        owners.events.set(event.eventId, {
          ...baseFacts(event, 0, { activityGeneration: 7 }),
          kind: 'agent.run.operation.stage.changed',
          occurrenceKind: 'operation-failed',
          occurrence: {
            runOperationId: operationId as never,
            terminalState: 'recovery-required',
            reason: payload.reason,
          },
        });
        const evaluated = await supervision.evaluateEvent(runtimeContext(), { event });
        assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
        if (evaluated.ok) assert.equal(evaluated.value.length, repeat === 0 ? 3 : 0);
      }
    }
    const stored = await supervision.listNotifications(HUMAN, { limit: 30 });
    assert.equal(stored.ok, true);
    if (stored.ok) {
      for (const rule of rules) {
        const rows: readonly Notification[] = stored.value.items.filter(
          (item: Notification) => item.watchRuleId === rule.id,
        );
        assert.equal(rows.length, 2);
        assert.notEqual(rows[0]!.id, rows[1]!.id);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #11/#41: L and occurrence-aware rows reject caller/owner disagreement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lifecycle-mismatch-'));
  try {
    const owners: LifecycleOwners = { events: new Map(), related: true };
    const supervision = compose(root, owners);
    await createRule(
      supervision, { kind: 'agent-run', agentRunId: RUN_IDS[0] as never }, { kind: 'run-final' },
    );
    const caller = publicEvent(
      'event_l-mismatch', 'agent.run.lifecycle.changed',
      { agentRunId: RUN_IDS[0], toLifecycle: 'stopped', activityGeneration: 13 },
      '2026-08-04T00:05:00.000Z',
    );
    const ownerPayload = {
      agentRunId: RUN_IDS[0], toLifecycle: 'stopped', activityGeneration: 12,
    };
    owners.events.set(caller.eventId, {
      ...baseFacts({ ...caller, payload: ownerPayload }, 0, {
        lifecycle: 'stopped', final: true, activityGeneration: 12,
      }),
      kind: 'agent.run.lifecycle.changed',
      occurrenceKind: 'run-final',
      occurrence: { toLifecycle: 'stopped' },
    });
    const rejected = await supervision.evaluateEvent(runtimeContext(), { event: caller });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'RecoveryRequired');
      assert.equal(rejected.error.details['stage'], 'occurrence-derivation');
      assert.equal(isWatchEvaluationId(rejected.error.details['operationId']), true);
    }
    const stored = await supervision.listNotifications(HUMAN, { limit: 10 });
    assert.equal(stored.ok, true);
    if (stored.ok) assert.equal(stored.value.items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
