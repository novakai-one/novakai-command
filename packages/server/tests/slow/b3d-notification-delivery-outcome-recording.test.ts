// NVK-KIMI-081 — a delivery-relevant outcome may never go unrecorded.
//
// A live next-turn-context Notification went SILENT for exactly the duration of
// its lawful delivery window: the controller turn had completed at generation 3,
// the input lease was durably revoked, the session was live and the Run was
// ready/idle with an empty draft and no reservation — and for ~90 seconds the
// pump published no skip, no refusal and no delivery for it, while it kept
// publishing other Notifications' outcomes normally. When the window closed
// (session exited, run stopped) its skips started publishing again.
//
// The pump's outcome announcer is an ON-CHANGE publisher: it records an outcome
// when it becomes true and again only when it changes, so a block that holds
// steady is meant to cost one event, not one per pass. `announce` marked the
// dedupe entry BEFORE it knew the publish had landed, so a single refused or
// throwing publish turned "publish once" into "publish never" for as long as
// that outcome stayed true — which is precisely the shape of a steady block.
// A throwing publish did worse: it escaped the candidate loop, so every
// Notification after it in that pass lost the pass entirely.
//
// Three laws here:
//   1. dedupe is marked only after a publish is durably accepted,
//   2. a refused or throwing publish never silences a later pass,
//   3. no single candidate may kill a pass for the others.
// The fourth test is the control: the healthy on-change dedupe must survive.
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

const RUN_ID = 'agentrun_01960000000000000000000081';
const OTHER_RUN_ID = 'agentrun_01960000000000000000000181';
const SESSION_ID = 'terminalsession_01960000000000000000000081';
const OTHER_SESSION_ID = 'terminalsession_01960000000000000000000181';
const EFFECT_KEY = 'notification-delivery/nvk081';
const OTHER_EFFECT_KEY = 'notification-delivery/nvk081-other';
const RESERVATION_ID = notificationInputReservationId(EFFECT_KEY);

const SKIPPED = 'supervision.notification.delivery-skipped';
const REFUSED = 'supervision.notification.delivery-refused';

/** A v1 `next-turn-context` Notification sitting in `queued`. */
function queued(
  id: string, agentRunId: string, effectKey: string,
): Notification {
  return {
    id,
    kind: 'notification',
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: '2026-08-05T00:00:00.000Z',
    permissionLevel: 'system',
    createdBy: 'sys_supervision',
    lastMutation: {
      at: '2026-08-05T00:00:00.000Z', by: 'sys_supervision',
      clientOpId: 'clientop_01960000000000000000000081', traceId: 'trace_nvk081',
    },
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: 'watchrule_01960000000000000000000081',
    subject: { kind: 'agent-run', agentRunId },
    recipient: { kind: 'agent-run', agentRunId },
    conditionGeneration: 1,
    summary: `nvk081 outcome recording ${id}`,
    evidenceRefs: [],
    state: 'queued',
    phase: 'condition',
    deliveryMode: 'next-turn-context',
  } as unknown as Notification;
}

const NOTIFICATION = queued(
  'notification_01960000000000000000000081', RUN_ID, EFFECT_KEY,
);
const OTHER_NOTIFICATION = queued(
  'notification_01960000000000000000000181', OTHER_RUN_ID, OTHER_EFFECT_KEY,
);

const readyRun = (agentRunId: string, terminalSessionId: string) => ({
  id: agentRunId,
  lifecycle: 'ready',
  activity: 'idle',
  activeProviderTurn: undefined,
  terminalSessionId,
  activityGeneration: 3,
});

const liveSession = (id: string) => ({
  session: { id, status: 'live' },
  attachments: [],
  activeInputLease: undefined,
  replay: { earliestSequence: 0, latestSequence: 0 },
  nextInputSequence: 1,
});

interface Published {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface Scene {
  readonly notifications?: readonly Notification[];
  /** Decides what the outcome-event publisher does on each call, in order. */
  readonly publish?: (call: number, kind: string) => 'ok' | 'refuse' | 'throw';
  /** Runs whose `getAgentRun` throws — the unexpected-failure candidate. */
  readonly throwingRuns?: ReadonlySet<string>;
  /** The window's block: what `reserveNotificationInput` refuses with. */
  readonly reserveError?: ReturnType<typeof b3err>;
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
  const notifications = scene.notifications ?? [NOTIFICATION];
  let publishCall = 0;

  const supervision = {
    listNotifications: async () => b3ok({ items: notifications }),
    listWatchDeadlines: async () => b3ok([]),
    claimNotificationDelivery: async () => b3ok({ notification: notifications[0] }),
    recordNotificationDeliveryOutcome: async () => b3ok(null),
  } as unknown as SupervisionCore;

  const runs = {
    getAgentRun: async (_reader: unknown, agentRunId: string) => {
      if (scene.throwingRuns?.has(agentRunId) === true) {
        throw new TypeError(`nvk081 injected worker failure for ${agentRunId}`);
      }
      return b3ok({
        run: readyRun(
          agentRunId,
          agentRunId === OTHER_RUN_ID ? OTHER_SESSION_ID : SESSION_ID,
        ),
        provider: { provider: 'claude' },
      });
    },
    publishCapabilityEvent: async (
      kind: string, payload: Readonly<Record<string, unknown>>,
    ): Promise<B3Result<null>> => {
      publishCall += 1;
      const verdict = scene.publish?.(publishCall, kind) ?? 'ok';
      if (verdict === 'throw') throw new Error('nvk081 injected publish throw');
      if (verdict === 'refuse') {
        return b3fail(b3err('StoreUnavailable', 'nvk081 injected publish refusal', {}, true));
      }
      published.push({ kind, payload });
      return b3ok(null);
    },
  } as unknown as AgentRunsContract;

