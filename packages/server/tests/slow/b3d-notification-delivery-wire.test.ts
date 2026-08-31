// FINDING-C7 — Runtime must carry a queued Notification through delivery.
//
// The Supervision capability already owns the queue/claim/outcome machine. This
// test deliberately calls none of those delivery commands: it stands up the
// real Runtime composition, queues a start-turn Notification through the public
// watcher seam, and waits for the Runtime to do the job it exclusively owns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { templateDigest, type WatcherTemplate } from '../../../supervision/public/index.js';
import type { Notification, WatchDeadline } from '../../../supervision/contract/index.js';
import { startRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime } from '../../core/runtime-host/client.js';
import { chatRole } from '../governed-role.js';

const PRINCIPAL: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

const PAYLOAD = {
  id: 'watch-template/c7-runtime-delivery',
  version: 1,
  status: 'active',
  subjectBinding: 'current-run',
  condition: { kind: 'idle-for-ms', value: 300_000 },
  recipientBinding: 'current-supervision-assignment-for-escalation',
  deliveryBinding: 'start-turn',
  cooldownMs: 0,
} as const;

const TEMPLATE: WatcherTemplate = {
  templateRef: {
    id: PAYLOAD.id,
    version: PAYLOAD.version,
    digest: templateDigest(PAYLOAD),
  },
  payload: PAYLOAD,
};

const NEXT_PAYLOAD = {
  ...PAYLOAD,
  id: 'watch-template/c7-next-turn-context',
  deliveryBinding: 'next-turn-context',
} as const;

const NEXT_TEMPLATE: WatcherTemplate = {
  templateRef: {
    id: NEXT_PAYLOAD.id,
    version: NEXT_PAYLOAD.version,
    digest: templateDigest(NEXT_PAYLOAD),
  },
  payload: NEXT_PAYLOAD,
};

function unwrap<Value>(result: B3Result<Value>, label: string): Value {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

async function until<Value>(
  attempt: () => Promise<Value | null>, budgetMs = 2_000,
): Promise<Value | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('Runtime advances a queued start-turn Notification without a delivery caller', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-c7-wire-'));
  const ptyHost = createFakePtyHost({ composer: true });
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: createFakeProviderAdapters(),
    watcherTemplates: [TEMPLATE],
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...chatRole('c7-runtime-delivery'),
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [TEMPLATE.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'C7 Runtime Delivery',
      workingDirectory: root,
    }), 'spawn');

    const deadlines = unwrap(
      await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
    );
    const armed = deadlines.find((deadline: WatchDeadline) =>
      deadline.subjectKey === `agent-run:${spawned.run.id}` && deadline.state === 'armed');
    assert.notEqual(armed, undefined, 'spawn installed no deadline for the delivery watcher');

    const firedAt = new Date(new Date(armed!.dueAt).getTime() + 1).toISOString();
    unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
      event: {
        eventId: 'evt_c7_runtime_delivery',
        kind: 'agent.run.changed',
        schemaVersion: 1,
        occurredAt: firedAt as never,
        committedAt: firedAt as never,
        sourceOwner: 'agent-runtime',
        traceId: mintTraceCorrelationId(),
        cursor: 'c7-runtime-delivery' as never,
        payload: { agentRunId: spawned.run.id },
      },
    }), 'queue notification');

    const delivered = await until(async () => {
      const listed = await host.runtime.supervision.listNotifications(
        PRINCIPAL, { limit: 50 },
      );
      if (!listed.ok) return null;
      return listed.value.items.find((notification: Notification) =>
        notification.subject.kind === 'agent-run'
          && notification.subject.agentRunId === spawned.run.id
          && (notification.deliveryAttempt.state === 'submitted-confirmed'
            || notification.deliveryAttempt.state === 'submitted-unconfirmed')) ?? null;
    });

    assert.notEqual(delivered, null,
      'a queued start-turn Notification never left queued: Runtime has no delivery caller');
    assert.equal(ptyHost.latest().turns.length, 1,
      'one Notification delivery must cause exactly one provider-visible turn');
    assert.equal(ptyHost.latest().turns[0], delivered?.summary);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Runtime delivers next-turn-context only after a separately caused turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-c7-next-turn-'));
  const ptyHost = createFakePtyHost({ composer: true });
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: createFakeProviderAdapters(),
    watcherTemplates: [NEXT_TEMPLATE],
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...chatRole('c7-next-turn-context'),
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [NEXT_TEMPLATE.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'C7 Next Turn Context',
      workingDirectory: root,
    }), 'spawn');
    const deadlines = unwrap(
      await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
    );
    const armed = deadlines.find((deadline: WatchDeadline) =>
      deadline.subjectKey === `agent-run:${spawned.run.id}` && deadline.state === 'armed');
    assert.notEqual(armed, undefined);
    const firedAt = new Date(new Date(armed!.dueAt).getTime() + 1).toISOString();
    unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
      event: {
        eventId: 'evt_c7_next_turn',
        kind: 'agent.run.changed',
        schemaVersion: 1,
        occurredAt: firedAt as never,
        committedAt: firedAt as never,
        sourceOwner: 'agent-runtime',
        traceId: mintTraceCorrelationId(),
        cursor: 'c7-next-turn' as never,
        payload: { agentRunId: spawned.run.id },
      },
    }), 'queue notification');

    await new Promise((resolve) => { setTimeout(resolve, 750); });
    assert.equal(ptyHost.latest().turns.length, 0,
      'next-turn-context started a provider turn before another cause existed');

    const before = unwrap(await host.runtime.runs.getAgentRun(
      PRINCIPAL, spawned.run.id as never,
    ), 'read run');
    const begun = unwrap(await host.runtime.runs.beginProviderTurn(runtimeContext(), {
      agentRunId: spawned.run.id as never,
      expectedRecordVersion: before.run.recordVersion,
    }), 'begin separately caused turn');
    assert.notEqual(begun.run.activeProviderTurn, undefined);
    unwrap(await host.runtime.runs.endProviderTurn(runtimeContext(), {
      agentRunId: spawned.run.id as never,
      providerTurnId: begun.run.activeProviderTurn!.providerTurnId,
    }), 'end separately caused turn');

    const delivered = await until(async () => {
      const listed = await host.runtime.supervision.listNotifications(PRINCIPAL, { limit: 50 });
      if (!listed.ok) return null;
      return listed.value.items.find((notification: Notification) =>
        notification.subject.kind === 'agent-run'
          && notification.subject.agentRunId === spawned.run.id
          && (notification.deliveryAttempt.state === 'submitted-confirmed'
            || notification.deliveryAttempt.state === 'submitted-unconfirmed')) ?? null;
    });
    assert.notEqual(delivered, null,
      'a separately caused turn never released its queued next-turn context');
    assert.equal(ptyHost.latest().turns.length, 1);
    assert.equal(ptyHost.latest().turns[0], delivered?.summary);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
