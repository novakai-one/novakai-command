// B3e lane A — §17.2:3605, which became satisfiable the moment
// `AgentRunView.controllers` existed (A7-03 item 5 / T-06).
//
//   "Human output MUST say both launch origin and current controller truth,
//    for example: 'Started from Terminal.app; currently 0 controllers; Agent
//    is still running in Novakai Runtime.'"
//
// The CLI said the origin and stopped there. It could not say the rest: the
// projection carried no attachment truth at all, and the only other route to
// it — Run → terminalSessionId → getTerminalSession — is the CLI-only policy
// path OQ-02 rejected outright and §23 item 9 forbids. So this MUST had no
// lawful surface to resolve through, which is precisely why NVK-KIMI-094
// filed items 4 and 5 as a §24.5 proof gap rather than a tidy-up.
//
// The three §24.5 counts (0 / 1 / many) are asserted here as the rendering
// contract, together with the separation the same section red-gates: the
// controller count never changes what the line says about launch origin, and
// never becomes a statement about the lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRun } from '../cli/agent-describe.js';
import type { AgentRunView } from '../../agent-runtime/contract/index.js';

const unavailable = {
  quality: 'unavailable' as const, source: 'agents', limitations: [] as readonly string[],
};

/** A view that differs from its neighbours only in the section under test. */
function viewWith(controllers: AgentRunView['controllers']): AgentRunView {
  return {
    agent: {
      agentId: 'agent_1' as never,
      displayName: 'Builder',
      roleProfileId: 'agentRole_1' as never,
    },
    run: {
      id: 'agentRun_1', kind: 'agentRun', schemaVersion: 1, recordVersion: 3,
      createdAt: '2026-08-06T01:00:00.000Z', permissionLevel: 'private',
      createdBy: 'person_chris', agentId: 'agent_1', launchPlanId: 'launchPlan_1',
      providerSessionId: 'providerSession_1', lifecycle: 'running', activity: 'working',
      activityGeneration: 1, launchSurface: 'external-terminal', requestedBy: 'person_chris',
      uncertainty: [],
    } as unknown as AgentRunView['run'],
    provider: {
      provider: 'claude', modelId: 'claude-opus-5', effort: 'high',
      providerSessionId: 'providerSession_1' as never,
    },
    launch: {
      surface: 'external-terminal', requestedBy: 'person_chris' as never,
    },
    controllers,
    family: {
      childCount: 0,
      supervisor: { kind: 'human', principalId: 'person_chris' as never },
      supervisionVersion: 1 as never,
    },
    usage: {
      agentRunId: 'agentRun_1' as never,
      inputTokens: unavailable, outputTokens: unavailable, cachedInputTokens: unavailable,
      costMicros: unavailable, providerTurns: unavailable,
      observedAt: '2026-08-06T01:00:00.000Z' as never, final: false,
    } as unknown as AgentRunView['usage'],
    transcript: { bindingState: 'unbound' as const },
  };
}

test('zero controllers is SAID, not left to be inferred from silence', () => {
  const line = describeRun(viewWith({ attachedCount: 0, kinds: [] }));
  assert.match(line, /currently 0 controllers/u);
  // §24.5 red gate 4: this is not a claim that the Agent stopped.
  assert.match(line, /running/u);
});

test('one controller reads in the singular, and names its kind', () => {
  const line = describeRun(viewWith({ attachedCount: 1, kinds: ['novakai-shell'] }));
  assert.match(line, /currently 1 controller\b/u);
  assert.doesNotMatch(line, /1 controllers/u);
  assert.match(line, /novakai-shell/u);
});

test('many controllers read in the plural, and name every kind attached', () => {
  const line = describeRun(viewWith({
    attachedCount: 3, kinds: ['novakai-shell', 'external-terminal'],
  }));
  assert.match(line, /currently 3 controllers/u);
  assert.match(line, /novakai-shell/u);
  assert.match(line, /external-terminal/u);
});

test('launch origin is unchanged by the controller count (§19.1:3829)', () => {
  const none = describeRun(viewWith({ attachedCount: 0, kinds: [] }));
  const some = describeRun(viewWith({ attachedCount: 2, kinds: ['script'] }));
  for (const line of [none, some]) {
    assert.match(line, /Started from external-terminal by person_chris/u);
  }
});

test('the input-lease holder is named when there is one, and not guessed at when there is not', () => {
  const holder = 'controller_019fd400-0000-7000-8000-000000000001';
  const held = describeRun(viewWith({
    attachedCount: 1, kinds: ['novakai-shell'], inputLeaseHolder: holder as never,
  }));
  assert.match(held, new RegExp(holder, 'u'));

  // Omitted means "no lease holder", never "unknown" — so the line must not
  // invent a word like "unknown" for a fact the owner stated by omission.
  const free = describeRun(viewWith({ attachedCount: 1, kinds: ['novakai-shell'] }));
  assert.doesNotMatch(free, /unknown/iu);
  assert.doesNotMatch(free, /controller_/u);
});
