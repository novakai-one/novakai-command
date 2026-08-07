// The B3c lifecycle as PRODUCTION runs it — §13.5 rows 6/9/10, §13.6, §25-B3c.
//
// B3c's capability line is "Managed Runs bind one Messaging endpoint and one
// Transcript source." Three independent verifiers found the same thing: the
// capability code is real and the production composition never calls it. Spawn
// recorded `endpoint-reserved`, `transcript-bound` and `endpoint-active` as
// `not-needed`, so a live governed Agent had `claim: null` and
// `UnknownAgentRun`.
//
// Every assertion below therefore goes through the PUBLISHED WIRE against a Run
// that `b3.agent.spawn` created. Nothing here constructs a claim, a binding or
// a store by hand — that is precisely the habit that let the slice pass its own
// suites while the product did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type B3Result, type ClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly root: string;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-lifecycle-'));
  const ptyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(), gateTimeoutMs: 2_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost, root,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function unwrap<T>(result: B3Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const opId = (): ClientOpId => mintClientOpId();

/** An UNGOVERNED role: this suite is about the B3c wire, not the skills gate. */
function plainRole(name: string): Record<string, unknown> {
  const role = governedRole(name);
  return {
    ...role,
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  };
}

interface SpawnedRun {
  readonly agentId: string;
  readonly agentRunId: string;
  readonly terminalSessionId?: string;
}

async function spawnOne(rig: Rig, name: string): Promise<SpawnedRun> {
  const role = unwrap(await rig.chris.call<{ id: string }>(
    'b3.agent.createRole', plainRole(`${name}-role`), opId(),
  ), 'createRole');
  const spawned = unwrap(await rig.chris.call<{
    agent: { agentId: string };
    run: { id: string; lifecycle: string; terminalSessionId?: string };
  }>('b3.agent.spawn', {
    roleProfileId: role.id, displayName: name, workingDirectory: tmpdir(),
  }, opId()), `spawn ${name}`);
  assert.equal(spawned.run.lifecycle, 'ready', `${name} did not reach ready`);
  return {
    agentId: spawned.agent.agentId,
    agentRunId: spawned.run.id,
    ...(spawned.run.terminalSessionId === undefined
      ? {} : { terminalSessionId: spawned.run.terminalSessionId }),
  };
}

interface EndpointView {
  readonly agentId: string;
  readonly claim: {
    readonly id: string;
    readonly agentRunId: string;
    readonly terminalSessionId: string;
    readonly state: string;
    readonly endpointGeneration: number;
  } | null;
  readonly endpointGeneration: number;
}

const endpointOf = async (rig: Rig, agentId: string): Promise<EndpointView> =>
  unwrap(await rig.chris.call<EndpointView>(
    'b3.messaging.getAgentEndpoint', { agentId }, opId(),
  ), 'getAgentEndpoint');

interface BindingView {
  readonly id: string;
  readonly agentRunId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly sourceDiscoveryState: string;
  readonly threadId: string;
}

const bindingOf = async (rig: Rig, agentRunId: string): Promise<B3Result<BindingView>> =>
  rig.chris.call<BindingView>('b3.transcript.getBinding', { agentRunId }, opId());

test('a spawned Run holds a LIVE Messaging endpoint claim, read through the wire', async () => {
  const rig = await createRig();
  try {
    const run = await spawnOne(rig, 'endpoint-owner');

    const endpoint = await endpointOf(rig, run.agentId);
    assert.notEqual(endpoint.claim, null,
      'nvk agent spawn produced a ready Run with no Messaging endpoint claim: '
      + 'the production Runtime never performed §13.5 row 6/10');
    assert.equal(endpoint.claim?.agentRunId, run.agentRunId,
      'the endpoint claim belongs to a different Run than the one that was spawned');
    assert.equal(endpoint.claim?.state, 'active',
      'the endpoint was reserved but never activated (§13.5 row 10)');
    assert.equal(endpoint.endpointGeneration >= 0, true,
      'a live endpoint must carry a real generation, not the empty -1');
  } finally {
    await rig.close();
  }
});

test('a spawned Run holds a Transcript binding, read through the wire', async () => {
  const rig = await createRig();
  try {
    const run = await spawnOne(rig, 'transcript-owner');

    const binding = await bindingOf(rig, run.agentRunId);
    assert.equal(binding.ok, true,
      binding.ok ? '' : `b3.transcript.getBinding: ${binding.error.code} — ${binding.error.message}`
        + ' — the production Runtime never performed §13.5 row 9');
    if (!binding.ok) return;
    assert.equal(binding.value.agentRunId, run.agentRunId);
    assert.equal(binding.value.agentId, run.agentId);
    // `waiting` is the honest first state for a Run whose provider file does
    // not exist yet (§25-B3c). Silence is not.
    assert.equal(
      ['bound', 'waiting'].includes(binding.value.sourceDiscoveryState), true,
      `first bind reported "${binding.value.sourceDiscoveryState}"`,
    );
    assert.notEqual(binding.value.threadId, '',
      'a binding with no Thread cannot mirror: every mirrored turn needs one');
  } finally {
    await rig.close();
  }
});

test('the spawn ladder records the three B3c stages as done, not deferred', async () => {
  const rig = await createRig();
  try {
    const run = await spawnOne(rig, 'ladder');
    const listed = unwrap(await rig.chris.call<readonly {
      readonly operation: {
        readonly kindOfOperation: string;
        readonly newRunId?: string;
        readonly completedStages: readonly {
          readonly stage: string;
          readonly owner: string;
          readonly ownerObjectId?: string;
          readonly outcome?: string;
          readonly notNeededBecause?: string;
        }[];
      };
    }[]>('b3.agent.listOperations', {}, opId()), 'listOperations');

    const stages = listed
      .filter((view) => view.operation.newRunId === run.agentRunId)
      .flatMap((view) => view.operation.completedStages);
    assert.notEqual(stages.length, 0, 'no spawn operation was recorded for that Run');
    for (const stage of ['endpoint-reserved', 'transcript-bound', 'endpoint-active']) {
      const recorded = stages.find((item) => item.stage === stage);
      assert.notEqual(recorded, undefined, `the ladder never recorded ${stage}`);
      assert.notEqual(recorded?.outcome, 'not-needed',
        `${stage} is still recorded as not-needed (${recorded?.notNeededBecause ?? ''}) — `
        + 'the capability it defers to shipped in this slice');
      assert.notEqual(recorded?.ownerObjectId, undefined,
        `${stage} completed without naming the object its owner created`);
    }
  } finally {
    await rig.close();
  }
});

test('a continuation transfers the endpoint to the new Run and finalises the old', async () => {
  const rig = await createRig();
  try {
    const first = await spawnOne(rig, 'continued');
    const before = await endpointOf(rig, first.agentId);
    assert.notEqual(before.claim, null, 'nothing to transfer: the first Run had no endpoint');

    const continued = unwrap(await rig.chris.call<{
      run: { id: string; lifecycle: string };
    }>('b3.agent.continue', {
      agentId: first.agentId,
      expectedOldRunId: first.agentRunId,
      mode: 'fresh',
      configurationMode: 'refresh-role',
    }, opId()), 'continue');
    assert.equal(continued.run.lifecycle, 'ready');

    const after = await endpointOf(rig, first.agentId);
    assert.notEqual(after.claim, null, 'the Agent lost its endpoint across a continuation');
    assert.equal(after.claim?.agentRunId, continued.run.id,
      'the endpoint still points at the OLD Run: §13.6 row "Messaging endpoint claim '
      + 'transferred atomically" never ran');
    assert.equal(after.claim?.state, 'active');
    assert.equal(after.endpointGeneration > before.endpointGeneration, true,
      'the endpoint generation did not move, so no transfer was committed');
  } finally {
    await rig.close();
  }
});
