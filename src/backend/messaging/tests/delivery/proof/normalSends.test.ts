// Normal-send honesty (mission_transcript-proof-normal-sends): a normal
// direct send settles 'accepted' when bytes are written and earns 'delivered'
// only on transcript proof — the same D1 honesty PR #46 gave interrupts.
// Mailbox recipients (no PTY, no transcript) honestly stay 'queued' (ruling
// R1) and reconcile never re-routes them (R2 — the duplicate-append bug).
// Channel and room fan-out semantics are unchanged (R3).
// Every assertion reads the PERSISTED trail from the JSONL store file —
// confirmation is fire-and-record, so in-memory reads race the amendment.
// Run with `npx tsx src/backend/messaging/tests/delivery/proof/normalSends.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageStore } from '../../../store/index.js';
import { PtyDelivery } from '../../../delivery/index.js';
import { MessageRouter, InterruptRateLimiter } from '../../../router/index.js';
import type { EffectConfirmer } from '../../../confirm/index.js';
import type { AgentAddress, MessageEnvelope } from '../../../types.js';

const roster: AgentAddress[] = [
  { agentId: 'agent_n1', name: 'worker-1', provider: 'claude' },
  { agentId: 'agent_n2', name: 'worker-2', provider: 'kimi' },
];

interface Harness {
  router: MessageRouter;
  store: MessageStore;
  storePath: string;
  writes: Array<{ agentId: string; data: string }>;
  submits: Array<{ agentId: string; messageId: string; text: string }>;
  submittedIds: Set<string>;
}

function envelope(overrides: Partial<MessageEnvelope>): MessageEnvelope {
  return {
    'id': `msg_${Math.random().toString(36).slice(2, 10)}`, from: 'worker-2', 'to': 'worker-1',
    delivery: 'normal', body: 'ping', createdAt: new Date().toISOString(), status: 'queued',
    ...overrides,
  };
}

function makeHarness(confirmer: EffectConfirmer | undefined, { confirmTimeoutMs = 200 } = {}): Harness {
  const storePath = join(mkdtempSync(join(tmpdir(), 'nvk-ns-')), 'messages.jsonl');
  const store = new MessageStore(storePath);
  const writes: Harness['writes'] = [];
  const submits: Harness['submits'] = [];
  const submittedIds = new Set<string>();
  const delivery = new PtyDelivery({
    write: (agentId: string, data: string) => { writes.push({ agentId, data }); return true; },
    submit: (submission: { agentId: string; messageId: string; text: string }) => {
      if (submittedIds.has(submission.messageId)) return true;
      submittedIds.add(submission.messageId);
      submits.push(submission);
      return true;
    },
  }, { interruptSettleMs: 0, submitDelayMs: 0 });
  const router = new MessageRouter(
    store, delivery,
    () => roster, new InterruptRateLimiter(100), undefined, undefined,
    confirmer,
    (agentId) => ({ sessionId: `sess-${agentId}`, projectDir: 'proj', provider: agentId === 'agent_n2' ? 'kimi' : 'claude' }),
    confirmTimeoutMs,
  );
  return { router, store, storePath, writes, submits, submittedIds };
}

function trailFor(storePath: string, id: string): MessageEnvelope[] {
  return readFileSync(storePath, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as MessageEnvelope)
    .filter((entry) => entry.id === id);
}

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const provingConfirmer: EffectConfirmer = {
  confirm: (_target, marker) => Promise.resolve(
    marker.startsWith('[nvk-msg from') ? { confirmedAt: '2026-07-23T05:00:00Z', transcriptEvent: 'time:1753246800' } : null,
  ),
};

// --- normal DM: accepted on write, delivered ONLY on transcript proof --------

{
  const harness = makeHarness(provingConfirmer);
  const message = envelope({ delivery: 'normal' });
  const receipt = await harness.router.route(message);
  assert.equal(receipt.mode, 'normal-accepted', 'the send path returns on acceptance, never blocking on proof');

  await settle(20);
  const trail = trailFor(harness.storePath, message.id);
  assert.deepEqual(trail.map((entry) => entry.status), ['queued', 'accepted', 'delivered'],
    'queued → accepted (bytes) → delivered (proof)');
  const final = trail.at(-1)?.outcome as Record<string, unknown>;
  assert.equal(typeof final?.acceptedAt, 'string', 'acceptedAt survives the merge');
  assert.equal(final?.confirmedAt, '2026-07-23T05:00:00Z');
  assert.equal(final?.transcriptEvent, 'time:1753246800', 'the transcript event is the persisted evidence');
  assert.equal(final?.sessionId, 'sess-agent_n1');
  assert.equal(final?.agentId, 'agent_n1');
  console.log('normal accepted→delivered test passed');
}