  const terminal = {
    getNotificationInputReservation: async () =>
      b3fail(b3err('ValidationFailed', 'no prior reservation', {}, false)),
    getTerminalSession: async (_reader: unknown, terminalSessionId: string) =>
      b3ok(liveSession(terminalSessionId)),
    reserveNotificationInput: async () => (scene.reserveError === undefined
      ? b3ok({ id: RESERVATION_ID, state: 'reserved' })
      : b3fail(scene.reserveError)),
    commitReservedNotificationInput: async () => b3ok({
      attempt: {
        id: 'terminalinputattempt_01960000000000000000000081',
        source: 'system-notification',
        outcome: 'submitted-confirmed',
        submittedAt: '2026-08-05T00:00:01.000Z',
        providerTurnId: 'providerturn_01960000000000000000000081',
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

/** The live window's block: Terminal's live registry disagrees with its store. */
const REGISTRY_SPLIT = b3err('TerminalNotLive', 'the terminal has no live process', {
  terminalSessionId: SESSION_ID, status: 'live',
}, false);

const outcomesFor = (
  published: readonly Published[], notificationId: string,
): readonly Published[] => published.filter(
  (event) => (event.kind === SKIPPED || event.kind === REFUSED)
    && event.payload['notificationId'] === notificationId,
);

test('a refused outcome publish does not silence the next pass', async () => {
  // The live shape exactly: a steady block holds for the whole window, so the
  // on-change announcer has one outcome to record — and exactly one chance to
  // record it. Losing that one publish lost the whole window.
  const rig = pumpFor({
    reserveError: REGISTRY_SPLIT,
    publish: (call) => (call === 1 ? 'refuse' : 'ok'),
  });
  const pump = createNotificationDeliveryPump(rig.options);

  await pump.deliverOnce();
  assert.deepEqual(
    outcomesFor(rig.published, NOTIFICATION.id), [],
    'the refused publish must not have landed',
  );

  await pump.deliverOnce();
  await pump.stop();

  const outcomes = outcomesFor(rig.published, NOTIFICATION.id);
  assert.equal(
    outcomes.length, 1,
    'the block stayed true but its outcome was never recorded: one refused publish '
      + 'silenced every later pass, which is the whole live window',
  );
  assert.equal(outcomes[0]!.kind, REFUSED);
  assert.equal(
    outcomes[0]!.payload['reason'],
    'terminal-live-registry-missing-while-durable-session-live',
  );
  assert.equal(
    rig.reported.some((line) => line.includes('StoreUnavailable')), true,
    `the refused publish was not reported at all; got ${JSON.stringify(rig.reported)}`,
  );
});

test('a throwing outcome publish neither escapes the pump nor silences the next pass', async () => {
  const rig = pumpFor({
    reserveError: REGISTRY_SPLIT,
    publish: (call) => (call === 1 ? 'throw' : 'ok'),
  });
  const pump = createNotificationDeliveryPump(rig.options);

  const first = await pump.deliverOnce();
  assert.deepEqual(
    first.failures.map((failure) => failure.code), ['TerminalNotLive'],
    'a publish that threw took the whole pass with it',
  );

  await pump.deliverOnce();
  await pump.stop();

  const outcomes = outcomesFor(rig.published, NOTIFICATION.id);
  assert.equal(
    outcomes.length, 1,
    'a throwing publish silenced every later pass for this Notification',
  );
  assert.equal(outcomes[0]!.kind, REFUSED);
});

test('one candidate that throws does not cost the other candidates their pass', async () => {
  // The pump has no guard around `deliverNotification`, so an unexpected throw
  // on ONE Notification ended the loop for every Notification after it — which
  // is invisible from the outside, because the ones that lost the pass publish
  // nothing at all.
  const rig = pumpFor({
    notifications: [NOTIFICATION, OTHER_NOTIFICATION],
    throwingRuns: new Set([RUN_ID]),
  });
  const pump = createNotificationDeliveryPump(rig.options);

  const pass = await pump.deliverOnce();
  await pump.stop();

  assert.equal(
    pass.delivered, 1,
    'the second Notification never got its attempt: one candidate killed the pass',
  );
  assert.deepEqual(
    rig.submitted, [`nvk081 outcome recording ${OTHER_NOTIFICATION.id}`],
    'the deliverable Notification never reached the provider',
  );
  const failed = outcomesFor(rig.published, NOTIFICATION.id);
  assert.equal(
    failed.length, 1,
    'the candidate that threw recorded no outcome at all — the silence this mission is about',
  );
  assert.equal(failed[0]!.kind, REFUSED);
  assert.equal(
    failed[0]!.payload['code'], 'RecoveryRequired',
    'an unexpected delivery failure must be recorded as one, with a code',
  );
  assert.equal(
    String(failed[0]!.payload['cause'] ?? '').includes('nvk081 injected worker failure'), true,
    `the recorded outcome did not carry the cause; got ${JSON.stringify(failed[0]!.payload)}`,
  );
  assert.deepEqual(
    outcomesFor(rig.published, OTHER_NOTIFICATION.id), [],
    'a delivering Notification must still publish no outcome',
  );
});

test('an accepted outcome is still published once, not once per pass', async () => {
  // The control. The fix moves the dedupe mark after the publish; it must not
  // turn the on-change announcer into a per-pass one.
  const rig = pumpFor({ reserveError: REGISTRY_SPLIT });
  const pump = createNotificationDeliveryPump(rig.options);

  await pump.deliverOnce();
  await pump.deliverOnce();
  await pump.deliverOnce();
  await pump.stop();

  assert.equal(
    outcomesFor(rig.published, NOTIFICATION.id).length, 1,
    'an unchanged outcome published more than once: the pump is recording the clock',
  );
});
