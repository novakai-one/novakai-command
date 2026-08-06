// B3.2 — FZ-VIEW-001's `lifecycle` slice, the `runtime` slice, and the
// `runs.getAgentRun` member the implemented door dropped (finding L-20).
//
// The frozen facade is six slices. The Shell shipped three, so "Stop and close"
// (FZ-VIEW-033) had no route and was drawn as a stated limit (L-18). These tests
// pin the door's SHAPE first — a slice that goes missing again fails loudly
// rather than becoming another stated limit six seats later.
import { describe, expect, it } from 'vitest';
import {
  SHELL_AGENT_SERVICES_FROZEN, SHELL_AGENT_SERVICES_UNWIRED,
  type AgentRunRowView, type ShellReadResult,
} from '../contract/agentRuns.js';
import {
  planTerminalStop, describeStopRefusal,
  type StopAgentRequest,
} from '../contract/agentLifecycle.js';
import {
  SHELL_STOP_DOORS, terminalStopPath,
} from '../contract/terminalClose.js';
import { createShellAgentServices } from '../app/agentRuns.js';
import type { TabSessionTruth } from '../contract/terminalTabStrip.js';
import type { TerminalTabView } from '../contract/terminalServices.js';

/** A call recorder standing in for the socket. Records method AND payload. */
function recorder(answer: unknown = { ok: true, value: {} }) {
  const calls: { method: string; payload: unknown }[] = [];
  return {
    calls,
    call: async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      return answer;
    },
  };
}

const RUN_ID = 'agentRun_11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'agent_22222222-2222-4222-8222-222222222222';

function runRow(patch: Partial<AgentRunRowView['run']> = {}): AgentRunRowView {
  return {
    agent: { agentId: AGENT_ID, displayName: 'Scout', roleProfileId: 'agentRole_1' },
    run: {
      id: RUN_ID, kind: 'agentRun', schemaVersion: 1, recordVersion: 4,
      createdAt: '2026-08-06T10:00:00.000Z', permissionLevel: 'standard',
      createdBy: 'chris', lastMutation: {}, agentId: AGENT_ID,
      launchPlanId: 'plan_1', providerSessionId: 'ps_1', lifecycle: 'running',
      activity: 'working', activityGeneration: 3, launchSurface: 'novakai-shell',
      requestedBy: 'chris', rootTraceId: 'trace_1', uncertainty: [],
      ...patch,
    },
    provider: { provider: 'kimi', modelId: 'k2', effort: 'high', providerSessionId: 'ps_1' },
    launch: { surface: 'novakai-shell', requestedBy: 'chris' },
    family: {
      childCount: 0, supervisor: { kind: 'human', principalId: 'chris' },
      supervisionVersion: 1,
    },
    usage: {
      agentRunId: RUN_ID,
      inputTokens: { quality: 'measured', value: 10, source: 'provider', limitations: [] },
      outputTokens: { quality: 'measured', value: 5, source: 'provider', limitations: [] },
      cachedInputTokens: { quality: 'unavailable', source: 'provider', limitations: [] },
      costMicros: { quality: 'unavailable', source: 'provider', limitations: [] },
      providerTurns: { quality: 'measured', value: 1, source: 'provider', limitations: [] },
      observedAt: '2026-08-06T10:00:00.000Z', final: false,
    },
    transcript: { bindingState: 'bound' },
  };
}

function agentTab(label = RUN_ID): TabSessionTruth {
  const view: TerminalTabView = {
    terminalSessionId: 'term_1', status: 'live',
    owner: { kind: 'agent-run', label },
    workingDirectory: '/tmp', attachedControllerCount: 1, holdsInputLease: true,
    replay: { earliestSequence: 1, latestSequence: 9 }, nextInputSequence: 3,
  };
  return { known: true, view };
}

describe('the frozen door has six slices (FZ-VIEW-001, finding L-20)', () => {
  const services = createShellAgentServices({ call: async () => ({ ok: true, value: {} }) });

  it('publishes exactly the frozen slice names', () => {
    expect(Object.keys(services).sort()).toEqual(Object.keys(SHELL_AGENT_SERVICES_FROZEN).sort());
  });

  /**
   * The whole finding, as one assertion: wired ∪ unwired === frozen, exactly.
   * A slice that goes missing fails; a member wired without being struck off the
   * unwired list fails; a member the freeze never named fails hardest of all.
   */
  it('accounts for every frozen member — wired, or named as unwired', () => {
    for (const [slice, members] of Object.entries(SHELL_AGENT_SERVICES_FROZEN)) {
      const wired = Object.keys(services[slice as keyof typeof services]);
      const unwired = members.filter(
        (member) => SHELL_AGENT_SERVICES_UNWIRED[`${slice}.${member}`] !== undefined,
      );
      expect([...wired, ...unwired].sort(), `slice ${slice}`).toEqual([...members].sort());
    }
  });

  it('names the seven lifecycle operations the freeze names, and wires all seven', () => {
    expect(SHELL_AGENT_SERVICES_FROZEN.lifecycle).toEqual([
      'spawnAgent', 'interruptAgentTurn', 'stopAgent', 'prepareStopAgentTree',
      'stopAgentTree', 'continueAgent', 'adoptAgent',
    ]);
    expect(Object.keys(SHELL_AGENT_SERVICES_UNWIRED)
      .filter((entry) => entry.startsWith('lifecycle.'))).toEqual([]);
  });

  it('every unwired entry names a member the freeze actually has', () => {
    for (const entry of Object.keys(SHELL_AGENT_SERVICES_UNWIRED)) {
      const [slice, member] = entry.split('.');
      expect(SHELL_AGENT_SERVICES_FROZEN[slice!], entry).toContain(member);
    }
  });
});

