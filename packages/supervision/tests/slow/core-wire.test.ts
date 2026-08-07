// The B3d TRACER's thin live path, at the capability boundary.
//
// One current, end to end, through the FROZEN contract and nothing else:
// install role watchers at spawn → a deadline ARMS → an ordinary committed
// event FIRES it → a Notification QUEUES → a reader can see it.
//
// Every record this produces is handed back to the frozen runtime parsers. A
// core that writes a record its own contract refuses is not wired to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, canonicalRequestHash, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type B3Result, type EventCursor,
  type ResolvedLaunchPlanId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  IDLE_WATCH_TEMPLATE, composeSupervision, createSupervisionStore, templateDigest,
  type SupervisionCore, type SupervisionStore,
} from '../../core/index.js';
import {
  parseNotificationRecord, parseWatchDeadline, parseWatchRule,
  subjectKey as subjectKeyOf,
  type PublicEvent, type RunOccurrenceEventFacts, type WatcherTemplate,
} from '../../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as AgentRunId;
const PLAN_ID = 'launchPlan_019fd000-0000-7000-8000-0000000000a2' as ResolvedLaunchPlanId;
const INSTALL_TRACE_ID = 'trace_123e4567-e89b-42d3-a456-426614174000' as never;
const INSTALL_CLIENT_OP_ID = 'op_123e4567-e89b-42d3-a456-426614174000' as never;

const runtimeContext = (
  clientOpId = INSTALL_CLIENT_OP_ID,
): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId,
  traceId: INSTALL_TRACE_ID,
  contractVersion: 1,
});

const human: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

/** An ordinary committed Runtime event — the same envelope §15 publishes. */
function committedEvent(occurredAt: string, sequence: number): PublicEvent<
  string, Readonly<Record<string, unknown>>
> {
  return {
    eventId: `event_tracer_${String(sequence)}`,
    kind: 'agent.run.lifecycle.changed',
    schemaVersion: 1,
    occurredAt: occurredAt as never,
    committedAt: occurredAt as never,
    sourceOwner: 'agent-runtime',
    traceId: mintTraceCorrelationId(),
    cursor: `tracer.${String(sequence)}` as EventCursor,
    payload: { agentRunId: RUN_ID, toLifecycle: 'ready' },
  };
}

interface Rig {
  readonly supervision: SupervisionCore;
  readonly store: SupervisionStore;
  readonly root: string;
  readonly startedAt: string;
  close(): void;
}

