// D1 + D2 delivery state machine (rulings S6/M9). Covers: interrupt
// accepted→delivered with transcript proof persisted as evidence; honest
// timeout note; per-agent serialization; host-submission dedupe making the
// reconciliation retry idempotent; accepted-never-retyped on reconcile.
// Run with `npx tsx src/backend/messaging/tests/delivery/proof/stateMachine.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageStore } from '../../../store/index.js';
import { PtyDelivery } from '../../../delivery/index.js';
import { MessageRouter, InterruptRateLimiter } from '../../../router/index.js';
import type { EffectConfirmer } from '../../../confirm/index.js';
import type { AgentAddress, MessageEnvelope } from '../../../types.js';

const roster: AgentAddress[] = [
  { agentId: 'agent_r1', name: 'worker-1', provider: 'claude' },
  { agentId: 'agent_r2', name: 'worker-2', provider: 'kimi' },
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

// The host-side writer: submit dedupes by messageId, exactly like the
// TerminalHost submission (D2 idempotence).
function makeWriter(writes: Harness['writes'], submits: Harness['submits'], submittedIds: Set<string>) {
  return {
    write: (agentId: string, data: string) => { writes.push({ agentId, data }); return true; },
    submit: (submission: { agentId: string; messageId: string; text: string }) => {
      if (submittedIds.has(submission.messageId)) return true;
      submittedIds.add(submission.messageId);
      submits.push(submission);
      return true;
    },
  };
}

function makeRouter(store: MessageStore, delivery: PtyDelivery, confirmer: EffectConfirmer | undefined, confirmTimeoutMs: number): MessageRouter {
  return new MessageRouter(
    store, delivery,
    () => roster, new InterruptRateLimiter(100), undefined, undefined,
    confirmer,
    (agentId) => ({ sessionId: `sess-${agentId}`, projectDir: 'proj', provider: agentId === 'agent_r2' ? 'kimi' : 'claude' }),
    confirmTimeoutMs,
  );
}

function makeHarness(confirmer: EffectConfirmer | undefined, { confirmTimeoutMs = 200 } = {}): Harness {
  const storePath = join(mkdtempSync(join(tmpdir(), 'nvk-dsm-')), 'messages.jsonl');
  const store = new MessageStore(storePath);
  const writes: Harness['writes'] = [];
  const submits: Harness['submits'] = [];
  const submittedIds = new Set<string>();
  const delivery = new PtyDelivery(makeWriter(writes, submits, submittedIds), { interruptSettleMs: 0, submitDelayMs: 0 });
  return { router: makeRouter(store, delivery, confirmer, confirmTimeoutMs), store, storePath, writes, submits, submittedIds };
}

function statusTrail(storePath: string, id: string): Array<{ status: string; outcome?: Record<string, unknown> }> {
  return readFileSync(storePath, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as MessageEnvelope)
    .filter((entry) => entry.id === id)
    .map((entry) => ({ status: entry.status, outcome: entry.outcome as Record<string, unknown> | undefined }));
}

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// --- interrupt: accepted, then delivered ONLY on transcript proof ------------

{
  const confirmer: EffectConfirmer = {
    confirm: (_target, marker) => Promise.resolve(
      marker.startsWith('[nvk-msg from') ? { confirmedAt: '2026-07-22T20:00:00Z', transcriptEvent: 'time:1753185600' } : null,
    ),
  };
  const harness = makeHarness(confirmer);
  const message = envelope({ delivery: 'interrupt' });
  const receipt = await harness.router.route(message);
  assert.equal(receipt.mode, 'interrupt-accepted', 'the send path returns on acceptance, never blocking on proof');

  await settle(20);
  const trail = statusTrail(harness.storePath, message.id).map((entry) => entry.status);
  assert.deepEqual(trail, ['queued', 'accepted', 'delivered'], 'queued → accepted (bytes) → delivered (proof)');
  const final = statusTrail(harness.storePath, message.id).at(-1);
  assert.equal(final?.outcome?.acceptedAt !== undefined, true, 'acceptedAt survives the merge');
  assert.equal(final?.outcome?.confirmedAt, '2026-07-22T20:00:00Z');
  assert.equal(final?.outcome?.transcriptEvent, 'time:1753185600', 'the transcript event is the persisted evidence');
  assert.equal(final?.outcome?.sessionId, 'sess-agent_r1');
  console.log('interrupt accepted→delivered test passed');
}

// --- interrupt with no proof: stays accepted with an honest note -------------

{
  const harness = makeHarness({ confirm: () => Promise.resolve(null) });
  const message = envelope({ delivery: 'interrupt' });
  await harness.router.route(message);
  await settle(20);
  const final = statusTrail(harness.storePath, message.id).at(-1);
  assert.equal(final?.status, 'accepted', 'no proof → never claimed delivered');
  assert.match(String(final?.outcome?.note), /effect unverified within/);
  console.log('interrupt unverified-note test passed');
}

// --- normal DM: same honesty as interrupts (mission_transcript-proof-normal-
// sends) — accepted on write; without a confirmer the rig notes it honestly --

{
  const harness = makeHarness(undefined);
  const message = envelope({ delivery: 'normal' });
  await harness.router.route(message);
  const final = statusTrail(harness.storePath, message.id).at(-1);
  assert.equal(final?.status, 'accepted', 'bytes written never claim delivered');
  assert.match(String(final?.outcome?.note), /effect unverifiable/);
  console.log('normal-dm semantics test passed');
}

// --- reconciliation: queued retries idempotently; accepted never re-types ----

{
  const confirmer: EffectConfirmer = { confirm: () => Promise.resolve(null) };
  const harness = makeHarness(confirmer);

  // A 'queued' envelope whose submit ALREADY reached the host (crash between
  // write and journal amend): the retry re-sends the same messageId and the
  // host dedupe makes it a no-op — no double-typing.
  const crashed = envelope({ delivery: 'normal', body: 'crashed mid-route' });
  harness.store.append(crashed);
  harness.submittedIds.add(crashed.id); // the host saw this submission before the crash
  // An 'accepted' interrupt from before the restart: must NOT be re-typed.
  const accepted = envelope({ delivery: 'interrupt', body: 'accepted before restart' });
  harness.store.append(accepted);
  harness.store.amend(accepted.id, 'accepted', { acceptedAt: new Date().toISOString(), agentId: 'agent_r1' });

  const submitsBefore = harness.submits.length;
  await harness.router.reconcile();
  await settle(20);

  assert.equal(harness.submits.length, submitsBefore, 'neither the deduped retry nor the accepted envelope typed anything');
  const crashedFinal = statusTrail(harness.storePath, crashed.id).at(-1);
  assert.equal(crashedFinal?.status, 'accepted', 'the queued retry settled honestly — no proof, no delivered claim');
  assert.match(String(crashedFinal?.outcome?.note), /effect unverified within/);
  const acceptedFinal = statusTrail(harness.storePath, accepted.id).at(-1);
  assert.equal(acceptedFinal?.status, 'accepted');
  assert.match(String(acceptedFinal?.outcome?.note), /restart reconciliation/);
  console.log('reconciliation idempotence test passed');
}

// --- queued retry that never reached the host DOES deliver once --------------

{
  const harness = makeHarness(undefined);
  const lost = envelope({ delivery: 'normal', body: 'never written' });
  harness.store.append(lost);
  await harness.router.reconcile();
  assert.equal(harness.submits.filter((submission) => submission.messageId === lost.id).length, 1, 'retried exactly once');
  assert.equal(statusTrail(harness.storePath, lost.id).at(-1)?.status, 'accepted',
    'the retry lands accepted — delivered still needs proof (see normalSends.test.ts for the proven path)');
  console.log('reconciliation retry test passed');
}

// --- per-agent serialization: interleaved sends keep order per PTY -----------

{
  const harness = makeHarness(undefined);
  const first = envelope({ delivery: 'normal', 'to': 'worker-1', body: 'first' });
  const second = envelope({ delivery: 'normal', 'to': 'worker-1', body: 'second' });
  await Promise.all([harness.router.route(first), harness.router.route(second)]);
  const texts = harness.submits.filter((submission) => submission.agentId === 'agent_r1').map((submission) => submission.text);
  assert.equal(texts.length, 2);
  assert.ok(texts[0].includes('first') && texts[1].includes('second'), 'per-agent lane preserves order');
  console.log('per-agent serialization test passed');
}

// --- kimi flush rides the submit submission, not a backend timer --------------------

{
  const storePath = join(mkdtempSync(join(tmpdir(), 'nvk-dsm-kimi-')), 'messages.jsonl');
  const submits: Array<{ flushMs?: number }> = [];
  const delivery = new PtyDelivery(
    { write: () => true, submit: (submission: { flushMs?: number; messageId: string }) => { submits.push(submission); return true; } },
    { interruptSettleMs: 0, submitDelayMs: 0, flushDelayMs: 6000 },
  );
  await delivery.deliver({ agentId: 'agent_k', name: 'kimi-1', provider: 'kimi' }, envelope({ 'to': 'kimi-1' }));
  await delivery.deliver({ agentId: 'agent_c', name: 'claude-1', provider: 'claude' }, envelope({ 'to': 'claude-1' }));
  assert.equal(submits[0].flushMs, 6000, 'kimi submission carries the flush');
  assert.equal(submits[1].flushMs, undefined, 'claude submission does not');
  void storePath;
  console.log('kimi flush-in-submission test passed');
}

console.log('delivery state machine tests passed');
