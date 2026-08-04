// NVK-KIMI-077 seat 2 — a failed delivery must not dead-end its Notification,
// must not strand the Terminal input fence, and must never be invisible.
//
// Three laws, all learned from a live run that cost two full sessions:
//
//  1. A RETRYABLE failure keeps its reservation. The reservation id is derived
//     from the delivery effect key, so it is permanent: cancelling it converts
//     a transient failure into a Notification that no later pass can deliver.
//  2. A NON-RETRYABLE failure releases its reservation. While a reservation is
//     `reserved` it fences the whole Terminal session, so a delivery that can
//     never succeed would starve every other Notification on that session for
//     the life of the process.
//  3. Every pump outcome that is not a delivery lands on the durable run event
//     stream. `console.error` is discarded by the harness that has to diagnose
//     this after the fact; a retained occurrence event is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { templateDigest, type WatcherTemplate } from '../../supervision/public/index.js';
import type { ProviderPort, RunEvent } from '../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../terminal/contract/index.js';
import type { SupervisionCore } from '../../supervision/public/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import {
  createNotificationDeliveryPump, type NotificationDeliveryPump,
  type NotificationDeliveryPumpOptions,
} from '../core/b3/notification-delivery-pump.js';
import { governedRole } from './governed-role.js';

const PRINCIPAL: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};
const READER: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};
const PUMP_EVENT = /^supervision\.notification\.delivery-/u;
const RETAINED_PUMP_EVENT =
  /"eventKind"\s*:\s*"(supervision\.notification\.delivery-[a-z-]+)"/gu;