function createRig(
  startedAt: string,
  activityDrift: 'required' | 'disabled-explicitly' = 'disabled-explicitly',
  requiredTemplateRefs = [IDLE_WATCH_TEMPLATE.templateRef],
  options: {
    readonly extraTemplates?: readonly WatcherTemplate[];
    readonly activityGeneration?: () => number;
    readonly watchStartTurnAuthorized?: boolean;
    readonly occurrenceEvents?: ReadonlyMap<string, RunOccurrenceEventFacts>;
  } = {},
): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-core-'));
  const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
  const supervision = composeSupervision({
    root,
    dataRoot: path.join(root, 'stores'),
    clock: () => new Date(startedAt),
    store,
    installAuthority: {
      resolve: async () => b3ok({
        agentRunId: RUN_ID,
        launchPlanId: PLAN_ID,
        activityDrift,
        requiredTemplateRefs,
        parentNotificationMode: 'queue-only',
        recipient: { kind: 'human', principalId: 'person_chris' as never },
        activityGeneration: (options.activityGeneration?.() ?? 4) as never,
        watchStartTurnAuthorized: options.watchStartTurnAuthorized
          ?? activityDrift === 'required',
        requestProvenance: {
          requestedBy: 'person_chris' as never,
          traceId: INSTALL.requestProvenance.traceId,
        },
      }),
    },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    ...(options.occurrenceEvents === undefined ? {} : {
      usage: {
        runs: {
          getUsageRun: async () => b3ok(null as never),
          listUsageRuns: async () => b3ok([]),
          resolveUsageRunByProviderSession: async () => b3ok(null),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async (_principal: AuthenticatedPrincipal, eventId: string) =>
            b3ok(options.occurrenceEvents!.get(eventId) ?? null),
        },
        evidence: {
          getProviderUsageEvidence: async () => b3ok(null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    }),
    ...(options.extraTemplates === undefined ? {} : { extraTemplates: options.extraTemplates }),
  });
  return {
    supervision, store, root, startedAt,
    close: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function lifecycleFacts(
  event: PublicEvent<string, Readonly<Record<string, unknown>>>,
  occurrenceKind: 'run-final' | 'run-disconnected',
): RunOccurrenceEventFacts {
  const generation = event.payload['activityGeneration'] as never;
  const base = {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    committedAt: event.committedAt,
    sourceOwner: 'agent-runtime' as const,
    agentRunId: RUN_ID,
    agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
    providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174000' as never,
    lifecycle: occurrenceKind === 'run-final' ? 'stopped' as const : 'ready' as const,
    final: occurrenceKind === 'run-final',
    activityGeneration: generation,
    recordVersion: 1 as never,
    canonicalPayloadDigest: canonicalRequestHash(event.payload),
  };
  if (occurrenceKind === 'run-final') {
    return {
      ...base,
      kind: 'agent.run.lifecycle.changed',
      occurrenceKind,
      occurrence: { toLifecycle: 'stopped' },
    };
  }
  return {
    ...base,
    kind: 'agent.run.activity.changed',
    occurrenceKind,
    occurrence: {
      previous: event.payload['previous'], current: event.payload['current'],
    },
  } as RunOccurrenceEventFacts;
}

/**
 * FREEZE-DEFECT-1 (reported, not adjudicated here).
 *
 * The frozen `recordEnvelope` validator requires `lastMutation.clientOpId` to
 * be `op_<uuidv4>`. Foundation's ratified §3.2 saga-effect helper
 * `deriveClientOpId` deliberately mints a NAME-derived uuid with version
 * nibble 5 ("claiming version 4 would assert entropy that is deliberately
 * absent"), and transcript, agents and the server run-ports already write
 * records through it. So every record a §3.2-conforming writer commits is
 * refused by its own frozen output parser.
 *
 * The assertion below is a SUBSET check, not an equality: it holds today, it
 * still holds the moment the freeze is amended, and it fails the instant a
 * record grows any violation that is not this one.
 */
const REPORTED_FREEZE_DEFECTS = new Set(['lastMutation.clientOpId']);

function assertContractShaped(parsed: B3Result<unknown>, what: string): void {
  if (parsed.ok) return;
  const issues = (parsed.error.details as {
    issues?: readonly { readonly path: string }[];
  }).issues ?? [];
  assert.notEqual(issues.length, 0, `${what} failed its frozen parser without saying why`);
  for (const issue of issues) {
    assert.equal(REPORTED_FREEZE_DEFECTS.has(issue.path), true,
      `${what} violates its own frozen contract at ${issue.path}`);
  }
}

/** The same store, with one record's update broken — a crash a reducer cannot see. */
function refusingUpdatesTo(store: SupervisionStore, objectId: string): SupervisionStore {
  return {
    ...store,
    update: async (principal, targetId, patch, expectedVersion, clientOpId) => (
      targetId === objectId
        ? b3fail(b3err('StoreUnavailable', 'the process died mid-write', {}, true))
        : store.update(principal, targetId, patch, expectedVersion, clientOpId)
    ),
  };
}

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const INSTALL = {
  agentRunId: RUN_ID,
  launchPlanId: PLAN_ID,
  requiredTemplateRefs: [IDLE_WATCH_TEMPLATE.templateRef],
  recipient: { kind: 'human', principalId: 'person_chris' as never },
  activityGeneration: 4 as never,
  requestProvenance: {
    requestedBy: 'person_chris' as never,
    traceId: INSTALL_TRACE_ID,
    clientOpId: INSTALL_CLIENT_OP_ID,
  },
} as const;

const START_TURN_PAYLOAD = {
  id: 'watch-template/start-turn-explicit',
  version: 1,
  status: 'active',
  subjectBinding: 'current-run',
  condition: { kind: 'idle-for-ms', value: 300_000 },
  recipientBinding: 'current-supervision-assignment-for-escalation',
  deliveryBinding: 'start-turn',
  cooldownMs: 0,
} as const;
const START_TURN_TEMPLATE: WatcherTemplate = {
  templateRef: {
    id: START_TURN_PAYLOAD.id,
    version: START_TURN_PAYLOAD.version,
    digest: templateDigest(START_TURN_PAYLOAD),
  },
  payload: START_TURN_PAYLOAD,
};
const SECOND_IDLE_PAYLOAD = {
  ...START_TURN_PAYLOAD,
  id: 'watch-template/second-idle',
  deliveryBinding: 'queue-only',
} as const;
const SECOND_IDLE_TEMPLATE: WatcherTemplate = {
  templateRef: {
    id: SECOND_IDLE_PAYLOAD.id,
    version: SECOND_IDLE_PAYLOAD.version,
    digest: templateDigest(SECOND_IDLE_PAYLOAD),
  },
  payload: SECOND_IDLE_PAYLOAD,
};

test('installRunWatchers materialises the pinned role watcher and arms its deadline', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const rules = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL),
      'installRunWatchers',
    );
    assert.equal(rules.length, 1, 'one pinned template must install exactly one rule');
    const rule = rules[0]!;
    assertContractShaped(parseWatchRule(rule), 'the installed WatchRule');
    assert.deepEqual(rule.subject, { kind: 'agent-run', agentRunId: RUN_ID });
    assert.deepEqual(rule.condition, IDLE_WATCH_TEMPLATE.payload.condition);
    assert.deepEqual(rule.recipient, INSTALL.recipient);
    assert.equal(rule.createdBy, 'sys_supervision');
    assert.equal(rule.installation?.launchPlanId, PLAN_ID);
    assert.deepEqual(rule.installation?.templateRef, IDLE_WATCH_TEMPLATE.templateRef);
    assert.equal(rule.installation?.activityGeneration, INSTALL.activityGeneration);
    assert.equal(rule.installation?.requestedBy, 'person_chris');
    assert.equal(rule.status, 'active');

    const deadlines = unwrap(await rig.supervision.listWatchDeadlines(human), 'listWatchDeadlines');
    assert.equal(deadlines.length, 1, 'installing a timed watcher must arm exactly one deadline');
    const deadline = deadlines[0]!;
    assertContractShaped(
      parseWatchDeadline(deadline, { conditionKind: rule.condition.kind }),
      'the armed WatchDeadline',
    );
    assert.equal(deadline.state, 'armed');
    assert.equal(deadline.watchRuleId, rule.id);
    assert.equal(deadline.activityGeneration, INSTALL.activityGeneration);
    assert.equal(deadline.createdBy, 'sys_supervision');
    assert.equal(deadline.subjectKey, subjectKeyOf(rule.subject));
    assert.equal(deadline.dueAt, '2026-08-03T00:05:00.000Z',
      'the deadline is armed one idle window after install');
  } finally {
    rig.close();
  }
});

