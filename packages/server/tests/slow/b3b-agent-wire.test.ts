// Every `b3.agent.*` method, on a real socket, in the order a team actually
// lives (§16, §24.4, AMD-001 A-02).
//
// The B3a wire test learned this shape the hard way: it used to check ONE
// method and claim "every". So the method TABLE is read from the server rather
// than copied here — a method added without wire coverage fails this test
// instead of quietly riding along — and the calls are one team's life rather
// than fourteen unrelated pokes, because a method answering a valid request
// proves more than one answering a rejected one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, type B3Result,
} from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';
import { buildB3AgentMethods } from '../../core/b3/agent-methods.js';

interface WireState {
  managerRoleId: string;
  builderRoleId: string;
  managerAgentId: string;
  managerRunId: string;
  managerRunVersion: number;
  managerSupervisionVersion: number;
  builderAgentId: string;
  builderRunId: string;
  stopTreeToken: string;
  operationId: string;
}

interface WireStep {
  readonly method: string;
  readonly payload: (state: WireState) => Record<string, unknown>;
  readonly remember?: (state: WireState, value: unknown) => void;
  readonly outcome?: 'success' | 'domain-refusal';
  readonly requireClientOpId?: boolean;
}

const PROVIDER_TURN_ID = 'providerTurn_019fc81c-f754-731f-a2de-4d4af92ac200';
const TERMINAL_ID = 'terminal_019fc81c-f754-731f-a2de-4d4af92ac201';
const ATTACHMENT_ID = 'controller_019fc81c-f754-731f-a2de-4d4af92ac202';
const LEASE_ID = 'terminalInputLease_019fc81c-f754-731f-a2de-4d4af92ac203';
const BINDING_ID = `transcriptBinding_${'a'.repeat(52)}`;
const COMPLETION_ID = `transcriptTurnCompletion_${'b'.repeat(52)}`;
const USAGE_ID = `providerUsage_${'c'.repeat(52)}`;

