// NVK-KIMI-080 — a delivery skip must name its cause, not its bucket.
//
// `submitNextTurn`/`deliverNextTurn` collapsed every pre-reserve branch to
// `null`, and the pump published all of them as one reason,
// `not-deliverable-yet`. A live run held that reason for 90 seconds straight
// while every durable precondition anyone could name was true: the turn was
// completion-committed, the lease free, the session durable-live, the Run
// ready/idle at generation 3 against a fence of 1, the controller draft empty,
// no other reservation held and the notification unfenced. The block was real
// and unnameable — which is the defect, because a skip nobody can attribute
// costs a whole run to re-derive.
//
// Every branch is driven here against the real worker and the real pump, and
// each one must publish the sub-reason it actually took plus the values it saw.
// The last case is the control: a pass that DELIVERS must still say nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b3err, b3fail, b3ok, notificationInputReservationId,
  type B3Result,
} from '@novakai/foundation/contract';
import type { Notification } from '../../../supervision/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type { AgentRunsContract, ProviderPort } from '../../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import {
  createNotificationDeliveryPump, type NotificationDeliveryPumpOptions,
} from '../../core/b3/notification-delivery-pump.js';

const RUN_ID = 'agentrun_01960000000000000000000080';
const SESSION_ID = 'terminalsession_01960000000000000000000080';
const EFFECT_KEY = 'notification-delivery/nvk080';
const RESERVATION_ID = notificationInputReservationId(EFFECT_KEY);

/** A v1 `next-turn-context` Notification sitting in `queued`. */
function queued(overrides: Partial<Record<string, unknown>> = {}): Notification {
  return {
    id: 'notification_01960000000000000000000080',
    kind: 'notification',
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: '2026-08-05T00:00:00.000Z',
    permissionLevel: 'system',
    createdBy: 'sys_supervision',
    lastMutation: {
      at: '2026-08-05T00:00:00.000Z', by: 'sys_supervision',
      clientOpId: 'clientop_01960000000000000000000080', traceId: 'trace_nvk080',
    },
    deliveryEffectKey: EFFECT_KEY,
    deliveryAttempt: { state: 'queued', effectKey: EFFECT_KEY },
    watchRuleId: 'watchrule_01960000000000000000000080',
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    recipient: { kind: 'agent-run', agentRunId: RUN_ID },
    conditionGeneration: 1,
    summary: 'nvk080 delivery diagnostics',
    evidenceRefs: [],
    state: 'queued',
    phase: 'condition',
    deliveryMode: 'next-turn-context',
    ...overrides,
  } as unknown as Notification;
}

interface Scene {
  /** What `getAgentRun` reports about the delivery target. */
  readonly run?: Readonly<Record<string, unknown>>;
  /** What `getTerminalSession` reports about its terminal. */
  readonly session?: Readonly<Record<string, unknown>>;
  /** What `reserveNotificationInput` refuses with, when it refuses. */
  readonly reserveError?: ReturnType<typeof b3err>;
  readonly notification?: Notification;
}

const READY_RUN = {
  id: RUN_ID,
  lifecycle: 'ready',
  activity: 'idle',
  activeProviderTurn: undefined,
  terminalSessionId: SESSION_ID,
  activityGeneration: 3,
};

const LIVE_SESSION = {
  session: { id: SESSION_ID, status: 'live' },
  attachments: [],
  activeInputLease: undefined,
  replay: { earliestSequence: 0, latestSequence: 0 },
  nextInputSequence: 1,
};

