// LANE C — FINDING-C4: Q11's transcript half, through the LIVE composition.
//
// The capability was built and composed in seat 2, and every one of its laws is
// proved in `packages/supervision/tests/notification-transcript-observation-*`.
// None of that proved anybody CALLS it. `recordNotificationTranscript*` returned
// grep hits only inside `packages/supervision`, so in the running product a
// delivered Notification stopped at `offered-to-endpoint` for ever — not because
// the capability could not promote it, but because no Transcript-side caller
// existed.
//
// This test never calls the observation command. It stands up the real Runtime,
// spawns through the wire, drives the delivery half the way Runtime would, and
// then lets the provider's transcript gain the exact turn that delivery caused.
// The only stimulus after that is the mirror pump doing what it already does.
// If nothing wires Transcript's committed line to Supervision, the Notification
// sits at `offered-to-endpoint` and every assertion below fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintTerminalInputAttemptId, mintTraceCorrelationId,
  type ActivityGeneration, type AuthenticatedPrincipal, type B3Result,
  type ProviderTurnId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import type {
  SourcePrefixOutcome, SourceReadOutcome, TranscriptSourcePort,
} from '../../transcript/b3/contract/index.js';
import { templateDigest, type WatcherTemplate } from '../../supervision/public/index.js';
import type {
  Notification, NotificationInputReservationId, WatchDeadline,
} from '../../supervision/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

const PRINCIPAL: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

const RESERVATION = `notificationInput_${'a'.repeat(52)}` as NotificationInputReservationId;
const TURN_ID = 'providerTurn_019fd000-0000-7000-8000-0000000000c4' as ProviderTurnId;

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/**
 * A watcher whose Notification has a provider delivery effect at all.
 *
 * The shipped idle template is `queue-only`, and a `queue-only` Notification is
 * refused delivery by design (FINDING-C2) — so it can never reach the state this
 * test is about. The catalogue seam exists for exactly this: a host supplies its
 * own concrete entries.
 */
const TEMPLATE_PAYLOAD = {
  id: 'watch-template/idle-next-turn-context',
  version: 1,
  status: 'active',
  subjectBinding: 'current-run',
  condition: { kind: 'idle-for-ms', value: 300_000 },
  recipientBinding: 'current-supervision-assignment-for-escalation',
  deliveryBinding: 'next-turn-context',
  cooldownMs: 0,
} as const;

const TEMPLATE: WatcherTemplate = {
  templateRef: {
    id: TEMPLATE_PAYLOAD.id,
    version: TEMPLATE_PAYLOAD.version,
    digest: templateDigest(TEMPLATE_PAYLOAD),
  },
  payload: TEMPLATE_PAYLOAD,
};

/**
 * The provider's own transcript, gaining one line when the test says so — the
 * shape of a real one, without a real provider's latency. Nothing in production
 * reads this port differently.
 */
function scriptedSource(): TranscriptSourcePort & { produce(text: string): void } {
  let turn: string | null = null;
  const position = '0000000000';
  const digestOf = (text: string): string =>
    createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    produce(text: string) { turn = text; },
    async read(_binding, fromPosition, maxLines): Promise<SourceReadOutcome> {
      if (turn === null) return { kind: 'missing' };
      if (fromPosition !== undefined && position < fromPosition) {
        return { kind: 'lines', lines: [], more: false };
      }
      return {
        kind: 'lines',
        more: false,
        lines: maxLines < 1
          ? []
          : [{ position, role: 'user', text: turn, digest: digestOf(turn) }],
      };
    },
    async readPrefixDigests(_binding, throughPosition): Promise<SourcePrefixOutcome> {
      if (turn === null) return { kind: 'missing' };
      return {
        kind: 'digests',
        digests: position <= throughPosition
          ? [{ position, digest: digestOf(turn) }] : [],
      };
    },
  };
}

async function until<T>(attempt: () => Promise<T | null>, budgetMs: number): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await attempt();
    if (found !== null) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