test('required activity drift is injected beside explicit launch-plan refs', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z', 'required');
  try {
    const rules = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'install with drift',
    );
    assert.deepEqual(rules.map((rule) => rule.condition.kind), ['activity-drift', 'idle-for-ms']);
    const driftRule = rules[0]!;
    const deadlines = unwrap(
      await rig.supervision.listWatchDeadlines(human), 'activity-drift deadline',
    );
    const deadline = deadlines.find((item) => item.watchRuleId === driftRule.id);
    assert.ok(deadline, 'required activity drift must be armed at spawn');
    assert.equal(deadline.dueAt, '2026-08-03T00:05:00.000Z');
    assert.deepEqual(deadline.driftState, {
      kind: 'activity-drift',
      episodeOrdinal: 0,
      phase: 'observing',
      quietIntervals: 0,
      consecutiveUnansweredChecks: 0,
    });
    assertContractShaped(
      parseWatchDeadline(deadline, { conditionKind: 'activity-drift' }),
      'the armed activity-drift deadline',
    );
  } finally {
    rig.close();
  }
});

test('an explicit start-turn template is refused without launch-plan authority', async () => {
  const rig = createRig(
    '2026-08-03T00:00:00.000Z',
    'disabled-explicitly',
    [START_TURN_TEMPLATE.templateRef],
    { extraTemplates: [START_TURN_TEMPLATE], watchStartTurnAuthorized: false },
  );
  try {
    const refused = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL, requiredTemplateRefs: [START_TURN_TEMPLATE.templateRef],
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
    assert.deepEqual(unwrap(await rig.store.list('watchRule'), 'stored rules'), []);
  } finally {
    rig.close();
  }
});