describe('the lifecycle slice speaks the published methods', () => {
  it('stopAgent sends b3.agent.stop with the frozen input, verbatim', async () => {
    const wire = recorder({ ok: true, value: { kind: 'stopped' } });
    const services = createShellAgentServices({ call: wire.call });
    const request: StopAgentRequest = {
      agentId: AGENT_ID, expectedLiveRunId: RUN_ID, confirmation: 'stop-one',
    };
    const outcome = await services.lifecycle.stopAgent(request);

    expect(wire.calls).toEqual([{ method: 'b3.agent.stop', payload: request }]);
    expect(outcome).toEqual({ ok: true, value: { kind: 'stopped' } });
  });

  it('interruptAgentTurn sends b3.agent.interrupt with the record version it read', async () => {
    const wire = recorder({ ok: true, value: { kind: 'interrupted' } });
    const services = createShellAgentServices({ call: wire.call });
    await services.lifecycle.interruptAgentTurn({ agentRunId: RUN_ID, expectedRecordVersion: 4 });

    expect(wire.calls[0]).toEqual({
      method: 'b3.agent.interrupt',
      payload: { agentRunId: RUN_ID, expectedRecordVersion: 4 },
    });
  });

  it('routes the other five to their published names', async () => {
    const wire = recorder();
    const services = createShellAgentServices({ call: wire.call });
    await services.lifecycle.spawnAgent({
      roleProfileId: 'agentRole_1', displayName: 'Scout', workingDirectory: '/tmp',
    });
    await services.lifecycle.prepareStopAgentTree({ rootAgentId: AGENT_ID });
    await services.lifecycle.stopAgentTree({
      rootAgentId: AGENT_ID, confirmationToken: 'tok', confirmation: 'stop-tree',
    });
    await services.lifecycle.continueAgent({
      agentId: AGENT_ID, expectedOldRunId: RUN_ID,
      mode: 'fresh-context', configurationMode: 'same',
    });
    await services.lifecycle.adoptAgent({
      subjectAgentId: AGENT_ID, expectedAssignmentVersion: 1,
      supervisor: { kind: 'human', principalId: 'chris' },
    });

    expect(wire.calls.map((entry) => entry.method)).toEqual([
      'b3.agent.spawn', 'b3.agent.prepareStopTree', 'b3.agent.stopTree',
      'b3.agent.continue', 'b3.agent.adopt',
    ]);
  });

  it('omits an absent optional rather than sending it as undefined', async () => {
    const wire = recorder();
    const services = createShellAgentServices({ call: wire.call });
    await services.lifecycle.continueAgent({
      agentId: AGENT_ID, expectedOldRunId: RUN_ID,
      mode: 'fresh-context', configurationMode: 'same',
    });
    expect(Object.keys(wire.calls[0]!.payload as object)).toEqual([
      'agentId', 'expectedOldRunId', 'mode', 'configurationMode',
    ]);
  });

  it('draws a dead socket as a value, never an exception', async () => {
    const services = createShellAgentServices({
      call: async () => { throw new Error('socket closed'); },
    });
    const outcome = await services.lifecycle.stopAgent({
      agentId: AGENT_ID, expectedLiveRunId: RUN_ID, confirmation: 'stop-one',
    });
    expect(outcome).toEqual({
      ok: false, error: { code: 'RuntimeUnavailable', message: 'socket closed' },
    });
  });

  it('keeps the Runtime own refusal code and message', async () => {
    const services = createShellAgentServices({
      call: async () => ({ ok: false, error: { code: 'VersionConflict', message: 'run moved on' } }),
    });
    const outcome = await services.lifecycle.stopAgent({
      agentId: AGENT_ID, expectedLiveRunId: RUN_ID, confirmation: 'stop-one',
    });
    expect(outcome).toEqual({
      ok: false, error: { code: 'VersionConflict', message: 'run moved on' },
    });
  });
});