test('a delivered Notification reaches transcript-observed when the provider transcript records its turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-q11-wire-'));
  const source = scriptedSource();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    transcriptSource: source,
    watcherTemplates: [TEMPLATE],
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  const { supervision } = host.runtime;
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('q11-wire-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [TEMPLATE.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.id, displayName: 'Q11 Wire', workingDirectory: root,
    }), 'spawn');
    const runId = spawned.run.id;

    // The watcher rung installed a durable deadline; an ordinary committed event
    // past its due time fires it. This is Supervision's whole clock (§9.2).
    const deadlines = unwrap(
      await supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
    );
    const armed = deadlines.find(
      (deadline: WatchDeadline) => deadline.subjectKey === `agent-run:${runId}`
        && deadline.state === 'armed',
    );
    assert.notEqual(armed, undefined, 'the spawn ladder armed no deadline for this Run');
    if (armed === undefined) return;

    const firedAt = new Date(new Date(armed.dueAt).getTime() + 1_000).toISOString();
    unwrap(await supervision.evaluateEvent(runtimeContext(), {
      event: {
        eventId: 'evt_q11_fire',
        kind: 'agent.run.changed',
        schemaVersion: 1,
        occurredAt: firedAt as never,
        committedAt: firedAt as never,
        sourceOwner: 'agent-runtime',
        traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
        cursor: 'q11-fire-cursor' as never,
        payload: { agentRunId: runId },
      },
    }), 'fire the deadline');

    const queued = unwrap(
      await supervision.listNotifications(PRINCIPAL, { state: ['queued'], limit: 50 }),
      'list queued notifications',
    );
    const notification = queued.items.find(
      (item: Notification) => item.subject.kind === 'agent-run'
        && item.subject.agentRunId === runId,
    );
    assert.notEqual(notification, undefined, 'the fired deadline queued no Notification');
    if (notification === undefined) return;

    // The delivery half, driven the way Runtime drives it: claim the queued
    // Notification against a Terminal reservation, then record what Terminal
    // observed of the submission. That stops at `offered-to-endpoint` by design
    // — a confirmed submission proves the INPUT EFFECT, never the provider turn.
    const claimed = unwrap(await supervision.claimNotificationDelivery(runtimeContext(), {
      notificationId: notification.id,
      expectedNotificationRecordVersion: notification.recordVersion,
      expectedEffectKey: notification.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      expectedActivityGeneration: notification.conditionGeneration as ActivityGeneration,
    }), 'claim delivery');
    const offered = unwrap(await supervision.recordNotificationDeliveryOutcome(runtimeContext(), {
      notificationId: notification.id,
      expectedRecordVersion: claimed.notification.recordVersion,
      expectedEffectKey: notification.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: mintTerminalInputAttemptId(),
      outcome: {
        state: 'submitted-confirmed',
        submittedAt: new Date().toISOString() as never,
        providerTurnId: TURN_ID,
      },
    }), 'record delivery outcome');
    assert.equal(offered.state, 'offered-to-endpoint');

    // The provider's transcript now contains the turn that delivery caused. No
    // ingest call, no observation call, no CLI verb — only the line appearing.
    source.produce(notification.summary);

    // Guard the guard: if the mirror never committed the line, the assertion
    // below would be measuring nothing. This makes "the turn is in the
    // transcript" a checked precondition rather than an assumption.
    const committed = await until(async () => {
      const page = await chris.call<{ events: readonly { kind: string }[] }>(
        'b3.agent.subscribeEvents', { limit: 500 },
      );
      if (!page.ok) return null;
      return page.value.events.some((event) => event.kind === 'transcript.line.committed')
        ? true : null;
    }, 20_000);
    assert.equal(committed, true, 'the mirror never committed the produced line');

    const observed = await until(async () => {
      const page = await supervision.listNotifications(
        PRINCIPAL, { state: ['transcript-observed'], limit: 50 },
      );
      if (!page.ok) return null;
      return page.value.items.find((item) => item.id === notification.id) ?? null;
    }, 20_000);

    assert.notEqual(observed, null,
      'a delivered Notification\'s exact turn appeared in the provider transcript and '
      + 'the Notification never left offered-to-endpoint: nothing wires Transcript\'s '
      + 'committed line into Q11 (FINDING-C4)');
    assert.equal(observed?.state, 'transcript-observed');
    // The promotion has to cite what promoted it, or it is an assertion.
    assert.equal(
      (observed?.evidenceRefs ?? []).some((ref) => ref.startsWith('q11-transcript-observed:')),
      true,
      `the observation pinned no evidence: ${JSON.stringify(observed?.evidenceRefs)}`,
    );
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
