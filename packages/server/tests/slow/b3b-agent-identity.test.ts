// Who the caller IS, over a real socket (§12.1, DEC-B3V4-05, red gates 5 and 13).
//
// B3b is the first slice where "the caller" stopped being one local human: an
// Agent running inside its own managed PTY calls `nvk agent spawn` too. Two
// things therefore have to be true at the door, and neither is checkable by
// reading the happy path:
//
//   1. a credential that does NOT verify is refused — never quietly downgraded
//      to the human who owns the machine (which would hand a forged Agent every
//      scope Chris has);
//   2. a credential that DOES verify names WHICH Run, because `principal.id` is
//      what lands in `createdBy`/`requestedBy` on every record it writes. One
//      shared literal would make every Agent's attribution identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { B3Result } from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import type { AgentRunView } from '../../../agent-runtime/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly root: string;
  asRun(agentRunId: string): Promise<RuntimeClient>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-identity-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const opened: RuntimeClient[] = [];
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  opened.push(chris);
  return {
    host, chris, root,
    async asRun(agentRunId) {
      const client = await connectRuntime({
        root, port: host.port, token: host.token, agentRunId,
        runToken: host.runtime.credentials.issue(agentRunId as never).NVK_AGENT_RUN_TOKEN,
      });
      opened.push(client);
      return client;
    },
    async close() {
      for (const client of opened) client.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

/** A role whose gate is off, so these tests are about identity and nothing else. */
function chatRole(
  name: string, allowedChildRoleIds: readonly string[], provider: string,
): Record<string, unknown> {
  return {
    name,
    description: `${name} for the identity suite`,
    status: 'active',
    providerPolicy: { allowed: [provider], defaultProvider: provider },
    modelPolicy: {
      allowedModelIds: ['cli-default'], defaultModelId: 'cli-default',
      allowNativeChange: false, allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
    skillRefs: [], hookRefs: [], instructionRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
    spawnPolicy: { allowedChildRoleIds, requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['fresh', 'resume'],
    },
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: [],
      parentNotificationMode: 'queue-only',
    },
    budgetPolicy: { hardStopEnabled: false },
  };
}

test('a Run credential that does not verify is refused, never downgraded to the human', async () => {
  const rig = await createRig();
  try {
    // The exact shape of a forgery: a plausible Run id and a token that is not
    // the one the Runtime issued for it.
    await assert.rejects(
      connectRuntime({
        root: rig.root, port: rig.host.port, token: rig.host.token,
        agentRunId: 'agentRun_019fbd69-0000-7000-8000-000000000000',
        runToken: 'not-the-token-the-runtime-issued',
      }),
      'a socket presenting an unverifiable Run credential must not connect at all',
    );

    // Half a claim is still a claim: an id with no token cannot fall through to
    // "well, it must be Chris then".
    await assert.rejects(
      connectRuntime({
        root: rig.root, port: rig.host.port, token: rig.host.token,
        agentRunId: 'agentRun_019fbd69-0000-7000-8000-000000000000',
        runToken: '',
      }),
    );
  } finally {
    await rig.close();
  }
});

test('a verified Agent is attributed to ITS OWN Run, not to a shared literal', async () => {
  const rig = await createRig();
  try {
    const auditorRole = unwrap(
      await rig.chris.call<{ id: string }>('b3.agent.createRole', chatRole('id-auditor', [], 'kimi')),
      'create auditor role',
    );
    const builderRole = unwrap(
      await rig.chris.call<{ id: string }>('b3.agent.createRole',
        chatRole('id-builder', [auditorRole.id], 'codex')),
      'create builder role',
    );
    const managerRole = unwrap(
      await rig.chris.call<{ id: string }>('b3.agent.createRole',
        chatRole('id-manager', [builderRole.id], 'claude')),
      'create manager role',
    );

    const manager = unwrap(await rig.chris.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: managerRole.id, displayName: 'Manager', workingDirectory: rig.root,
    }), 'spawn manager');

    const asManager = await rig.asRun(manager.run.id);
    const builder = unwrap(await asManager.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: builderRole.id, displayName: 'Builder', workingDirectory: rig.root,
    }), 'spawn builder');

    const asBuilder = await rig.asRun(builder.run.id);
    const auditor = unwrap(await asBuilder.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: auditorRole.id, displayName: 'Auditor', workingDirectory: rig.root,
    }), 'spawn auditor');

    // The fact under test: `requestedBy` is `principal.id`, so two different
    // Agents asking for the same thing must not leave the same trace.
    assert.notEqual(builder.launch.requestedBy, auditor.launch.requestedBy,
      'two different Agent Runs wrote the same requestedBy — attribution is collapsed');

    // And it must name the Run that actually asked, so a reader can follow it.
    assert.match(String(builder.launch.requestedBy), new RegExp(manager.run.id),
      'the Builder\'s requestedBy does not name the Manager Run that spawned it');
    assert.match(String(auditor.launch.requestedBy), new RegExp(builder.run.id),
      'the Auditor\'s requestedBy does not name the Builder Run that spawned it');

    // The human's own trace stays the human's.
    assert.notEqual(manager.launch.requestedBy, builder.launch.requestedBy);
    assert.equal(manager.launch.surface, 'novakai-shell');
    assert.equal(builder.launch.surface, 'agent');
  } finally {
    await rig.close();
  }
});

test('identity comes from the connection, so a payload cannot name its own parent', async () => {
  const rig = await createRig();
  try {
    const childRole = unwrap(
      await rig.chris.call<{ id: string }>('b3.agent.createRole', chatRole('claim-child', [], 'kimi')),
      'create child role',
    );
    const parentRole = unwrap(
      await rig.chris.call<{ id: string }>('b3.agent.createRole',
        chatRole('claim-parent', [childRole.id], 'claude')),
      'create parent role',
    );
    const parent = unwrap(await rig.chris.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: parentRole.id, displayName: 'Parent', workingDirectory: rig.root,
    }), 'spawn parent');

    // Chris's own connection asks for a child AND claims to be the parent Run.
    // The claim is in `params`; it must change nothing.
    const claimed = await rig.chris.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: childRole.id,
      displayName: 'Claimed',
      workingDirectory: rig.root,
      principal: { id: 'agentRun_forged', kind: 'agent-run', agentRunId: parent.run.id },
      parentAgentId: parent.agent.agentId,
      requestedBy: parent.run.id,
    });

    // Chris's role is not the parent role, so the human may not spawn this child
    // at all — and the refusal proves the claim was not read.
    if (claimed.ok) {
      assert.equal(claimed.value.family.parentAgentId, undefined,
        'a parent claimed in params became a real family edge');
      assert.notEqual(String(claimed.value.launch.requestedBy), parent.run.id);
      assert.equal(claimed.value.launch.surface, 'novakai-shell');
    }
  } finally {
    await rig.close();
  }
});