test('install provenance must match Runtime-owned launch attribution', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const refused = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requestProvenance: { ...INSTALL.requestProvenance, requestedBy: 'person_eve' as never },
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  } finally {
    rig.close();
  }
});

test('the composed install boundary rejects malformed provenance before effects', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const refused = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requestProvenance: { ...INSTALL.requestProvenance, clientOpId: 'op_not-a-uuid' as never },
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'ValidationFailed');
    assert.deepEqual(unwrap(await rig.store.list('watchRule'), 'stored rules'), []);
  } finally {
    rig.close();
  }
});

test('a lost install response adopts the complete prior effect after generation advances', async () => {
  let generation = 4;
  const rig = createRig(
    '2026-08-03T00:00:00.000Z', 'disabled-explicitly',
    [IDLE_WATCH_TEMPLATE.templateRef], { activityGeneration: () => generation },
  );
  try {
    const first = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'first install',
    );
    generation = 5;
    const replay = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'lost-response replay',
    );
    assert.deepEqual(replay.map((rule) => rule.id), first.map((rule) => rule.id));
  } finally {
    rig.close();
  }
});

test('a partial install at a stale generation fails closed instead of mixing generations', async () => {
  const rig = createRig(
    '2026-08-03T00:00:00.000Z', 'disabled-explicitly',
    [IDLE_WATCH_TEMPLATE.templateRef], { extraTemplates: [SECOND_IDLE_TEMPLATE] },
  );
  try {
    unwrap(await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'first partial');
    const current = composeSupervision({
      root: rig.root,
      dataRoot: path.join(rig.root, 'stores'),
      store: rig.store,
      extraTemplates: [SECOND_IDLE_TEMPLATE],
      installAuthority: {
        resolve: async () => b3ok({
          agentRunId: RUN_ID,
          launchPlanId: PLAN_ID,
          activityDrift: 'disabled-explicitly',
          requiredTemplateRefs: [IDLE_WATCH_TEMPLATE.templateRef, SECOND_IDLE_TEMPLATE.templateRef],
          parentNotificationMode: 'queue-only',
          recipient: INSTALL.recipient,
          activityGeneration: 5 as never,
          watchStartTurnAuthorized: false,
          requestProvenance: {
            requestedBy: INSTALL.requestProvenance.requestedBy,
            traceId: INSTALL.requestProvenance.traceId,
          },
        }),
      },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    });
    const retried = await current.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requiredTemplateRefs: [IDLE_WATCH_TEMPLATE.templateRef, SECOND_IDLE_TEMPLATE.templateRef],
    });
    assert.equal(retried.ok, false, 'stale retry created a mixed-generation watcher set');
    if (!retried.ok) assert.equal(retried.error.code, 'IdempotencyConflict');
    const rules = unwrap(await rig.store.list('watchRule'), 'stored rules');
    assert.equal(rules.length, 1, 'stale recovery wrote a missing rule at another generation');
  } finally {
    rig.close();
  }
});