const RESERVED = 'reserved';

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function unwrap<Value>(result: B3Result<Value>, label: string): Value {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

function template(suffix: string): WatcherTemplate {
  const payload = {
    id: `watch-template/nvk077b-${suffix}`,
    version: 1,
    status: 'active',
    subjectBinding: 'current-run',
    condition: { kind: 'idle-for-ms', value: 300_000 },
    recipientBinding: 'current-supervision-assignment-for-escalation',
    deliveryBinding: 'next-turn-context',
    cooldownMs: 0,
  } as const;
  return {
    templateRef: { id: payload.id, version: payload.version, digest: templateDigest(payload) },
    payload,
  };
}

const ONE = template('one');
const TWO = template('two');

type Host = Awaited<ReturnType<typeof startRuntimeHost>>;

interface Rig {
  readonly root: string;
  readonly host: Host;
  readonly ptyHost: ReturnType<typeof createFakePtyHost>;
  readonly reported: string[];
  fire(tag: string): Promise<void>;
  turn(): Promise<void>;
  pump(overrides?: Partial<NotificationDeliveryPumpOptions>): NotificationDeliveryPump;
  reservation(id: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * One governed Run under a real composition, with the composed pump idled so
 * the only passes are the ones a test drives by hand.
 */
async function startRig(name: string, templates: readonly WatcherTemplate[]): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), `nvk-b3d-${name}-`));
  const ptyHost = createFakePtyHost({ composer: true, echoInput: false });
  const adapters = createFakeProviderAdapters();
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: adapters,
    watcherTemplates: [...templates],
    notificationDeliveryIntervalMs: 3_600_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole(`nvk077b-${name}`),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: templates.map((item) => item.templateRef),
      parentNotificationMode: 'queue-only',
    },
  }), 'create role');
  const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
    roleProfileId: role.id, displayName: `NVK077b ${name}`, workingDirectory: root,
  }), 'spawn');
  const agentRunId = spawned.run.id;
  const reported: string[] = [];

  return {
    root,
    host,
    ptyHost,
    reported,
    /** Push every armed deadline for this Run past due, queueing its Notification. */
    async fire(tag: string): Promise<void> {
      const deadlines = unwrap(
        await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
      );
      const armed = deadlines.filter((deadline) =>
        deadline.subjectKey === `agent-run:${agentRunId}` && deadline.state === 'armed');
      assert.notEqual(armed.length, 0, `no armed deadline to fire for ${tag}`);
      const latest = armed
        .map((deadline) => new Date(String(deadline.dueAt)).getTime())
        .reduce((left, right) => Math.max(left, right), 0);
      const firedAt = new Date(latest + 1).toISOString();
      unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
        event: {
          eventId: `evt_nvk077b_${tag}`, kind: 'agent.run.changed', schemaVersion: 1,
          occurredAt: firedAt as never, committedAt: firedAt as never,
          sourceOwner: 'agent-runtime', traceId: mintTraceCorrelationId(),
          cursor: `nvk077b-${tag}` as never, payload: { agentRunId },
        },
      }), `queue notification ${tag}`);
    },
    /** One independently caused turn — the only thing that releases next-turn context. */
    async turn(): Promise<void> {
      const before = unwrap(
        await host.runtime.runs.getAgentRun(PRINCIPAL, agentRunId as never), 'read run',
      );
      const begun = unwrap(await host.runtime.runs.beginProviderTurn(runtimeContext(), {
        agentRunId: agentRunId as never,
        expectedRecordVersion: before.run.recordVersion,
      }), 'begin turn');
      unwrap(await host.runtime.runs.endProviderTurn(runtimeContext(), {
        agentRunId: agentRunId as never,
        providerTurnId: begun.run.activeProviderTurn!.providerTurnId,
      }), 'end turn');
    },
    pump(overrides = {}) {
      return createNotificationDeliveryPump({
        supervision: host.runtime.supervision,
        runs: host.runtime.runs,
        terminal: host.runtime.terminal,
        providers: {
          deliverTurn: (provider: 'claude' | 'codex' | 'kimi', text: string) =>
            adapters[provider].deliverTurn(text),
        } as ProviderPort,
        reportFailure: (message) => { reported.push(message); },
        ...overrides,
      });
    },
    async reservation(id: string): Promise<string> {
      const held = unwrap(await host.runtime.terminal.getNotificationInputReservation(
        READER, id as never,
      ), 'read reservation');
      return held.state;
    },
    async close(): Promise<void> {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Every pump outcome event on the ONE run event stream, in commit order. */
async function pumpEvents(host: Host, suffix = ''): Promise<readonly RunEvent[]> {
  const page = unwrap(
    await host.runtime.runs.readRunEvents(PRINCIPAL, { limit: 1000 }), 'read run events',
  );
  return page.events.filter(
    (event) => PUMP_EVENT.test(event.kind) && event.kind.endsWith(suffix),
  );
}

/**
 * The same events as retained on disk. The in-memory stream is a live channel;
 * this is the one a harness can still read after the process is gone.
 */
function retainedPumpEventKinds(root: string): readonly string[] {
  const kinds: string[] = [];
  for (const entry of readdirSync(path.join(root, 'stores'), {
    recursive: true, withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const text = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    for (const match of text.matchAll(RETAINED_PUMP_EVENT)) kinds.push(match[1]!);
  }
  return kinds;
}

/** What one outcome event says happened: a typed skip reason, or an error code. */
const why = (event: RunEvent): unknown => event.payload['reason'] ?? event.payload['code'];

test('a retryable claim rejection does not dead-end its Notification', async () => {
  const rig = await startRig('claim-retry', [ONE]);
  try {
    let rejectNextClaim = true;
    const supervision: SupervisionCore = {
      ...rig.host.runtime.supervision,
      claimNotificationDelivery: async (context, input) => {
        if (!rejectNextClaim) {
          return rig.host.runtime.supervision.claimNotificationDelivery(context, input);
        }
        rejectNextClaim = false;
        return b3fail(b3err(
          'VersionConflict', 'the notification record moved under this claim',
          { notificationId: input.notificationId }, true,
        ));
      },
    };
    const pump = rig.pump({ supervision });
    await rig.fire('one');
    await rig.turn();

    const first = await pump.deliverOnce();
    assert.equal(first.delivered, 0, 'the injected claim rejection did not take');
    assert.deepEqual(first.failures.map((failure) => failure.code), ['VersionConflict']);

    // Pre-fix the rejection cancelled the derived reservation, so every later
    // pass met the same cancelled record and refused with IdempotencyConflict.
    const second = await pump.deliverOnce();
    assert.equal(
      second.failures.map((failure) => failure.code).join(','), '',
      'a retryable claim rejection poisoned the Notification',
    );
    assert.equal(second.delivered, 1,
      'the Notification never recovered from a retryable claim rejection');
    assert.equal(rig.ptyHost.latest().turns.length, 1,
      'the recovered delivery never reached the provider');
    await pump.stop();
  } finally {
    await rig.close();
  }
});

test('a retryable commit failure keeps its reservation and a later pass delivers', async () => {
  const rig = await startRig('commit-retry', [ONE]);
  try {
    let failNextCommit = true;
    let reservationId = '';
    const terminal: TerminalContract = {
      ...rig.host.runtime.terminal,
      commitReservedNotificationInput: async (context, input) => {
        if (!failNextCommit) {
          return rig.host.runtime.terminal.commitReservedNotificationInput(context, input);
        }
        failNextCommit = false;
        reservationId = String(input.notificationInputReservationId);
        return b3fail(b3err(
          'RecoveryRequired', 'the reserved attempt could not be settled this pass',
          { notificationInputReservationId: input.notificationInputReservationId }, true,
        ));
      },
    };
    const pump = rig.pump({ terminal });
    await rig.fire('one');
    await rig.turn();

    const first = await pump.deliverOnce();
    assert.equal(first.delivered, 0, 'the injected commit failure did not take');
    assert.deepEqual(first.failures.map((failure) => failure.code), ['RecoveryRequired']);
    assert.equal(await rig.reservation(reservationId), RESERVED,
      'a retryable commit failure cancelled its reservation, so no later pass can deliver it');

    const second = await pump.deliverOnce();
    assert.equal(second.delivered, 1, 'the retried delivery never landed');
    assert.equal(rig.ptyHost.latest().turns.length, 1);
    await pump.stop();
  } finally {
    await rig.close();
  }
});

test('a non-retryable commit failure frees the session and says so durably', async () => {
  const rig = await startRig('commit-dead-end', [ONE, TWO]);
  try {
    // Non-retryable means it refuses the same way every time — the shape seat 1
    // reproduced with a malformed submit payload.
    let poisoned: string | null = null;
    const terminal: TerminalContract = {
      ...rig.host.runtime.terminal,
      commitReservedNotificationInput: async (context, input) => {
        poisoned ??= String(input.notificationInputReservationId);
        if (poisoned !== String(input.notificationInputReservationId)) {
          return rig.host.runtime.terminal.commitReservedNotificationInput(context, input);
        }
        return b3fail(b3err(
          'ValidationFailed', 'reserved notification input must end with one provider submit key',
          { issues: [{ path: 'utf8Text', message: 'must end with a carriage return' }] }, false,
        ));
      },
    };
    const pump = rig.pump({ terminal });
    await rig.fire('one');
    await rig.turn();

    await pump.deliverOnce();
    await pump.deliverOnce();

    // Pre-fix the dead reservation stayed `reserved` and fenced the session:
    // the healthy Notification met InputLeaseBusy on every pass, for ever.
    assert.equal(rig.ptyHost.latest().turns.length, 1,
      'a delivery that can never succeed starved the other Notification on its session');
    assert.equal(await rig.reservation(poisoned!), 'cancelled',
      'the dead-end reservation still fences the session');

    const refusals = await pumpEvents(rig.host, 'delivery-refused');
    assert.equal(refusals.length > 0, true,
      `a refusal must be published, not only logged; got ${JSON.stringify(rig.reported)}`);
    assert.equal(refusals.some((event) => why(event) === 'ValidationFailed'), true,
      `the refusal must carry its error code; got ${JSON.stringify(refusals.map(why))}`);
    assert.equal(
      retainedPumpEventKinds(rig.root).includes('supervision.notification.delivery-refused'),
      true, 'the refusal was never retained, so nothing can read it after the fact',
    );
    await pump.stop();
  } finally {
    await rig.close();
  }
});

test('a pass that delivers everything it considered publishes no outcome events', async () => {
  const rig = await startRig('clean-pass', [ONE]);
  try {
    const pump = rig.pump();
    await rig.fire('one');
    await rig.turn();

    const clean = await pump.deliverOnce();
    assert.equal(clean.delivered, 1, 'the only delivery never landed');
    assert.deepEqual(clean.failures, []);
    assert.deepEqual((await pumpEvents(rig.host)).map((event) => event.kind), [],
      'a clean pass must be silent on the event stream');
    assert.deepEqual(retainedPumpEventKinds(rig.root), []);
    await pump.stop();
  } finally {
    await rig.close();
  }
});

test('a skip is published when its reason changes, not once per pass', async () => {
  const rig = await startRig('skip-events', [ONE, TWO]);
  try {
    const pump = rig.pump();
    // One fire settles both armed deadlines, so two Notifications queue on one
    // Run — and one Run takes at most one delivery per pass.
    await rig.fire('one');
    await rig.turn();

    const first = await pump.deliverOnce();
    assert.equal(first.considered, 2);
    assert.equal(first.delivered, 1, 'the first delivery never landed');

    // The delivered one is now `offered-to-endpoint` and is never transcript
    // observed here, so the second is fenced behind it for a different reason.
    const fenced = await pump.deliverOnce();
    assert.equal(fenced.delivered, 0, 'a fresh unobserved delivery must still fence its Run');

    const skips = await pumpEvents(rig.host, 'delivery-skipped');
    assert.deepEqual(skips.map(why),
      ['run-already-delivered-this-pass', 'awaiting-transcript-observation'],
      `each distinct skip reason must be published once; got ${JSON.stringify(skips.map(why))}`);
    assert.equal(skips[1]!.payload['agentRunId'], undefined,
      'a delivery report must not name agentRunId: supervision reads that key as activity '
      + 'evidence about the Run and would re-arm the very deadlines it reports on');
    assert.equal(
      retainedPumpEventKinds(rig.root)
        .filter((kind) => kind.endsWith('delivery-skipped')).length,
      2, 'the skips were never retained, so nothing can read them after the fact',
    );

    // A second fenced pass is the same fact, not a new one.
    await pump.deliverOnce();
    assert.equal((await pumpEvents(rig.host, 'delivery-skipped')).length, 2,
      'an unchanged outcome must not be republished every pass');
    await pump.stop();
  } finally {
    await rig.close();
  }
});
