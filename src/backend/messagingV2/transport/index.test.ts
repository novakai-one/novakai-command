/**
 * Terminal-host presence transport — contract-discipline tests (slice N2),
 * porting the cases of packages/messaging/tests/adapters/transport-contract.test.ts
 * against this adapter over a fake in-memory TerminalRuntime (the N1 pattern:
 * ported cases, constructed directly, no package-suite import). Covers: a
 * bound live lane effects REAL bytes (G10) with the exact submission shape
 * (text format, settle/leadIn/kimi-flush timings); push is an honest no-op
 * on a live lane; an unbound lane is a TRANSIENT failure (the bind window),
 * never presence-gone; a dead lane NEVER reports effect; and a lane death
 * raises onDisconnect into the core's single presence-close path (R9).
 * Run with `npx tsx src/backend/messagingV2/transport/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { schemaVersion } from '../../../../packages/messaging/public/contract/index.js';
import type { Message, PresenceId } from '../../../../packages/messaging/public/contract/index.js';
import type { TransportLivenessCallbacks } from '../../../../packages/messaging/seams/presenceTransport.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { createTerminalHostTransport } from './index.js';

function agentInfo(agentId: string, title: string, provider: AgentInfo['provider'] = 'claude'): AgentInfo {
  return {
    agentId, title, provider, sessionId: 'session',
    projectDir: 'project', cwd: '/tmp/project', status: 'running', createdAt: new Date().toISOString(),
  };
}

class FakeTerminalRuntime implements TerminalRuntime {
  readonly submissions: SubmitJob[] = [];
  private readonly exitListeners: Array<(agentId: string, exitCode: number | null) => void> = [];
  accepting = true;
  constructor(private agents: AgentInfo[]) {}
  create(): Promise<AgentInfo> { return Promise.reject(new Error('unused')); }
  write(): boolean { return true; }
  submit(submission: SubmitJob): boolean {
    if (!this.accepting) return false;
    this.submissions.push(submission);
    return true;
  }
  activity(): null { return null; }
  resize(): boolean { return true; }
  rename(): boolean { return true; }
  kill(): boolean { return true; }
  archive(): boolean { return true; }
  snapshot(): string { return ''; }
  list(): AgentInfo[] { return this.agents; }
  onData(): void {}
  onExit(callback: (agentId: string, exitCode: number | null) => void): void { this.exitListeners.push(callback); }
  onSession(): void {}
  exitAgent(agentId: string): void {
    this.agents = this.agents.map((agent) =>
      agent.agentId === agentId ? { ...agent, status: 'exited' } : agent);
    for (const callback of this.exitListeners) callback(agentId, 0);
  }
}

function makeMessage(text: string, senderId = 'person_agent-sender'): Message {
  return {
    id: 'message_1' as Message['id'],
    kind: 'message',
    schemaVersion,
    createdAt: '2026-07-22T10:00:00.000Z' as Message['createdAt'],
    threadId: 'thread_1' as Message['threadId'],
    senderId: senderId as Message['senderId'],
    clientMessageId: 'cm-1' as Message['clientMessageId'],
    sequence: 1 as Message['sequence'],
    priority: 'normal',
    body: { text },
  };
}

const SENDER = agentInfo('agent_sender', 'chief-kimi', 'kimi');
const PEER = agentInfo('agent_peer', 'worker-b', 'claude');
const KIMI_PEER = agentInfo('agent_kimi-peer', 'worker-k', 'kimi');

// --- deliver to a bound live lane is a REAL effect with the exact submission ----

{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_a' as PresenceId;
  assert.equal(transport.kind, 'pty', 'registered under the contract pty TransportKind');
  assert.equal(transport.bind(presenceId, PEER.agentId), true);
  const report = await transport.deliver(presenceId, { message: makeMessage('hello'), priority: 'normal' });
  assert.deepEqual(report, { kind: 'effect' }, 'the transport confirmed a real effect');
  const submission = terminals.submissions[0];
  assert.equal(submission?.agentId, PEER.agentId, 'the effect names its agent lane');
  assert.equal(submission?.messageId, 'message_1', 'dedupe rides the messageId (D2)');
  assert.equal(submission?.text, '[nvk-msg from chief-kimi id message_1] hello',
    'sender personId → agentId → live terminal title');
  assert.equal(submission?.settleMs, 900, 'old DEFAULT_TIMINGS submit delay');
  assert.equal(submission?.flushMs, undefined, 'no flush for non-kimi providers');
  assert.equal(submission?.leadIn, undefined, 'no Esc lead-in for normal priority');
  console.log('deliver effect test passed');
}

// --- urgent leads with Esc; kimi recipients get the flush \r --------------------

{
  const terminals = new FakeTerminalRuntime([SENDER, KIMI_PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_b' as PresenceId;
  transport.bind(presenceId, KIMI_PEER.agentId);
  await transport.deliver(presenceId, { message: makeMessage('wake up'), priority: 'urgent' });
  const submission = terminals.submissions[0];
  assert.deepEqual(submission?.leadIn, { data: '\x1b', settleMs: 400 }, 'interrupt Esc rides inside the lane (C2)');
  assert.equal(submission?.flushMs, 6000, 'kimi-only flush (old DEFAULT_TIMINGS)');
  console.log('urgent + kimi timings test passed');
}

// --- newline flattening + display-name fallback ------------------------------------

{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_c' as PresenceId;
  transport.bind(presenceId, PEER.agentId);
  await transport.deliver(presenceId, { message: makeMessage('line1\nline2\r\nline3'), priority: 'normal' });
  assert.match(terminals.submissions[0]?.text ?? '', /line1\\nline2\\nline3$/, 'newlines flatten to literal \\n');
  await transport.deliver(presenceId, { message: makeMessage('boss note', 'person_user-chris'), priority: 'normal' });
  assert.match(terminals.submissions[1]?.text ?? '', /\[nvk-msg from person_user-chris id message_1\]/,
    'a non-agent sender falls back to its personId string');
  console.log('format tests passed');
}

// --- push on a live lane is an honest no-op effect ---------------------------------

{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_d' as PresenceId;
  transport.bind(presenceId, PEER.agentId);
  const frame = { kind: 'started', subscriptionId: 'subscription_x' } as never;
  const report = await transport.push(presenceId, frame);
  assert.deepEqual(report, { kind: 'effect' }, 'observation lane reports effect on a live lane');
  assert.equal(terminals.submissions.length, 0, 'PTY agents never receive subscription frames');
  console.log('push no-op test passed');
}

// --- an unbound lane is a TRANSIENT failure, never presence-gone --------------------

{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const unbound = 'presence_never-bound' as PresenceId;
  for (const report of [
    await transport.deliver(unbound, { message: makeMessage('early'), priority: 'normal' }),
    await transport.push(unbound, { kind: 'started', subscriptionId: 'subscription_x' } as never),
  ]) {
    assert.equal(report.kind, 'failure');
    if (report.kind === 'failure') {
      assert.equal(report.retryable, true, 'retried inside the R5 budget');
      assert.equal(report.permanent, undefined, 'unbound ≠ gone');
    }
  }
  console.log('unbound transient test passed');
}

// --- a dead lane NEVER reports effect ------------------------------------------------

{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_e' as PresenceId;
  transport.bind(presenceId, PEER.agentId);
  terminals.exitAgent(PEER.agentId);
  const delivered = await transport.deliver(presenceId, { message: makeMessage('too late'), priority: 'normal' });
  assert.equal(delivered.kind, 'failure', 'no effect is ever reported against a corpse');
  const pushed = await transport.push(presenceId, { kind: 'started', subscriptionId: 'subscription_x' } as never);
  assert.equal(pushed.kind, 'failure');
  assert.equal(terminals.submissions.length, 0, 'nothing was typed into the dead lane');
  console.log('dead-lane honesty test passed');
}

// --- restored-exited agent: presence-gone; submit refusal re-reads the truth --------

{
  const dead = { ...PEER, status: 'exited' as const };
  const terminals = new FakeTerminalRuntime([SENDER, dead]);
  const transport = createTerminalHostTransport(terminals);
  assert.equal(
    transport.bind('presence_f' as PresenceId, dead.agentId),
    false,
    'no bind onto an exited terminal (spawn→bind window)',
  );
  const refusing = new FakeTerminalRuntime([SENDER, PEER]);
  refusing.accepting = false;
  const liveTransport = createTerminalHostTransport(refusing);
  liveTransport.bind('presence_g' as PresenceId, PEER.agentId);
  const refused = await liveTransport.deliver('presence_g' as PresenceId, {
    message: makeMessage('retry me'), priority: 'normal',
  });
  assert.equal(refused.kind, 'failure');
  if (refused.kind === 'failure') {
    assert.equal(refused.retryable, true, 'a refused submit on a still-live agent is transient');
    assert.equal(refused.permanent, undefined);
  }
  console.log('bind-window + submit-refusal test passed');
}

// --- a lane death raises onDisconnect into the core's single close path (R9) ---------
{
  const terminals = new FakeTerminalRuntime([SENDER, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const disconnected: PresenceId[] = [];
  const liveness: TransportLivenessCallbacks = {
    onDisconnect(presenceId) { disconnected.push(presenceId); },
    onLivenessTimeout() {},
  };
  transport.attachLiveness(liveness);
  const presenceId = 'presence_h' as PresenceId;
  transport.bind(presenceId, PEER.agentId);
  terminals.exitAgent(PEER.agentId);
  assert.deepEqual(disconnected, [presenceId], 'the adapter reported the death — the core never infers liveness');
  assert.equal(transport.boundCount, 0, 'the binding is dropped with the lane');
  console.log('liveness disconnect test passed');
}

// --- audit #8: multi-underscore agentIds reverse-map for display names (debt) -----------

{
  const opsLead = agentInfo('agent_ops_team_lead', 'ops-lead');
  const terminals = new FakeTerminalRuntime([opsLead, PEER]);
  const transport = createTerminalHostTransport(terminals);
  const presenceId = 'presence_ops' as PresenceId;
  transport.bind(presenceId, PEER.agentId);
  await transport.deliver(presenceId, { message: makeMessage('standup', 'person_agent-ops-team-lead'), priority: 'normal' });
  assert.match(
    terminals.submissions[0]?.text ?? '',
    /^\[nvk-msg from ops-lead id message_1\]/,
    'a multi-underscore agentId resolves to its terminal title, not the personId fallback',
  );
  console.log('multi-underscore display-name test passed');
}

console.log('terminal-host transport contract-discipline tests passed');