// --- normal DM with no proof: stays accepted with an honest note -------------

{
  const harness = makeHarness({ confirm: () => Promise.resolve(null) });
  const message = envelope({ delivery: 'normal' });
  await harness.router.route(message);
  await settle(20);
  const final = trailFor(harness.storePath, message.id).at(-1);
  assert.equal(final?.status, 'accepted', 'no proof → never claimed delivered');
  assert.match(String(final?.outcome?.note), /effect unverified within/);
  console.log('normal unverified-note test passed');
}

// --- mailbox recipient: the append IS the record — exactly one queued row ----

{
  const harness = makeHarness(provingConfirmer);
  const message = envelope({ 'to': 'kimi', delivery: 'normal', body: 'for the orchestrator inbox' });
  const receipt = await harness.router.route(message);
  assert.equal(receipt.mode, 'mailbox');

  await settle(20);
  const trail = trailFor(harness.storePath, message.id);
  assert.deepEqual(trail.map((entry) => entry.status), ['queued'],
    'mailbox trail is exactly one queued row — zero amendments (ruling R1/A2)');
  assert.equal(trail[0]?.outcome, undefined, 'no outcome is claimed for an effect nobody can prove');
  assert.equal(harness.writes.length + harness.submits.length, 0, 'nothing typed into any PTY');
  console.log('mailbox honest-queued test passed');
}

// --- reconcile: a queued mailbox envelope is NEVER re-routed (R2) ------------
// Mailbox sends LIVE at 'queued'; a naive retry would re-append the envelope
// and double-show it to every reader — the Chief-named duplicate-append bug.

{
  const harness = makeHarness(provingConfirmer);
  const message = envelope({ 'to': 'kimi', delivery: 'normal', body: 'steady-state queued' });
  await harness.router.route(message);
  const linesBefore = trailFor(harness.storePath, message.id).length;

  await harness.router.reconcile();
  await settle(20);
  assert.equal(trailFor(harness.storePath, message.id).length, linesBefore,
    'reconcile appends nothing for a mailbox envelope — no duplicate row, no re-broadcast');
  assert.equal(harness.writes.length + harness.submits.length, 0, 'reconcile typed nothing');
  console.log('reconcile mailbox-skip test passed');
}

// --- reconcile: an accepted NORMAL send is verified, never re-typed (A5) -----
// Proves the existing accepted branch covers normal sends: crash after the
// 'accepted' amendment → restart verifies the transcript and amends
// 'delivered' on proof, with zero re-typing.

{
  const harness = makeHarness(provingConfirmer);
  const accepted = envelope({ delivery: 'normal', body: 'accepted before restart' });
  harness.store.append(accepted);
  harness.store.amend(accepted.id, 'accepted', { acceptedAt: new Date().toISOString(), agentId: 'agent_n1' });

  await harness.router.reconcile();
  await settle(20);
  assert.equal(harness.writes.length + harness.submits.length, 0, 'accepted is NEVER re-typed');
  const final = trailFor(harness.storePath, accepted.id).at(-1);
  assert.equal(final?.status, 'delivered', 'restart verification found the turn and amended delivered');
  assert.equal(final?.outcome?.transcriptEvent, 'time:1753246800');
  assert.match(String(final?.outcome?.note ?? 'restart reconciliation'), /restart reconciliation/);
  console.log('reconcile accepted-normal-verified test passed');
}

// --- reconcile: a queued agent send that never reached the host delivers -----

{
  const harness = makeHarness(provingConfirmer);
  const lost = envelope({ delivery: 'normal', body: 'never written' });
  harness.store.append(lost);

  await harness.router.reconcile();
  await settle(20);
  assert.equal(harness.submits.filter((submission) => submission.messageId === lost.id).length, 1, 'retried exactly once');
  const trail = trailFor(harness.storePath, lost.id).map((entry) => entry.status);
  assert.equal(trail.at(-1), 'delivered', 'the retry flowed through the honest accepted→delivered path');
  assert.ok(trail.includes('accepted'), 'the retry settled accepted before proof');
  console.log('reconcile queued-retry test passed');
}

// --- channel + room fan-out semantics UNCHANGED (R3) -------------------------

console.log('normal-send honesty tests passed');