test('re-installing the same launch plan adopts the same rule rather than a twin', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const first = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'first install',
    );
    const second = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'second install',
    );
    assert.deepEqual(second.map((rule) => rule.id), first.map((rule) => rule.id));
    const rules = unwrap(
      await rig.supervision.listWatchRules(human, { limit: 50 }), 'listWatchRules',
    );
    assert.equal(rules.items.length, 1, 'a re-entered spawn installed a duplicate watcher');
  } finally {
    rig.close();
  }
});

test('install rejects caller facts that differ from authoritative plan or generation', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const mismatched = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      activityGeneration: 5 as never,
    });
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.error.code, 'IdempotencyConflict');
    assert.equal((await rig.store.list('watchRule')).ok, true);
    const rules = unwrap(await rig.store.list('watchRule'), 'stored rules');
    assert.equal(rules.length, 0, 'mismatch wrote a WatchRule before it was refused');
  } finally {
    rig.close();
  }
});

test('an event inside the idle window pushes the deadline out and queues nothing', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    await rig.supervision.installRunWatchers(runtimeContext(), INSTALL);
    const queued = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), {
      event: {
        ...committedEvent('2026-08-03T00:01:00.000Z', 1),
        payload: {
          agentRunId: RUN_ID,
          toLifecycle: 'ready',
          activityGeneration: 5,
        },
      },
    }), 'evaluateEvent');
    assert.deepEqual(queued, [], 'a live Run was reported idle');

    const deadlines = unwrap(await rig.supervision.listWatchDeadlines(human), 'listWatchDeadlines');
    assert.equal(deadlines.length, 2);
    const armed = deadlines.find((deadline) => deadline.state === 'armed');
    const superseded = deadlines.find((deadline) => deadline.state === 'superseded');
    assert.equal(armed?.dueAt, '2026-08-03T00:06:00.000Z',
      'observed activity did not re-arm the idle deadline');
    assert.equal(armed?.activityGeneration, 5);
    assert.equal(armed?.armingOrdinal, 0);
    assert.equal(armed?.creationRecordVersion, 1);
    assert.equal(superseded?.activityGeneration, 4);
  } finally {
    rig.close();
  }
});

test('an event past the deadline fires it and queues one Notification, starting no turn', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const rules = unwrap(
      await rig.supervision.installRunWatchers(runtimeContext(), INSTALL), 'install',
    );
    const outcome = await rig.supervision.evaluateEvent(runtimeContext(), {
      event: committedEvent('2026-08-03T00:07:00.000Z', 2),
    });
    const queued = unwrap(outcome, 'evaluateEvent');
    assert.equal(queued.length, 1, 'a due idle deadline queued no notification');
    const notification = queued[0]!;
    assertContractShaped(parseNotificationRecord(notification), 'the queued Notification');
    assert.equal(notification.createdBy, 'sys_supervision',
      'an autonomous Notification claimed the event source as its creator');
    assert.equal(notification.state, 'queued');
    assert.equal(notification.phase, 'condition');
    assert.equal(notification.deliveryAttempt.state, 'queued');
    assert.equal(notification.watchRuleId, rules[0]!.id);
    assert.deepEqual(notification.recipient, { kind: 'human', principalId: 'person_chris' });

    const deadlines = unwrap(await rig.supervision.listWatchDeadlines(human), 'listWatchDeadlines');
    assert.equal(deadlines[0]!.state, 'fired');
  } finally {
    rig.close();
  }
});

test('same command replays its result; a new operation adopts without a second Notification', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    await rig.supervision.installRunWatchers(runtimeContext(), INSTALL);
    const event = committedEvent('2026-08-03T00:07:00.000Z', 3);
    const first = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'first');
    const again = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'replay');
    const redelivery = unwrap(await rig.supervision.evaluateEvent(runtimeContext(
      'op_123e4567-e89b-42d3-a456-426614174091' as never,
    ), { event }), 'new-operation redelivery');
    assert.equal(first.length, 1);
    assert.deepEqual(again, first, 'same receipt did not replay its stored result');
    assert.deepEqual(redelivery, [], 'at-least-once delivery produced a second Notification');

    const page = unwrap(
      await rig.supervision.listNotifications(human, { limit: 50 }), 'listNotifications',
    );
    assert.equal(page.items.length, 1, 'the durable store holds a duplicate Notification');
    assert.equal(page.items[0]!.id, first[0]!.id);
  } finally {
    rig.close();
  }
});

