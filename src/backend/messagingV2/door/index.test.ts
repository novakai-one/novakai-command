/**
 * messagingV2 door tests (D-N6-1): the DEC-17 frames endpoint INSIDE the app
 * backend — the done-definition proof (plan §5): an external machine
 * connects, authenticates with an ISSUED token, OpenPresence{transport:'ws'},
 * and is PUSHED MessageCommitted + DeliveryUpdated (no polling). Negatives:
 * bad/revoked token, wrong protocolVersion, unauthenticated command.
 * Raw WebSocket frames (the external's wire truth), real composition on a
 * scratch journal. Run with `npx tsx src/backend/messagingV2/door/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { startMessagingV2 } from '../index.js';
import { createTokenStore } from '../tokens/index.js';
import { createExternalsStore } from '../externals/index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-door-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

function agentInfo(agentId: string, title: string): AgentInfo {
  return {
    agentId, title, provider: 'claude', sessionId: 'session',
    projectDir: 'project', cwd: '/tmp/project', status: 'running', createdAt: new Date().toISOString(),
  };
}

class FakeTerminalRuntime implements TerminalRuntime {
  readonly submissions: SubmitJob[] = [];
  constructor(private readonly agents: AgentInfo[]) {}
  create(): Promise<AgentInfo> { return Promise.reject(new Error('unused')); }
  write(): boolean { return true; }
  submit(submission: SubmitJob): boolean { this.submissions.push(submission); return true; }
  activity(): null { return null; }
  resize(): boolean { return true; }
  rename(): boolean { return true; }
  kill(): boolean { return true; }
  archive(): boolean { return true; }
  snapshot(): string { return ''; }
  list(): AgentInfo[] { return this.agents; }
  onData(): void {}
  onExit(): void {}
  onSession(): void {}
}

/** A minimal DEC-17 client (raw frames — what a foreign machine speaks). */
class DoorClient {
  private readonly socket: WebSocket;
  private readonly backlog: Record<string, unknown>[] = [];
  private readonly waiters: Array<{ match: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];
  private counter = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      const index = this.waiters.findIndex((waiter) => waiter.match(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(frame);
      } else {
        this.backlog.push(frame);
      }
    });
  }

  static async connect(port: number): Promise<DoorClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    return new DoorClient(socket);
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(match: (frame: Record<string, unknown>) => boolean, timeoutMs = 8_000): Promise<Record<string, unknown>> {
    const index = this.backlog.findIndex(match);
    if (index >= 0) {
      const [frame] = this.backlog.splice(index, 1);
      return Promise.resolve(frame as Record<string, unknown>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('door client: frame wait timed out')), timeoutMs);
      timer.unref();
      this.waiters.push({ match, resolve });
    });
  }

  async call(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.counter += 1;
    const requestId = `req-${this.counter}`;
    this.send({ ...frame, requestId });
    return this.waitFor((candidate) => candidate['requestId'] === requestId);
  }

  close(): void {
    this.socket.close();
  }
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Door Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'worker-alice', provider: 'claude', teamId, missionId: 'mission_alpha' });
const externId = model.createAgent({ name: 'worker-remote', provider: 'claude', teamId, missionId: 'mission_alpha' });
const tokens = createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-door-tokens-')), 'tokens.jsonl'));
const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-door-journal-')), 'journal.jsonl');
const terminals = new FakeTerminalRuntime([agentInfo(aliceId, 'worker-alice'), agentInfo(externId, 'worker-remote')]);
// D-N8: the external principal is provisioned BEFORE boot — the fleet roster
// and the boot policy sync must already see them.
const externalsStore = createExternalsStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-door-ext-')), 'externals.jsonl'));
const partner = externalsStore.provision({ slackUserId: 'U_PARTNER', displayName: 'Partner Chris' });

const handle = await startMessagingV2({
  objectModel: model, storePath: journalPath, tokenStore: tokens, externalsStore, terminals, door: { port: 0 }, 'log': () => {},
});
assert.ok(handle.door !== null, 'the door booted with the capability');
const port = handle.door.port;
assert.ok(port > 0, 'ephemeral port resolved');
assert.equal(handle.lanes?.laneCount(), 2, 'pty lanes coexist with the ws door (D-N6-1)');

// --- pre-auth: get-capabilities works without a session (R3 discovery) ----------

const probe = await DoorClient.connect(port);
probe.send({ kind: 'get-capabilities' });
const capabilities = await probe.waitFor((frame) => frame['kind'] === 'capabilities');
assert.equal((capabilities['capabilities'] as Record<string, unknown>)['contractVersion'], '1.1.0');

