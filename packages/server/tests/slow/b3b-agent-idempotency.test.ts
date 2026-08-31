// A retry is a retry (§3.2, §4.5, §17.2, red gate 24).
//
// The receipt machinery underneath these calls was complete and correct, and it
// could never fire: `b3.agent.*` read the caller's `clientOpId` off the frame
// and then threw it away, minting a fresh one per call. So every retry was a
// second command — the same key spawned a second Agent, a second Run and a
// second real provider process, which is the exact failure `--client-op-id` was
// introduced to prevent. `commandReceipts.jsonl` grew to half a megabyte during
// the hold-out run without one receipt ever being consulted.
//
// Three properties, from §4.5's own wording: same key and same request returns
// the stored operation; same key and a different request is a conflict, never a
// second execution; a wrong-prefix key is REFUSED rather than quietly replaced
// by one the server minted (§4.1 — "validators MUST reject the wrong prefix").
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type ClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';
import { chatRole } from '../governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  roleId(name: string): Promise<string>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-idem-'));
  const ptyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost,
    async roleId(name) {
      const made = await chris.call<{ id: string }>(
        'b3.agent.createRole', chatRole(name), mintClientOpId(),
      );
      if (!made.ok) throw new Error(`createRole: ${made.error.message}`);
      return made.value.id;
    },
    async close() {
      await chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface RunView { agent: { agentId: string }; run: { id: string } }

test('the same clientOpId and the same request is ONE Agent, not two', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.roleId('idem-builder');
    const request = {
      roleProfileId, displayName: 'Idem Builder', workingDirectory: tmpdir(),
    };
    const retryKey = mintClientOpId();

    const first = await rig.chris.call<RunView>('b3.agent.spawn', request, retryKey);
    const second = await rig.chris.call<RunView>('b3.agent.spawn', request, retryKey);

    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    if (!first.ok || !second.ok) return;

    assert.equal(second.value.agent.agentId, first.value.agent.agentId,
      'the retry made a SECOND Agent');
    assert.equal(second.value.run.id, first.value.run.id, 'the retry made a SECOND Run');
    assert.equal(rig.ptyHost.started.length, 1,
      `the retry started ${String(rig.ptyHost.started.length)} provider processes`);
  } finally {
    await rig.close();
  }
});

test('the same clientOpId with a DIFFERENT request is a conflict, not a second spawn', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.roleId('idem-conflict');
    const retryKey = mintClientOpId();

    const first = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'First Name', workingDirectory: tmpdir(),
    }, retryKey);
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);

    const changed = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'A Different Name', workingDirectory: tmpdir(),
    }, retryKey);

    assert.equal(changed.ok, false, 'a different request under a used key was executed');
    if (changed.ok) return;
    assert.equal(changed.error.code, 'IdempotencyConflict');
    assert.equal(rig.ptyHost.started.length, 1,
      'a conflicting request still started a provider process');
  } finally {
    await rig.close();
  }
});

test('a wrong-prefix clientOpId is refused, never silently replaced', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.roleId('idem-prefix');
    // §4.1: "Validators MUST reject the wrong prefix even if the remaining
    // string is otherwise valid." Accepting it and minting a replacement throws
    // the caller's idempotency key away without telling it.
    const wrong = `cop_${crypto.randomUUID()}` as ClientOpId;

    const refused = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'Wrong Prefix', workingDirectory: tmpdir(),
    }, wrong);

    assert.equal(refused.ok, false, 'a wrong-prefix clientOpId was accepted');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'ValidationFailed');
    assert.equal(rig.ptyHost.started.length, 0,
      'a rejected clientOpId still started a provider process');
  } finally {
    await rig.close();
  }
});

test('a retried stop returns the stored outcome instead of stopping twice', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.roleId('idem-stop');
    const spawned = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'Stoppable', workingDirectory: tmpdir(),
    }, mintClientOpId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const request = {
      agentId: spawned.value.agent.agentId,
      expectedLiveRunId: spawned.value.run.id,
      confirmation: 'stop-one' as const,
    };
    const retryKey = mintClientOpId();
    const first = await rig.chris.call('b3.agent.stop', request, retryKey);
    const again = await rig.chris.call('b3.agent.stop', request, retryKey);

    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(again.ok, true,
      again.ok ? '' : `the replayed stop failed: ${again.error.code}`);
    assert.deepEqual(again, first, 'the replay was a second execution, not a replay');
  } finally {
    await rig.close();
  }
});