test('ordinary event evaluation never fires an activity-drift deadline', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z', 'required', []);
  try {
    await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requiredTemplateRefs: [],
    });
    const queued = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), {
      event: committedEvent('2026-08-03T00:07:00.000Z', 4),
    }), 'evaluateEvent');
    assert.deepEqual(queued, [], 'generic event evaluation bypassed checkRunDrift');

    const deadlines = unwrap(await rig.supervision.listWatchDeadlines(human), 'deadlines');
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0]!.state, 'armed');
    assert.equal(deadlines[0]!.driftState?.phase, 'observing');
  } finally {
    rig.close();
  }
});

test('manual event watcher creation does not invent or require a generation', async () => {
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    const created = unwrap(await rig.supervision.createWatchRule({
      principal: human,
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174010' as never,
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174010' as never,
      contractVersion: 1,
    }, {
      subject: { kind: 'agent-run', agentRunId: RUN_ID },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    }), 'createWatchRule');
    assert.equal(created.condition.kind, 'run-final');
    assert.equal(unwrap(await rig.store.list('watchDeadline'), 'deadlines').length, 0);
  } finally {
    rig.close();
  }
});

test('a run-final lifecycle event queues one Notification under replay', async () => {
  const occurrenceEvents = new Map<string, RunOccurrenceEventFacts>();
  const rig = createRig('2026-08-03T00:00:00.000Z', 'disabled-explicitly',
    [IDLE_WATCH_TEMPLATE.templateRef], { occurrenceEvents });
  try {
    const rule = unwrap(await rig.supervision.createWatchRule({
      principal: human,
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174011' as never,
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174011' as never,
      contractVersion: 1,
    }, {
      subject: { kind: 'agent-run', agentRunId: RUN_ID },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    }), 'create run-final watcher');
    const event = {
      ...committedEvent('2026-08-03T00:01:00.000Z', 10),
      payload: {
        agentRunId: RUN_ID,
        toLifecycle: 'stopped',
        activityGeneration: 4,
      },
    };
    occurrenceEvents.set(event.eventId, lifecycleFacts(event, 'run-final'));

    const first = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'first');
    const replay = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'replay');
    const redelivery = unwrap(await rig.supervision.evaluateEvent(runtimeContext(
      'op_123e4567-e89b-42d3-a456-426614174092' as never,
    ), { event }), 'new-operation redelivery');

    assert.equal(first.length, 1);
    assert.equal(first[0]!.watchRuleId, rule.id);
    assert.equal(first[0]!.conditionGeneration, 4);
    assert.deepEqual(replay, first);
    assert.deepEqual(redelivery, []);
  } finally {
    rig.close();
  }
});