interface Published {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function pumpFor(scene: Scene): {
  readonly options: NotificationDeliveryPumpOptions;
  readonly published: Published[];
  readonly reported: string[];
  readonly submitted: string[];
} {
  const published: Published[] = [];
  const reported: string[] = [];
  const submitted: string[] = [];
  const notification = scene.notification ?? queued();

  const supervision = {
    listNotifications: async () => b3ok({ items: [notification] }),
    listWatchDeadlines: async () => b3ok([]),
    claimNotificationDelivery: async () => b3ok({ notification }),
    recordNotificationDeliveryOutcome: async () => b3ok(null),
  } as unknown as SupervisionCore;

  const runs = {
    getAgentRun: async () => b3ok({
      run: scene.run ?? READY_RUN,
      provider: { provider: 'claude' },
    }),
    publishCapabilityEvent: async (
      kind: string, payload: Readonly<Record<string, unknown>>,
    ): Promise<B3Result<null>> => {
      published.push({ kind, payload });
      return b3ok(null);
    },
  } as unknown as AgentRunsContract;

  const terminal = {
    getNotificationInputReservation: async () =>
      b3fail(b3err('ValidationFailed', 'no prior reservation', {}, false)),
    getTerminalSession: async () => b3ok(scene.session ?? LIVE_SESSION),
    reserveNotificationInput: async () => (scene.reserveError === undefined
      ? b3ok({ id: RESERVATION_ID, state: 'reserved' })
      : b3fail(scene.reserveError)),
    commitReservedNotificationInput: async () => b3ok({
      attempt: {
        id: 'terminalinputattempt_01960000000000000000000080',
        source: 'system-notification',
        outcome: 'submitted-confirmed',
        submittedAt: '2026-08-05T00:00:01.000Z',
        providerTurnId: 'providerturn_01960000000000000000000080',
      },
    }),
    cancelReservedNotificationInput: async () => b3ok(null),
  } as unknown as TerminalContract;

  const providers = {
    deliverTurn: (_provider: string, text: string) => {
      submitted.push(text);
      return [{ utf8Text: text }];
    },
  } as unknown as ProviderPort;

  return {
    options: {
      supervision, runs, terminal, providers,
      reportFailure: (message) => { reported.push(message); },
    },
    published,
    reported,
    submitted,
  };
}

/** The one skip event this pass published, or `null`. */
function skipEvent(published: readonly Published[]): Readonly<Record<string, unknown>> | null {
  const found = published.filter(
    (event) => event.kind === 'supervision.notification.delivery-skipped',
  );
  assert.ok(found.length <= 1, `one pass published ${String(found.length)} skip events`);
  return found[0]?.payload ?? null;
}

function refusalEvent(published: readonly Published[]): Readonly<Record<string, unknown>> | null {
  const found = published.filter(
    (event) => event.kind === 'supervision.notification.delivery-refused',
  );
  assert.ok(found.length <= 1, `one pass published ${String(found.length)} refusal events`);
  return found[0]?.payload ?? null;
}

/** Each pre-reserve branch, and the exact sub-reason and values it must publish. */
const SKIPS: readonly {
  readonly name: string;
  readonly scene: Scene;
  readonly reason: string;
  readonly observed: Readonly<Record<string, string>>;
}[] = [
  {
    name: 'a Run that is not ready names its lifecycle',
    scene: { run: { ...READY_RUN, lifecycle: 'starting' } },
    reason: 'run-lifecycle-not-ready',
    observed: { lifecycle: 'starting' },
  },
  {
    name: 'a Run that is not idle names its activity',
    scene: { run: { ...READY_RUN, activity: 'working' } },
    reason: 'run-activity-not-idle',
    observed: { activity: 'working' },
  },
  {
    name: 'a Run holding a provider turn names the turn it is holding',
    scene: {
      run: {
        ...READY_RUN,
        activeProviderTurn: { providerTurnId: 'providerturn_active_080', activityGeneration: 4 },
      },
    },
    reason: 'run-has-active-provider-turn',
    observed: {
      activeProviderTurnId: 'providerturn_active_080',
      activeTurnActivityGeneration: '4',
    },
  },
  {
    name: 'a Run with no terminal says so',
    scene: { run: { ...READY_RUN, terminalSessionId: undefined } },
    reason: 'run-has-no-terminal-session',
    observed: { terminalSessionId: 'none' },
  },
  {
    name: 'a Run behind its delivery fence names both generations',
    scene: { run: { ...READY_RUN, activityGeneration: 1 } },
    reason: 'run-generation-not-past-delivery-fence',
    observed: { runActivityGeneration: '1', deliveryFenceGeneration: '1' },
  },
  {
    name: 'a terminal that is not live names the status it saw',
    scene: { session: { ...LIVE_SESSION, session: { id: SESSION_ID, status: 'ending' } } },
    reason: 'terminal-session-not-live',
    observed: { terminalSessionId: SESSION_ID, terminalSessionStatus: 'ending' },
  },
  {
    name: 'a held input lease names its generation and holder',
    scene: {
      session: {
        ...LIVE_SESSION,
        activeInputLease: {
          id: 'terminalinputlease_080', generation: 7, state: 'active',
          attachmentId: 'controllerattachment_080',
        },
      },
    },
    reason: 'terminal-input-lease-held',
    observed: {
      terminalSessionId: SESSION_ID,
      leaseId: 'terminalinputlease_080',
      leaseGeneration: '7',
      leaseState: 'active',
      holderAttachmentId: 'controllerattachment_080',
    },
  },
  {
    name: 'a queue-only Notification says it is queue-only',
    scene: { notification: queued({ deliveryMode: 'queue-only' }) },
    reason: 'notification-is-queue-only',
    observed: { deliveryMode: 'queue-only' },
  },
];

for (const branch of SKIPS) {
  test(`delivery skip: ${branch.name}`, async () => {
    const rig = pumpFor(branch.scene);
    const pump = createNotificationDeliveryPump(rig.options);
    const pass = await pump.deliverOnce();
    await pump.stop();

    assert.equal(pass.delivered, 0, 'this branch must not deliver');
    assert.deepEqual(pass.failures, [], 'a skip is not a failure');

    const event = skipEvent(rig.published);
    assert.notEqual(event, null, 'the skip published no event at all');
    assert.equal(event!.reason, branch.reason,
      `the skip published '${String(event!.reason)}' instead of its own sub-reason`);
    assert.notEqual(event!.reason, 'not-deliverable-yet',
      'the skip is still publishing the bucket');
    for (const [key, value] of Object.entries(branch.observed)) {
      assert.equal(
        (event!.observed as Record<string, string> | undefined)?.[key], value,
        `the snapshot did not carry ${key}; got ${JSON.stringify(event!.observed)}`,
      );
    }
    assert.equal(
      rig.reported.some((line) => line.includes(branch.reason)), true,
      `the console channel did not name the sub-reason; got ${JSON.stringify(rig.reported)}`,
    );
  });
}

// The two reserve refusals whose CODE names a symptom several innocent causes
// share. Both mean Terminal's in-memory registry and its own durable records
// disagree about one session — the prime suspect behind the live 90-second
// skip, and the thing the bucket could never have said.
const SPLITS: readonly {
  readonly name: string;
  readonly error: ReturnType<typeof b3err>;
  readonly code: string;
  readonly reason: string;
  readonly observed: Readonly<Record<string, string>>;
}[] = [
  {
    name: 'the live registry has no entry while the durable session says live',
    error: b3err('TerminalNotLive', 'the terminal has no live process', {
      terminalSessionId: SESSION_ID, status: 'live',
    }, false),
    code: 'TerminalNotLive',
    reason: 'terminal-live-registry-missing-while-durable-session-live',
    observed: {
      terminalSessionId: SESSION_ID,
      durableSessionStatus: 'live',
      inMemoryLiveEntry: 'absent',
    },
  },
  {
    name: 'the live registry holds a turn the durable store does not',
    error: b3err('InputLeaseBusy', 'the terminal input boundary is fenced', {
      reason: 'provider-turn-active',
    }, true),
    code: 'InputLeaseBusy',
    reason: 'terminal-live-registry-holds-a-turn-the-durable-store-does-not',
    observed: {
      terminalSessionId: SESSION_ID,
      inMemoryActiveProviderTurn: 'present',
      durableActiveProviderTurnAttempt: 'none',
      runActiveProviderTurn: 'none',
    },
  },
];

for (const split of SPLITS) {
  test(`delivery refusal names the truth split: ${split.name}`, async () => {
    const rig = pumpFor({ reserveError: split.error });
    const pump = createNotificationDeliveryPump(rig.options);
    const pass = await pump.deliverOnce();
    await pump.stop();

    assert.equal(pass.delivered, 0);
    assert.deepEqual(
      pass.failures.map((failure) => failure.code), [split.code],
      'a reserve refusal must still be reported as a refusal, with its code',
    );

    const event = refusalEvent(rig.published);
    assert.notEqual(event, null, 'the refusal published no event');
    assert.equal(event!.code, split.code, 'the refusal lost its code');
    assert.equal(event!.reason, split.reason,
      `the refusal did not name the split; got ${JSON.stringify(event!.reason)}`);
    for (const [key, value] of Object.entries(split.observed)) {
      assert.equal(
        (event!.observed as Record<string, string> | undefined)?.[key], value,
        `the snapshot did not carry ${key}; got ${JSON.stringify(event!.observed)}`,
      );
    }
  });
}

test('a delivering pass publishes no skip and no refusal', async () => {
  const rig = pumpFor({});
  const pump = createNotificationDeliveryPump(rig.options);
  const pass = await pump.deliverOnce();
  await pump.stop();

  assert.equal(pass.delivered, 1, 'the control case did not deliver');
  assert.deepEqual(pass.failures, []);
  assert.deepEqual(rig.submitted, ['nvk080 delivery diagnostics'],
    'the delivered turn never reached the provider');
  assert.deepEqual(rig.published, [], 'a successful delivery published an outcome event');
  assert.deepEqual(rig.reported, [], 'a successful delivery reported a failure');
});

test('a skip whose cause changes publishes the new cause, and repeats neither', async () => {
  // The pump publishes an outcome when it becomes true and again only when it
  // changes. That contract has to survive the typing: a Run that moves from
  // "busy" to "fenced" is TWO diagnoses, and a bucket could never have told
  // them apart.
  const rig = pumpFor({ run: { ...READY_RUN, activity: 'working' } });
  let run: Readonly<Record<string, unknown>> = { ...READY_RUN, activity: 'working' };
  const options: NotificationDeliveryPumpOptions = {
    ...rig.options,
    runs: {
      ...rig.options.runs,
      getAgentRun: async () => b3ok({ run, provider: { provider: 'claude' } }),
    } as unknown as AgentRunsContract,
  };
  const pump = createNotificationDeliveryPump(options);

  await pump.deliverOnce();
  await pump.deliverOnce();
  assert.equal(rig.published.length, 1, 'an unchanged skip published twice');
  assert.equal(rig.published[0]!.payload.reason, 'run-activity-not-idle');

  run = { ...READY_RUN, activityGeneration: 1 };
  await pump.deliverOnce();
  await pump.stop();
  assert.equal(rig.published.length, 2, 'a changed skip cause published nothing new');
  assert.equal(rig.published[1]!.payload.reason, 'run-generation-not-past-delivery-fence');
});