function chatRole(
  name: string, allowedChildRoleIds: readonly string[], provider: string,
): Record<string, unknown> {
  return {
    name,
    description: `${name} for the wire suite`,
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

const runView = (value: unknown): {
  agent: { agentId: string };
  run: { id: string; recordVersion: number };
  family: { supervisionVersion: number };
} => value as never;

const WIRE_STEPS: readonly WireStep[] = [
  {
    method: 'b3.agent.createRole',
    payload: () => chatRole('wire-builder', [], 'codex'),
    remember: (state, value) => { state.builderRoleId = (value as { id: string }).id; },
  },
  {
    method: 'b3.agent.createRole',
    payload: (state) => chatRole('wire-manager', [state.builderRoleId], 'claude'),
    remember: (state, value) => { state.managerRoleId = (value as { id: string }).id; },
  },
  { method: 'b3.agent.getRoles', payload: () => ({}) },
  // A5-04: the name → id resolution the CLI used to do for itself. It takes its
  // turn here for the same reason every other method does — the guard below
  // fails any `b3.agent.*` the host serves and this walk never exercises.
  { method: 'b3.agent.resolveRoleByName', payload: () => ({ displayName: 'wire-builder' }) },
  {
    method: 'b3.agent.updateRole',
    payload: (state) => ({
      roleProfileId: state.managerRoleId,
      expectedRecordVersion: 1,
      // A whole replacement, never a patch: a role is what a spawn is pinned
      // to, so "change one field" would leave the rest silently inherited.
      replacement: {
        ...chatRole('wire-manager', [state.builderRoleId], 'claude'),
        description: 'the manager, described again',
      },
    }),
  },
  {
    method: 'b3.agent.spawn',
    payload: (state) => ({
      roleProfileId: state.managerRoleId,
      displayName: 'Wire Manager',
      workingDirectory: tmpdir(),
    }),
    remember: (state, value) => {
      const view = runView(value);
      state.managerAgentId = view.agent.agentId;
      state.managerRunId = view.run.id;
      state.managerRunVersion = view.run.recordVersion;
    },
  },
  {
    method: 'b3.agent.getRun',
    payload: (state) => ({ agentRunId: state.managerRunId }),
    remember: (state, value) => {
      state.managerRunVersion = runView(value).run.recordVersion;
    },
  },
  // OQ-09's agent form. It is the other half of `nvk agent inspect`: the same
  // command answers with the Agent rather than the Run when handed an Agent id,
  // and until B3e there was no operation behind it at all.
  { method: 'b3.agent.getAgent', payload: (state) => ({ agentId: state.managerAgentId }) },
  { method: 'b3.agent.listRuns', payload: () => ({ includeFinal: true, limit: 50 }) },
  {
    method: 'b3.agent.listTurnSubmissions',
    payload: (state) => ({
      agentRunId: state.managerRunId, includeTerminal: false, limit: 50,
    }),
  },
  {
    method: 'b3.agent.listProviderTurnCompletionEvidence',
    payload: (state) => ({ agentRunId: state.managerRunId, limit: 50 }),
  },
  {
    method: 'b3.agent.getTurnSubmission',
    payload: () => ({ providerTurnId: PROVIDER_TURN_ID }),
    outcome: 'domain-refusal',
  },
  {
    method: 'b3.agent.submitProviderTurn',
    payload: (state) => ({
      kind: 'controller',
      agentRunId: state.managerRunId,
      terminalSessionId: TERMINAL_ID,
      transcriptBindingId: BINDING_ID,
      attachmentId: ATTACHMENT_ID,
      inputLeaseId: LEASE_ID,
      leaseGeneration: 1,
      expectedNextInputSequence: 1,
      utf8Text: 'wire coverage',
    }),
    outcome: 'domain-refusal',
    requireClientOpId: true,
  },
  {
    method: 'b3.agent.ensureTurnCompletionEvidence',
    payload: () => ({ transcriptTurnCompletionId: COMPLETION_ID }),
    outcome: 'domain-refusal',
  },
  {
    method: 'b3.agent.completeProviderTurn',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      providerTurnId: PROVIDER_TURN_ID,
      expectedActiveTuple: { providerTurnId: PROVIDER_TURN_ID, activityGeneration: 1 },
      transcriptTurnCompletionId: COMPLETION_ID,
      providerUsageEvidenceId: USAGE_ID,
    }),
    outcome: 'domain-refusal',
  },
  {
    method: 'b3.agent.closeTurnCompletionUnproven',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      providerTurnId: PROVIDER_TURN_ID,
      reason: 'wire coverage of governed closure',
      completionEvidenceRefs: ['wire-test'],
    }),
    outcome: 'domain-refusal',
  },
  {
    method: 'b3.agent.getTree',
    payload: (state) => ({ rootAgentId: state.managerAgentId, maxDepth: 4 }),
  },
  {
    method: 'b3.agent.controls',
    payload: (state) => ({ agentRunId: state.managerRunId }),
  },
  {
    // The §16.2 spelling of the same call. Both are served, because scripts
    // already speak the short name and a second host reads the spec.
    method: 'b3.agent.getControls',
    payload: (state) => ({ agentRunId: state.managerRunId }),
  },
  {
    method: 'b3.agent.control',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      expectedRunVersion: state.managerRunVersion,
      control: { name: 'model', value: 'cli-default' },
    }),
  },
  {
    method: 'b3.agent.applyControl',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      expectedRunVersion: state.managerRunVersion,
      control: { name: 'model', value: 'cli-default' },
    }),
  },
  {
    method: 'b3.agent.beginTurn',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      expectedRecordVersion: state.managerRunVersion,
    }),
    remember: (state, value) => {
      state.managerRunVersion = runView(value).run.recordVersion;
    },
  },
  {
    method: 'b3.agent.interrupt',
    payload: (state) => ({
      agentRunId: state.managerRunId,
      expectedRecordVersion: state.managerRunVersion,
    }),
  },
  {
    method: 'b3.agent.getRun',
    payload: (state) => ({ agentRunId: state.managerRunId }),
    remember: (state, value) => {
      state.managerRunVersion = runView(value).run.recordVersion;
    },
  },
  {
    method: 'b3.agent.continue',
    payload: (state) => ({
      agentId: state.managerAgentId,
      expectedOldRunId: state.managerRunId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    }),
    remember: (state, value) => {
      const view = runView(value);
      state.managerRunId = view.run.id;
      state.managerRunVersion = view.run.recordVersion;
      state.managerSupervisionVersion = view.family.supervisionVersion;
    },
  },
  {
    // A human adopting an Agent they already root is a no-op in effect and a
    // real exercise of the CAS path — which is what this suite is checking.
    method: 'b3.agent.adopt',
    payload: (state) => ({
      subjectAgentId: state.managerAgentId,
      // Read off the view, which is the whole point of publishing it.
      expectedAssignmentVersion: state.managerSupervisionVersion,
      supervisor: { kind: 'human', principalId: 'person_chris' },
    }),
  },
  {
    // A second, unrelated Agent — so `stop` can be exercised on a live Run
    // without ending the one the rest of this life still needs.
    method: 'b3.agent.spawn',
    payload: (state) => ({
      roleProfileId: state.managerRoleId,
      displayName: 'Wire Solo',
      workingDirectory: tmpdir(),
    }),
    remember: (state, value) => {
      const view = runView(value);
      state.builderAgentId = view.agent.agentId;
      state.builderRunId = view.run.id;
    },
  },
  {
    method: 'b3.agent.stop',
    payload: (state) => ({
      agentId: state.builderAgentId,
      expectedLiveRunId: state.builderRunId,
      confirmation: 'stop-one',
    }),
  },
  {
    method: 'b3.agent.prepareStopTree',
    payload: (state) => ({ rootAgentId: state.managerAgentId }),
    remember: (state, value) => {
      state.stopTreeToken = (value as { confirmationToken: string }).confirmationToken;
    },
  },
  {
    method: 'b3.agent.stopTree',
    payload: (state) => ({
      rootAgentId: state.managerAgentId,
      confirmationToken: state.stopTreeToken,
      confirmation: 'stop-tree',
    }),
    remember: (state, value) => {
      state.operationId = (value as { operation: { id: string } }).operation.id;
    },
  },
  {
    method: 'b3.agent.getOperation',
    payload: (state) => ({ operationId: state.operationId }),
  },
  { method: 'b3.agent.listOperations', payload: () => ({}) },
  {
    // The stop above completed, so repairing it is the honest no-op case: the
    // door exists, answers, and does not re-drive a finished operation.
    method: 'b3.agent.repairOperation',
    payload: (state) => ({ operationId: state.operationId }),
  },
  {
    // The team is stopped, so nothing is freezing it. `null` is the answer.
    method: 'b3.agent.getTreeFence',
    payload: (state) => ({ agentId: state.managerAgentId }),
  },
  {
    method: 'b3.agent.issueGrant',
    payload: (state) => ({
      issuerAgentRunId: state.managerRunId,
      subjectAgentId: state.managerAgentId,
      targetAgentIds: [state.builderAgentId],
      requestedScopes: ['agent.interrupt'],
      requestedChildRoleIds: [],
    }),
  },
  { method: 'b3.agent.listGrants', payload: () => ({}) },
  {
    // Read the stream this whole life published, from the beginning.
    method: 'b3.agent.subscribeEvents',
    payload: () => ({ limit: 50 }),
  },
  {
    // What the gate WOULD have demanded, for a consumer that did not author
    // the role. This life's roles are chat roles, so the plan's gate is off —
    // the point is that the plan is readable at all (§12.1).
    method: 'b3.agent.getLaunchPlan',
    payload: (state) => ({ agentRunId: state.managerRunId }),
  },
];

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly client: RuntimeClient;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-wire-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, client,
    async close() {
      client.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('every b3.agent.* method answers on the v1 frame, in one team\'s life', async () => {
  const rig = await createRig();
  try {
    const served = Object.keys(buildB3AgentMethods({
      runtime: rig.host.runtime,
      principalFor: () => ({ id: 'person_chris' as never, kind: 'human', verifiedScopes: [] }),
      contextFor: (principal) => ({
        principal, clientOpId: '' as never, traceId: '' as never, contractVersion: 1,
      }),
    })).sort();
    const covered = [...new Set(WIRE_STEPS.map((step) => step.method))].sort();
    assert.deepEqual(served, covered,
      'a b3.agent method is served that this test never puts on the wire');

    const state: WireState = {
      managerRoleId: '', builderRoleId: '', managerAgentId: '', managerRunId: '',
      managerRunVersion: 0, managerSupervisionVersion: 0,
      builderAgentId: '', builderRunId: '',
      stopTreeToken: '', operationId: '',
    };

    for (const [index, step] of WIRE_STEPS.entries()) {
      const id = 500 + index;
      const raw = await rig.client.sendRaw({
        id, method: step.method, v: 1,
        params: {
          contractVersion: 1,
          ...(step.requireClientOpId === true ? { clientOpId: mintClientOpId() } : {}),
          payload: step.payload(state),
        },
      });
      assert.equal(raw.v, 1, `${step.method}: the response frame is not v1`);
      assert.equal(raw.id, id, `${step.method}: the frame id was not echoed`);
      assert.equal(raw.error, undefined,
        `${step.method}: a domain call used the frame-level error slot`);

      const result = raw.result as B3Result<unknown> | undefined;
      assert.equal(typeof result?.ok, 'boolean', `${step.method}: no Result inside result`);
      assert.equal(result?.ok, step.outcome !== 'domain-refusal',
        `${step.method} returned the wrong domain disposition: ${JSON.stringify(result)}`);
      if (result?.ok) step.remember?.(state, result.value);
    }
  } finally {
    await rig.close();
  }
});

test('an unknown b3.agent method is an unknown method, not a silent success', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 9001, method: 'b3.agent.doWhateverYouLike', v: 1,
      params: { contractVersion: 1, payload: {} },
    });
    assert.equal(raw.result, undefined);
    assert.match(String(raw.error), /unknown method/);
  } finally {
    await rig.close();
  }
});

test('a b3.agent method refuses a payload it cannot validate, before doing anything', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 9002, method: 'b3.agent.control', v: 1,
      params: {
        contractVersion: 1,
        payload: {
          agentRunId: 'agentRun_019fbd69-0000-7000-8000-000000000000',
          expectedRunVersion: 1,
          control: { name: 'telepathy', value: 'on' },
        },
      },
    });
    const result = raw.result as B3Result<unknown>;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ValidationFailed');
  } finally {
    await rig.close();
  }
});
