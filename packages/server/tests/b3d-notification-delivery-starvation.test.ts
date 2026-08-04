// NVK-KIMI-077 — a delivered Notification must not fence its Run forever.
//
// The pump refuses to deliver a second Notification to a Run while an earlier
// one is still `offered-to-endpoint`. That state's ONLY exit is Q11 transcript
// observation, and transcript observation is evidence that provably may never
// arrive (NVK-075 measured 27% of real claude turns still unprovable after the
// parser fix). So the fence had no bound: one unobserved delivery silently
// starved every later Notification on that Run for the life of the process,
// and the skip carried no code, so nothing in the pass said why.
//
// Two laws here. The fence releases once the delivery is old enough that
// observation is not coming, and every non-delivering outcome is reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { templateDigest, type WatcherTemplate } from '../../supervision/public/index.js';
import type { Notification } from '../../supervision/contract/index.js';
import type { ProviderPort } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { createNotificationDeliveryPump } from '../core/b3/notification-delivery-pump.js';
import { governedRole } from './governed-role.js';

const PRINCIPAL: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function template(suffix: string): WatcherTemplate {
  const payload = {
    id: `watch-template/nvk077-${suffix}`,
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

const FIRST = template('starve-first');
const SECOND = template('starve-second');

function unwrap<Value>(result: B3Result<Value>, label: string): Value {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

test('an unobserved delivery stops fencing its Run once observation is not coming', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-starvation-'));
  const ptyHost = createFakePtyHost({ composer: true, echoInput: false });
  const adapters = createFakeProviderAdapters();
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: adapters,
    watcherTemplates: [FIRST, SECOND],
    // The composed pump must not race the one this test drives by hand.
    notificationDeliveryIntervalMs: 3_600_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('nvk077-starvation'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [FIRST.templateRef, SECOND.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
      roleProfileId: role.id, displayName: 'NVK077 Starvation', workingDirectory: root,
    }), 'spawn');
    const agentRunId = spawned.run.id;

    const fire = async (tag: string): Promise<void> => {
      const deadlines = unwrap(
        await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
      );
      const armed = deadlines.filter((deadline) =>
        deadline.subjectKey === `agent-run:${agentRunId}` && deadline.state === 'armed');
      if (armed.length === 0) return;
      const latest = armed
        .map((deadline) => new Date(String(deadline.dueAt)).getTime())
        .reduce((left, right) => Math.max(left, right), 0);
      const firedAt = new Date(latest + 1).toISOString();
      unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
        event: {
          eventId: `evt_nvk077_${tag}`, kind: 'agent.run.changed', schemaVersion: 1,
          occurredAt: firedAt as never, committedAt: firedAt as never,
          sourceOwner: 'agent-runtime', traceId: mintTraceCorrelationId(),
          cursor: `nvk077-${tag}` as never, payload: { agentRunId },
        },
      }), `queue notification ${tag}`);
    };

    // One independently caused turn: the only thing that releases next-turn
    // context, and the thing the live defect proved was not enough.
    const turn = async (): Promise<void> => {
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
    };

    const reported: string[] = [];
    // The pass clock is injected so "long enough that observation is not
    // coming" is a decision this test makes, not a sleep it waits out.
    let now = Date.now();
    const pump = createNotificationDeliveryPump({
      supervision: host.runtime.supervision,
      runs: host.runtime.runs,
      terminal: host.runtime.terminal,
      providers: {
        deliverTurn: (provider: 'claude' | 'codex' | 'kimi', text: string) =>
          adapters[provider].deliverTurn(text),
      } as ProviderPort,
      now: () => now,
      reportFailure: (message) => { reported.push(message); },
    });

    const queuedFor = async (): Promise<readonly Notification[]> => {
      const listed = unwrap(
        await host.runtime.supervision.listNotifications(PRINCIPAL, { limit: 50 }),
        'list notifications',
      );
      return listed.items.filter((item) => item.deliveryAttempt.state === 'queued');
    };

    await fire('one');
    await turn();
    const first = await pump.deliverOnce();
    assert.equal(first.delivered, 1, 'the first Notification never reached the provider');
    assert.equal(ptyHost.latest().turns.length, 1);

    // The delivered one is now `offered-to-endpoint` and will never be
    // transcript-observed in this test — exactly the live shape.
    await fire('two');
    await turn();

    // Inside the grace window the fence still holds, and it now SAYS so.
    const fenced = await pump.deliverOnce();
    assert.equal(fenced.delivered, 0, 'a fresh unobserved delivery must still fence its Run');
    assert.equal((await queuedFor()).length, 1);
    assert.equal(
      reported.some((message) => message.includes('awaiting-transcript-observation')),
      true,
      `a fenced skip must be reported, not silent; got ${JSON.stringify(reported)}`,
    );

    // Past the window, observation is not coming and the queue must move.
    now += 10 * 60_000;
    const released = await pump.deliverOnce();
    assert.equal(released.delivered, 1,
      'an unobserved delivery starved the Run forever: the second Notification never left queued');
    assert.equal(ptyHost.latest().turns.length, 2,
      'the released Notification never reached the provider');
    assert.deepEqual(await queuedFor(), []);
    await pump.stop();
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
