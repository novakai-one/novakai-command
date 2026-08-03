// A Runtime restart settles the Runs whose process disappeared. That final
// edge must cross the same public event stream as an explicit stop, because
// Supervision has no second clock and must not poll Runtime-owned state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface RunView {
  readonly run: { readonly id: string };
}

interface WatchRuleView {
  readonly id: string;
}

interface NotificationView {
  readonly watchRuleId: string;
  readonly state: string;
}

interface StreamEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function start(root: string): Promise<{
  readonly host: RunningRuntimeHost;
  readonly client: RuntimeClient;
}> {
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  return { host, client };
}

async function stop(host: RunningRuntimeHost, client: RuntimeClient): Promise<void> {
  await client.close();
  await host.close();
}

async function notificationsFor(
  client: RuntimeClient, watchRuleId: string,
): Promise<readonly NotificationView[]> {
  const listed = await client.call<{ readonly items: readonly NotificationView[] }>(
    'b3.supervision.listNotifications', { limit: 50 }, mintClientOpId(),
  );
  assert.equal(listed.ok, true, listed.ok ? '' : listed.error.message);
  return listed.ok
    ? listed.value.items.filter((item) => item.watchRuleId === watchRuleId)
    : [];
}

async function awaitNotifications(
  client: RuntimeClient, watchRuleId: string,
): Promise<readonly NotificationView[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = await notificationsFor(client, watchRuleId);
    if (found.length > 0 || Date.now() >= deadline) return found;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

async function lifecycleEventsFor(
  client: RuntimeClient, agentRunId: string,
): Promise<readonly StreamEvent[]> {
  const page = await client.call<{ readonly events: readonly StreamEvent[] }>(
    'b3.agent.subscribeEvents', { limit: 1_000 }, mintClientOpId(),
  );
  assert.equal(page.ok, true, page.ok ? '' : page.error.message);
  return page.ok ? page.value.events.filter((event) =>
    event.kind === 'agent.run.lifecycle.changed'
      && event.payload['agentRunId'] === agentRunId) : [];
}

test('boot reconciliation publishes one run-final Notification and never re-fires it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-boot-final-'));
  let first: Awaited<ReturnType<typeof start>> | null = null;
  let second: Awaited<ReturnType<typeof start>> | null = null;
  let third: Awaited<ReturnType<typeof start>> | null = null;
  try {
    first = await start(root);
    const role = await first.client.call<{ readonly id: string }>('b3.agent.createRole', {
      ...governedRole('boot-final-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    }, mintClientOpId());
    assert.equal(role.ok, true, role.ok ? '' : role.error.message);
    if (!role.ok) return;

    const spawned = await first.client.call<RunView>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Boot Final', workingDirectory: tmpdir(),
    }, mintClientOpId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const watched = await first.client.call<WatchRuleView>('b3.supervision.createWatch', {
      subject: { kind: 'agent-run', agentRunId: spawned.value.run.id },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    }, mintClientOpId());
    assert.equal(watched.ok, true, watched.ok ? '' : watched.error.message);
    if (!watched.ok) return;

    await stop(first.host, first.client);
    first = null;

    second = await start(root);
    const notifications = await awaitNotifications(second.client, watched.value.id);
    assert.equal(notifications.length, 1,
      'boot settled the Run without queuing exactly one run-final Notification');
    assert.equal(notifications[0]?.state, 'queued');

    const published = await lifecycleEventsFor(second.client, spawned.value.run.id);
    assert.equal(published.length, 1,
      'boot did not publish exactly one lifecycle edge for the newly final Run');
    const { activityGeneration, ...payload } = published[0]!.payload;
    assert.equal(Number.isInteger(activityGeneration) && Number(activityGeneration) >= 0, true,
      'the lifecycle edge omitted its non-negative activity generation');
    assert.deepEqual(payload, {
      agentRunId: spawned.value.run.id,
      fromLifecycle: 'ready',
      toLifecycle: 'interrupted',
      uncertaintyCodes: ['provider-liveness-unknown'],
      final: true,
    });

    await stop(second.host, second.client);
    second = null;

    // This Run was already final before the next restart. Reconciliation is
    // replay-safe: it emits no second edge and Supervision queues nothing new.
    third = await start(root);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal((await lifecycleEventsFor(third.client, spawned.value.run.id)).length, 0,
      'an already-final Run re-fired its lifecycle edge on restart');
    assert.equal((await notificationsFor(third.client, watched.value.id)).length, 1,
      'an already-final Run queued a duplicate run-final Notification');
  } finally {
    if (first !== null) await stop(first.host, first.client);
    if (second !== null) await stop(second.host, second.client);
    if (third !== null) await stop(third.host, third.client);
    rmSync(root, { recursive: true, force: true });
  }
});