// --- negatives: unauthenticated command, bad token, wrong version ----------------

const unauthenticated = await probe.call({ kind: 'query', name: 'GetInbox', input: {} });
assert.equal((unauthenticated['error'] as Record<string, unknown>)['name'], 'NotAuthenticated', 'a command before authenticate is NotAuthenticated');

const badToken = await probe.call({ kind: 'authenticate', credential: { token: 'nvkt_garbage' } });
assert.equal((badToken['error'] as Record<string, unknown>)['name'], 'NotAuthenticated', 'an unknown token is NotAuthenticated');

const wrongVersion = await probe.call({ kind: 'authenticate', credential: { token: 'nvkt_garbage' }, protocolVersion: '9.9.9' });
assert.equal((wrongVersion['error'] as Record<string, unknown>)['name'], 'VersionUnsupported', 'a wrong protocolVersion is VersionUnsupported');
probe.close();
console.log('door negative tests passed');

// --- the done-definition flow: connect → authenticate → presence → PUSH ----------

const external = await DoorClient.connect(port);
tokens.ensure(externId);
const externToken = tokens.tokenForAgent(externId) as string;
const authenticated = await external.call({ kind: 'authenticate', credential: { token: externToken }, protocolVersion: '1.0.0' });
assert.equal(authenticated['kind'], 'authenticated', 'an ISSUED token authenticates over the wire');
assert.equal((authenticated['principal'] as Record<string, unknown>)['personId'], personIdForAgentId(externId));

const opened = await external.call({ kind: 'command', name: 'OpenPresence', input: { transport: 'ws', clientLabel: 'nvk-connect-smoke' } });
const presenceId = (opened['result'] as Record<string, unknown>)['presenceId'];
assert.ok(typeof presenceId === 'string', 'OpenPresence over the ws transport succeeds');

external.send({ kind: 'subscribe', requestId: 'sub-1', input: { events: ['MessageCommitted', 'DeliveryUpdated'] } });
await external.waitFor((frame) => frame['kind'] === 'started');

// A second principal sends (in-process session — the local side of the lane).
tokens.ensure(aliceId);
const aliceAuth = await handle.embedded.authenticate({ token: tokens.tokenForAgent(aliceId) });
if (aliceAuth.kind !== 'authenticated') throw new Error('unreachable');
const externPerson = personIdForAgentId(externId);
await aliceAuth.session.setContactPolicy({ allowlist: [externPerson], defaultRule: 'deny' });
const externAuth = await handle.embedded.authenticate({ token: externToken });
if (externAuth.kind !== 'authenticated') throw new Error('unreachable');
await externAuth.session.setContactPolicy({ allowlist: [personIdForAgentId(aliceId)], defaultRule: 'deny' });
const sent = await aliceAuth.session.sendMessage({
  address: `person:${externPerson}`, body: { text: 'hello from inside' },
  priority: 'normal', clientMessageId: 'door-e2e-1',
});
if (sent.kind !== 'ok') throw new Error('unreachable');

const pushedMessage = await external.waitFor(
  (frame) => frame['kind'] === 'event' && (frame['event'] as Record<string, unknown>)['message'] !== undefined,
);
assert.equal(
  ((pushedMessage['event'] as Record<string, unknown>)['message'] as Record<string, unknown>)['id'],
  sent.value.messageId,
  'the external is PUSHED the MessageCommitted (no polling)',
);
const pushedDelivery = await external.waitFor(
  (frame) => frame['kind'] === 'event' && (frame['event'] as Record<string, unknown>)['delivery'] !== undefined,
);
assert.ok(pushedDelivery, 'DeliveryUpdated pushes too');
console.log('door push tests passed');

// GetDelivery over the wire shows the same truth.
const delivery = await external.call({ kind: 'query', name: 'GetDelivery', input: { messageId: sent.value.messageId } });
assert.equal(delivery['kind'], 'query-result');
const deliveries = (delivery['result'] as Record<string, unknown>)['deliveries'] as Array<Record<string, unknown>>;
assert.ok(deliveries.some((entry) => entry['messageId'] === sent.value.messageId), 'GetDelivery over the wire carries the truth');
console.log('door GetDelivery test passed');

// --- revocation over the wire: a revoked token never authenticates ---------------

tokens.revokeAll(externId);
const revokedProbe = await DoorClient.connect(port);
const revoked = await revokedProbe.call({ kind: 'authenticate', credential: { token: externToken } });
assert.equal((revoked['error'] as Record<string, unknown>)['name'], 'NotAuthenticated', 'a REVOKED token is NotAuthenticated over the wire');
revokedProbe.close();
console.log('door revocation test passed');