describe('runs.getAgentRun — the member the implemented door dropped', () => {
  it('sends b3.agent.getRun and hands the row back untouched', async () => {
    const row = runRow();
    const wire = recorder({ ok: true, value: row });
    const services = createShellAgentServices({ call: wire.call });
    const answer = await services.runs.getAgentRun({ agentRunId: RUN_ID });

    expect(wire.calls).toEqual([{ method: 'b3.agent.getRun', payload: { agentRunId: RUN_ID } }]);
    expect(answer.ok && answer.value).toBe(row);
  });

  it('refuses something that is not a Run row rather than handing it on', async () => {
    const services = createShellAgentServices({ call: async () => ({ ok: true, value: { nope: 1 } }) });
    const answer = await services.runs.getAgentRun({ agentRunId: RUN_ID });
    expect(answer.ok).toBe(false);
  });
});

describe('runtime.getRuntimeStatus — the sixth slice', () => {
  it('sends b3.runtime.getStatus with no payload of its own', async () => {
    const wire = recorder({ ok: true, value: { activeEpochId: 'e1' } });
    const services = createShellAgentServices({ call: wire.call });
    await services.runtime.getRuntimeStatus();
    expect(wire.calls).toEqual([{ method: 'b3.runtime.getStatus', payload: {} }]);
  });
});

describe('planTerminalStop — a stop is aimed at what was READ, never guessed', () => {
  it('builds the frozen input from the Run row and the tab own subject', () => {
    const plan = planTerminalStop(RUN_ID, { ok: true, value: runRow() });
    expect(plan).toEqual({
      send: true,
      request: { agentId: AGENT_ID, expectedLiveRunId: RUN_ID, confirmation: 'stop-one' },
    });
  });

  it('refuses when the read failed — no agentId is invented from the run id', () => {
    const read: ShellReadResult<AgentRunRowView> = {
      ok: false, error: { code: 'RuntimeUnavailable', message: 'socket closed' },
    };
    const plan = planTerminalStop(RUN_ID, read);
    expect(plan.send).toBe(false);
    expect(plan.send === false && plan.because).toContain('socket closed');
  });

  it('refuses a row that is about a DIFFERENT Run', () => {
    const plan = planTerminalStop('agentRun_99999999-9999-4999-8999-999999999999', {
      ok: true, value: runRow(),
    });
    expect(plan.send).toBe(false);
    expect(plan.send === false && plan.because).toContain('a different Run');
  });

  it('refuses a Run the owner already reported as ended, and sends nothing', () => {
    const plan = planTerminalStop(RUN_ID, {
      ok: true,
      value: runRow({ finalAt: '2026-08-06T10:30:00.000Z', finalReason: 'completed' }),
    });
    expect(plan.send).toBe(false);
    expect(plan.send === false && plan.because).toContain('already');
  });

  it('never reads liveness off the lifecycle enum (OQ-07: finalAt is the observable)', () => {
    // `interrupted` with no finalAt is NOT final — reconciliation has not spoken.
    const plan = planTerminalStop(RUN_ID, { ok: true, value: runRow({ lifecycle: 'interrupted' }) });
    expect(plan.send).toBe(true);
  });

  it('says what happened in a sentence for the dialog, not a code', () => {
    expect(describeStopRefusal('Novakai could not read the Run.')).toContain('still running');
  });

  it('does not fuse the owner sentence into its own', () => {
    // Read off a PNG: "…this Run has already moved on The session and the Agent
    // behind it are still running". The reason is composed from an owner-supplied
    // `message`, and no owner promises terminal punctuation — so the consequence,
    // which is the half a person actually needs, ran on as a subordinate clause
    // of somebody else's sentence.
    const said = describeStopRefusal('VersionConflict: this Run has already moved on');
    expect(said).toContain('moved on. The session');
    expect(said).not.toContain('moved on The session');
  });

  it('adds no second full stop to a reason that already ends in one', () => {
    expect(describeStopRefusal('Novakai could not read the Run.')).not.toContain('Run.. ');
    expect(describeStopRefusal('Is it gone?')).toContain('Is it gone? The session');
  });
});

describe('the stop door is open now, and only for Agent terminals (L-18 ruling)', () => {
  it('SHELL_STOP_DOORS declares the lifecycle route reachable', () => {
    expect(SHELL_STOP_DOORS.agentRunLifecycle).toBe(true);
  });

  it('an Agent-owned session has a real route', () => {
    expect(terminalStopPath(agentTab(), SHELL_STOP_DOORS)).toEqual({
      reachable: true, route: 'agent-run-lifecycle',
    });
  });

  it('a plain shell keeps the stated limit even with the door open', () => {
    const plain: TabSessionTruth = {
      known: true,
      view: {
        terminalSessionId: 'term_2', status: 'live',
        owner: { kind: 'plain-shell', label: 'novakai-shell' },
        workingDirectory: '/tmp', attachedControllerCount: 1, holdsInputLease: true,
        replay: { earliestSequence: 1, latestSequence: 2 }, nextInputSequence: 1,
      },
    };
    const path = terminalStopPath(plain, SHELL_STOP_DOORS);
    expect(path.reachable).toBe(false);
    expect(path.reachable === false && path.because).toContain('plain shell');
  });

  it('an unaccounted-for session still has nothing to stop', () => {
    const path = terminalStopPath({ known: false }, SHELL_STOP_DOORS);
    expect(path.reachable).toBe(false);
  });
});