test('a run-final Notification survives restart and absorbs transition redelivery', async () => {
  const occurrenceEvents = new Map<string, RunOccurrenceEventFacts>();
  const rig = createRig('2026-08-03T00:00:00.000Z', 'disabled-explicitly',
    [IDLE_WATCH_TEMPLATE.templateRef], { occurrenceEvents });
  try {
    const rule = unwrap(await rig.supervision.createWatchRule({
      principal: human,
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174013' as never,
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174013' as never,
      contractVersion: 1,
    }, {
      subject: { kind: 'agent-run', agentRunId: RUN_ID },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    }), 'create restart-safe run-final watcher');
    const transition = {
      ...committedEvent('2026-08-03T00:01:00.000Z', 12),
      payload: {
        agentRunId: RUN_ID,
        fromLifecycle: 'ready',
        toLifecycle: 'stopped',
        activityGeneration: 4,
      },
    };
    occurrenceEvents.set(transition.eventId, lifecycleFacts(transition, 'run-final'));
    const first = unwrap(
      await rig.supervision.evaluateEvent(runtimeContext(), { event: transition }),
      'first lifecycle evaluation',
    );
    assert.equal(first.length, 1);

    // A fresh composition owns no in-memory evaluator state. Its only memory is
    // the same durable store a restarted Runtime would reopen.
    const restartedStore = createSupervisionStore({
      root: rig.root,
      dataRoot: path.join(rig.root, 'stores'),
    });
    const restarted = composeSupervision({
      root: rig.root,
      dataRoot: path.join(rig.root, 'stores'),
      store: restartedStore,
      installAuthority: {
        resolve: async () => b3ok({
          agentRunId: RUN_ID,
          launchPlanId: PLAN_ID,
          activityDrift: 'disabled-explicitly' as const,
          requiredTemplateRefs: [IDLE_WATCH_TEMPLATE.templateRef],
          parentNotificationMode: 'queue-only' as const,
          recipient: { kind: 'human' as const, principalId: 'person_chris' as never },
          activityGeneration: 4 as never,
          watchStartTurnAuthorized: false,
          requestProvenance: {
            requestedBy: 'person_chris' as never,
            traceId: INSTALL_TRACE_ID,
          },
        }),
      },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      usage: {
        runs: {
          getUsageRun: async () => b3ok(null as never),
          listUsageRuns: async () => b3ok([]),
          resolveUsageRunByProviderSession: async () => b3ok(null),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async (_principal, eventId) => b3ok(
            occurrenceEvents.get(eventId) ?? null,
          ),
        },
        evidence: {
          getProviderUsageEvidence: async () => b3ok(null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const beforeReplay = unwrap(
      await restarted.listNotifications(human, { limit: 50 }),
      'restart read',
    );
    assert.equal(beforeReplay.items.length, 1);
    assert.equal(beforeReplay.items[0]!.watchRuleId, rule.id);

    const redelivery = {
      ...transition,
      eventId: 'event_tracer_13',
      cursor: 'tracer.13' as EventCursor,
    };
    occurrenceEvents.set(redelivery.eventId, lifecycleFacts(redelivery, 'run-final'));
    const replay = unwrap(
      await restarted.evaluateEvent(runtimeContext(
        'op_123e4567-e89b-42d3-a456-426614174093' as never,
      ), { event: redelivery }),
      'transition redelivery after restart',
    );
    assert.deepEqual(replay, []);
    const afterReplay = unwrap(
      await restarted.listNotifications(human, { limit: 50 }),
      'post-replay read',
    );
    assert.equal(afterReplay.items.length, 1);
    assert.equal(afterReplay.items[0]!.id, beforeReplay.items[0]!.id);
  } finally {
    rig.close();
  }
});

test('a new provider-liveness loss generation queues one run-disconnected Notification', async () => {
  const occurrenceEvents = new Map<string, RunOccurrenceEventFacts>();
  const rig = createRig('2026-08-03T00:00:00.000Z', 'disabled-explicitly',
    [IDLE_WATCH_TEMPLATE.templateRef], { occurrenceEvents });
  try {
    const rule = unwrap(await rig.supervision.createWatchRule({
      principal: human,
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174012' as never,
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174012' as never,
      contractVersion: 1,
    }, {
      subject: { kind: 'agent-run', agentRunId: RUN_ID },
      condition: { kind: 'run-disconnected' },
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    }), 'create run-disconnected watcher');
    const event = {
      ...committedEvent('2026-08-03T00:01:00.000Z', 11),
      kind: 'agent.run.activity.changed',
      payload: {
        agentRunId: RUN_ID,
        activityGeneration: 5,
        previous: {
          activity: 'idle',
          activityGeneration: 4,
          uncertaintyCodes: [],
          observedAt: '2026-08-03T00:00:59.000Z',
        },
        current: {
          activity: 'unknown',
          activityGeneration: 5,
          uncertaintyCodes: ['provider-liveness-unknown'],
          observedAt: '2026-08-03T00:01:00.000Z',
        },
      },
    };
    occurrenceEvents.set(event.eventId, lifecycleFacts(event, 'run-disconnected'));

    const first = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'first');
    const replay = unwrap(await rig.supervision.evaluateEvent(runtimeContext(), { event }), 'replay');
    const redelivery = unwrap(await rig.supervision.evaluateEvent(runtimeContext(
      'op_123e4567-e89b-42d3-a456-426614174094' as never,
    ), { event }), 'new-operation redelivery');

    assert.equal(first.length, 1);
    assert.equal(first[0]!.watchRuleId, rule.id);
    assert.equal(first[0]!.conditionGeneration, 5);
    assert.deepEqual(replay, first);
    assert.deepEqual(redelivery, []);
  } finally {
    rig.close();
  }
});

test('an unknown template ref is refused rather than silently skipped', async () => {
  const unknown = { id: 'watch-template/not-a-template', version: 1, digest: 'x' };
  const rig = createRig('2026-08-03T00:00:00.000Z', 'disabled-explicitly', [unknown]);
  try {
    const refused = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requiredTemplateRefs: [unknown],
    });
    assert.equal(refused.ok, false, 'a watcher nobody can resolve installed anyway');
    if (!refused.ok) assert.equal(refused.error.code, 'WatchRuleInvalid');
  } finally {
    rig.close();
  }
});

test('a pinned ref whose digest does not match the catalogue is refused', async () => {
  const mismatched = { ...IDLE_WATCH_TEMPLATE.templateRef, digest: 'f'.repeat(64) };
  const rig = createRig('2026-08-03T00:00:00.000Z', 'disabled-explicitly', [mismatched]);
  try {
    const refused = await rig.supervision.installRunWatchers(runtimeContext(), {
      ...INSTALL,
      requiredTemplateRefs: [mismatched],
    });
    assert.equal(refused.ok, false, 'an unpinned template body installed under a pinned ref');
    if (!refused.ok) assert.equal(refused.error.code, 'WatchRuleInvalid');
  } finally {
    rig.close();
  }
});

test('a Notification is durable before its deadline stops being armed', async () => {
  // Ordering, proved by breaking the second write.
  //
  // Queue-then-fire and fire-then-queue both look identical when nothing goes
  // wrong. They differ exactly once: a crash between the two. Fire-first loses
  // the alert for ever — the deadline is no longer armed, so no replay will
  // ever queue it. Queue-first at worst re-fires a deadline whose Notification
  // already exists, and the deterministic id absorbs that.
  const rig = createRig('2026-08-03T00:00:00.000Z');
  try {
    await rig.supervision.installRunWatchers(runtimeContext(), INSTALL);
    const armed = unwrap(await rig.supervision.listWatchDeadlines(human), 'armed');

    // The same store, with the deadline's own update broken — the crash a
    // reducer cannot distinguish from a dead process.
    const broken = composeSupervision({
      root: rig.root,
      dataRoot: path.join(rig.root, 'stores'),
      clock: () => new Date(rig.startedAt),
      store: refusingUpdatesTo(rig.store, armed[0]!.id),
      installAuthority: {
        resolve: async () => b3fail(b3err(
          'RuntimeUnavailable', 'not used by this reducer proof', {}, true,
        )),
      },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    });
    const outcome = await broken.evaluateEvent(runtimeContext(), {
      event: committedEvent('2026-08-03T00:07:00.000Z', 9),
    });
    assert.equal(outcome.ok, false, 'a failed deadline write was reported as success');

    // The alert survived the crash, and the deadline is still armed, so a
    // replay finishes the job rather than dropping it.
    const page = unwrap(
      await rig.supervision.listNotifications(human, { limit: 50 }), 'listNotifications',
    );
    assert.equal(page.items.length, 1, 'the Notification was lost with the deadline write');
    const after = unwrap(await rig.supervision.listWatchDeadlines(human), 'after');
    assert.equal(after[0]!.state, 'armed',
      'the deadline stopped being armed even though its own write failed');
  } finally {
    rig.close();
  }
});