// --- D-N6-5: issuance-time policy sync — the human's allowlist gains the agent ---

const lateId = model.createAgent({ name: 'worker-late', provider: 'claude', teamId, missionId: 'mission_alpha' });
tokens.issue(lateId);
await handle.lanes?.syncPoliciesNow(); // what the token route runs at issuance
const humanAuth = await handle.embedded.authenticate({ token: `human_${'x'}` });
assert.equal(humanAuth.kind, 'rejected', 'sanity: the boot human token is not guessable');
const humanSession = handle.lanes?.humanSession();
assert.ok(humanSession, 'the held human session exists');
const policy = await humanSession.getPolicy({});
if (policy.kind !== 'ok') throw new Error('unreachable');
assert.ok(
  policy.value.contact.allowlist.includes(personIdForAgentId(lateId)),
  'after issuance + sync, the human allowlist includes the fresh agent (D-N6-5)',
);
console.log('issuance policy-sync test passed');

// --- D-N8-1..4: an external principal messages through the door AS THEMSELF -----

const partnerToken = tokens.issueExternal(partner.personId).token;
await handle.lanes?.syncPoliciesNow(); // D-N6-5 parity — issuance-time sync covers externals

const partnerDoor = await DoorClient.connect(port);
const partnerAuth = await partnerDoor.call({ kind: 'authenticate', credential: { token: partnerToken }, protocolVersion: '1.0.0' });
assert.equal(partnerAuth['kind'], 'authenticated', 'the external authenticates through the door');
assert.equal((partnerAuth['principal'] as Record<string, unknown>)['personId'], partner.personId, 'AS THEMSELF, never an agent or the human');
assert.deepEqual((partnerAuth['principal'] as Record<string, unknown>)['grants'], [], 'externals hold no grants');

const partnerPresence = await partnerDoor.call({ kind: 'command', name: 'OpenPresence', input: { transport: 'ws', clientLabel: 'partner-slack' } });
assert.equal(partnerPresence['kind'], 'command-result', 'the external opens ws presence (D-N8-4: delivery truth lane)');
partnerDoor.send({ kind: 'subscribe', requestId: 'partner-sub', input: { events: ['MessageCommitted', 'DeliveryUpdated'] } });
await partnerDoor.waitFor((frame) => frame['kind'] === 'started');

const fleetThreadId = handle.rooms?.fleetThreadId();
assert.ok(fleetThreadId !== undefined, 'the fleet room is provisioned');
const partnerSend = await partnerDoor.call({
  kind: 'command',
  name: 'SendMessage',
  input: {
    address: `thread:${fleetThreadId}`,
    body: { text: 'hello from outside the workspace' },
    priority: 'normal', clientMessageId: 'n8-door-1',
  },
});
assert.equal(partnerSend['kind'], 'command-result', 'the external room send commits (fleet membership via D-N8-2)');
const partnerMessageId = (partnerSend['result'] as Record<string, unknown>)['messageId'] as string;

const committed = await partnerDoor.waitFor(
  (frame) => frame['kind'] === 'event' && (frame['event'] as Record<string, unknown>)['message'] !== undefined,
);
const committedMessage = (committed['event'] as Record<string, unknown>)['message'] as Record<string, unknown>;
assert.equal(committedMessage['senderId'], partner.personId, 'the committed message is stamped AS THE EXTERNAL');
await partnerDoor.waitFor(
  (frame) => frame['kind'] === 'event' && (frame['event'] as Record<string, unknown>)['delivery'] !== undefined,
);
assert.ok(true, 'DeliveryUpdated flows to the external’s presence lane');

const partnerDelivery = await partnerDoor.call({ kind: 'query', name: 'GetDelivery', input: { messageId: partnerMessageId } });
const partnerDeliveries = ((partnerDelivery['result'] as Record<string, unknown>)['deliveries'] ?? []) as Array<Record<string, unknown>>;
assert.ok(
  partnerDeliveries.some((entry) => entry['recipientId'] === partner.personId && entry['state'] !== 'failed'),
  'the external is a DELIVERABLE recipient (frozen snapshot includes them)',
);
assert.ok(
  partnerDeliveries.every((entry) => entry['state'] !== 'failed'),
  'ZERO failed deliveries — the policy sync made every recipient reachable (D-N8-2/D-N6-5)',
);
partnerDoor.close();
console.log('D-N8 external door tests passed');

external.close();
await handle.close();
rmSync(scratch, { recursive: true, force: true });
console.log('messagingV2 door tests passed');
