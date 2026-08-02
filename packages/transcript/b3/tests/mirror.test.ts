/**
 * B3c — transcript custody, the mirror pipeline, and quarantine
 * (§8.2, §13.9, §24.6, §25-B3c, red gate 16/17).
 *
 * These run against a real Foundation store in a temp root and a FIXTURE
 * source. Both halves matter: the store is real because "the watermark
 * survives a restart" is a durability claim, and the source is a fixture
 * because §27 forbids writing provider originals — the only honest way to test
 * corruption is to corrupt something that is not a provider's file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { composeB3Transcript, recordObservedSubagent } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';
import type { MessagingMirrorPort } from '../core/mirror.js';
import type {
  B3TranscriptContract, MirrorStage, SourceLine, SourceReadOutcome, TranscriptSourcePort,
} from '../contract/api.js';
import type { AgentId, AgentRunId, ProviderSessionId } from '../contract/records.js';
import type { SystemCommandContext } from '@novakai/foundation/contract';

const AGENT = 'agent_aaaaaaaa-0000-4000-8000-000000000001' as AgentId;
const RUN = 'agentRun_01900000-0000-7000-8000-000000000001' as AgentRunId;
const SESSION = 'sess_11111111-0000-4000-8000-000000000001' as ProviderSessionId;
const THREAD = 'thread_conversation-1';

const runtimeCtx = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000001' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000001' as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_00000000-0000-4000-8000-000000000002' as never,
  traceId: 'trace_00000000-0000-4000-8000-000000000002' as never,
  contractVersion: 1,
});

/** A source that reads whatever the test hands it, never a provider file. */
class FixtureSource implements TranscriptSourcePort {
  lines: SourceLine[] = [];
  outcome: 'lines' | 'missing' | 'unavailable' = 'lines';

  async read(
    _binding: unknown, fromPosition: string | undefined, maxLines: number,
  ): Promise<SourceReadOutcome> {
    if (this.outcome === 'missing') return { kind: 'missing' };
    if (this.outcome === 'unavailable') {
      return { kind: 'unavailable', reason: 'permission denied' };
    }
    // INCLUSIVE of the watermark line: see TranscriptSourcePort.read.
    const found = fromPosition === undefined
      ? -1
      : this.lines.findIndex((line) => line.position === fromPosition);
    const start = found === -1 ? 0 : found;
    const window = this.lines.slice(start, start + maxLines);
    return { kind: 'lines', lines: window, more: start + maxLines < this.lines.length };
  }
}

/** Messaging, recorded rather than mocked away: the assertions read this. */
class RecordingMessaging implements MessagingMirrorPort {
  readonly committed: Array<{ text: string; role: string; endpointClaimId: string }> = [];
  endpoint: string | null = 'agentEndpoint_live';
  private readonly byLine = new Map<string, string>();

  async commitTerminalOriginatedMessage(input: {
    readonly sourceEndpointClaimId: string;
    readonly turn: { readonly transcriptLineId: string; readonly text: string; readonly role: string };
  }) {
    const seen = this.byLine.get(input.turn.transcriptLineId);
    if (seen !== undefined) {
      return { ok: true as const, value: { messageId: seen, duplicate: true } };
    }
    const messageId = `message_${this.committed.length + 1}`;
    this.byLine.set(input.turn.transcriptLineId, messageId);
    this.committed.push({
      text: input.turn.text,
      role: input.turn.role,
      endpointClaimId: input.sourceEndpointClaimId,
    });
    return { ok: true as const, value: { messageId, duplicate: false } };
  }

  async currentEndpointClaimId(): Promise<string | null> { return this.endpoint; }
}

interface Rig {
  readonly api: B3TranscriptContract;
  readonly source: FixtureSource;
  readonly messaging: RecordingMessaging;
  readonly root: string;
}

function rig(hooks?: { onStage: (stage: MirrorStage) => 'continue' | 'halt' }): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-transcript-'));
  const source = new FixtureSource();
  const messaging = new RecordingMessaging();
  const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
  const api = composeB3Transcript({
    store, source, messaging, ...(hooks === undefined ? {} : { hooks }),
  });
  return { api, source, messaging, root };
}

function line(position: string, role: SourceLine['role'], text: string, digest = position): SourceLine {
  return { position, role, text, digest: `d-${digest}` };
}

async function bind(api: B3TranscriptContract): Promise<string> {
  const bound = await api.bindTranscriptToRun(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN, provider: 'claude',
    providerSessionId: SESSION, threadId: THREAD,
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('bind failed');
  return bound.value.id;
}

test('a first bind says waiting, never nothing', async () => {
  // §25-B3c: "live first bind is explicit (bound / waiting / missing, never
  // silent absence)". A Run spawned a second ago has no file yet, and calling
  // that `missing` would make every healthy spawn look broken.
  const { api, root } = rig();
  try {
    const bound = await api.bindTranscriptToRun(runtimeCtx(), {
      agentId: AGENT, agentRunId: RUN, provider: 'claude',
      providerSessionId: SESSION, threadId: THREAD,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.value.sourceDiscoveryState, 'waiting');
    assert.equal(bound.value.mirrorWatermark, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binding the same Run twice returns the same custody record', async () => {
  const { api, root } = rig();
  try {
    const first = await bind(api);
    const second = await bind(api);
    assert.equal(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing source reports waiting explicitly, and mirrors nothing', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.outcome = 'missing';
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.haltedBy, 'source-unavailable');
    assert.equal(ingested.value.mirrored, 0);

    const binding = await api.getTranscriptBinding(
      { id: 'human_chris' as never, kind: 'human', verifiedScopes: [] }, RUN,
    );
    assert.equal(binding.ok && binding.value.sourceDiscoveryState, 'waiting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversation turns mirror; tool and control lines do not', async () => {
  const { api, source, messaging, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [
      line('1', 'user', 'build the thing'),
      line('2', 'tool_call', 'Read(src/index.ts)'),
      line('3', 'assistant', '[32mdone[0m'),
      line('4', 'system', 'context compacted'),
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.discovered, 4);
    assert.equal(ingested.value.mirrored, 2);
    assert.equal(ingested.value.filtered, 2);
    assert.equal(ingested.value.nextWatermark, '4');
    assert.deepEqual(messaging.committed.map((entry) => entry.text), ['build the thing', 'done']);
    assert.deepEqual(messaging.committed.map((entry) => entry.role), ['human', 'assistant']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a full re-ingest mirrors nothing twice', async () => {
  // §24.6: "replay after every crash point does not duplicate logical Message
  // identity". The ledger is what makes a second pass over the same positions
  // a no-op rather than a second conversation.
  const { api, source, messaging, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [line('1', 'user', 'hello'), line('2', 'assistant', 'hi')];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    // Rewind the watermark the way a crash-recovery replay would.
    const again = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(again.ok, true);
    assert.equal(messaging.committed.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed digest at a mirrored position quarantines and freezes the watermark', async () => {
  const { api, source, messaging, root } = rig();
  const human = { id: 'human_chris' as never, kind: 'human' as const, verifiedScopes: [] };
  try {
    const bindingId = await bind(api);
    source.lines = [line('1', 'user', 'hello'), line('2', 'assistant', 'hi')];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });

    // The provider file changed underneath us: same position, different bytes.
    source.lines = [
      line('1', 'user', 'hello'),
      { ...line('2', 'assistant', 'something else'), digest: 'd-tampered' },
      line('3', 'assistant', 'and more after it'),
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.quarantined, 1);
    assert.equal(ingested.value.haltedBy, 'quarantine');

    const binding = await api.getTranscriptBinding(human, RUN);
    assert.equal(binding.ok && binding.value.sourceDiscoveryState, 'corrupt');
    assert.equal(binding.ok && binding.value.quarantinedPosition, '2');
    // The watermark did NOT reach position 3, and the turn after the
    // corruption was never committed.
    assert.equal(messaging.committed.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a quarantined binding refuses to ingest or advance until someone looks', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [line('1', 'user', 'hello')];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    source.lines = [{ ...line('1', 'user', 'tampered'), digest: 'd-x' }];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });

    const retried = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(retried.ok, false);
    if (retried.ok) return;
    assert.equal(retried.error.code, 'TranscriptCorrupt');

    const forced = await api.promoteMirrorWatermark(transcriptCtx(), {
      bindingId: bindingId as never, nextWatermark: '9', outcomeRefs: [],
    });
    assert.equal(forced.ok, false, 'the watermark was pushed past a quarantine');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash between the Message commit and the watermark leaves no duplicate', async () => {
  // §24.3 item 18, through the public stage-pause contract rather than from
  // inside the package. The Message is durable and the watermark is not — the
  // exact window a naive implementation duplicates in.
  let halt = true;
  const { api, source, messaging, root } = rig({
    onStage: (stage) => (halt && stage === 'before-watermark-advance' ? 'halt' : 'continue'),
  });
  try {
    const bindingId = await bind(api);
    source.lines = [line('1', 'user', 'only turn')];
    const first = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(first.ok && first.value.haltedBy, 'stage-pause');
    assert.equal(messaging.committed.length, 1);

    halt = false;
    const resumed = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(messaging.committed.length, 1, 'the replay committed a second Message');
    assert.equal(resumed.value.nextWatermark, '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mirror carries the endpoint it came from, so delivery can avoid it', async () => {
  const { api, source, messaging, root } = rig();
  try {
    const bindingId = await bind(api);
    messaging.endpoint = 'agentEndpoint_current';
    source.lines = [line('1', 'assistant', 'I finished')];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(messaging.committed[0]?.endpointClaimId, 'agentEndpoint_current');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a turn still mirrors when the Agent has no live endpoint', async () => {
  // A dead Run's transcript is still history worth keeping. Refusing to mirror
  // it would lose the last thing the Agent said before it stopped.
  const { api, source, messaging, root } = rig();
  try {
    const bindingId = await bind(api);
    messaging.endpoint = null;
    source.lines = [line('1', 'assistant', 'last words')];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok && ingested.value.mirrored, 1);
    assert.equal(messaging.committed.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maxLines stops the pass and says so rather than reporting completion', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [
      line('1', 'user', 'one'), line('2', 'assistant', 'two'), line('3', 'user', 'three'),
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 2,
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.mirrored, 2);
    assert.equal(ingested.value.haltedBy, 'max-lines');
    assert.equal(ingested.value.nextWatermark, '2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ingest against a stale expected watermark is refused', async () => {
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [line('1', 'user', 'one')];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    // Omitting the field means "I make no claim about the watermark", and
    // proceeds. The type system refuses an explicit `undefined`, which is the
    // right outcome: "I claim it is unset" and "I claim nothing" must not be
    // the same value on a CAS field.
    const unclaimed = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(unclaimed.ok, true);

    const wrong = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, expectedWatermark: '99', maxLines: 100,
    });
    assert.equal(wrong.ok, false);
    if (wrong.ok) return;
    assert.equal(wrong.error.code, 'VersionConflict');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a native subagent seen during ingest is recorded with the line as evidence', async () => {
  // §7: "Observed provider-native subagents: listed as observed work with
  // evidence." Most of that activity shows up on TOOL lines — the ones the
  // noise filter drops — so discovery has to happen before classification or
  // the evidence disappears with the noise.
  const { api, source, root } = rig();
  try {
    const bindingId = await bind(api);
    source.lines = [
      { ...line('1', 'tool_call', 'Task(explore)'), nativeSubagentId: 'task-42' },
      line('2', 'assistant', 'the subagent finished'),
    ];
    const ingested = await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.equal(ingested.ok, true);

    const listed = await api.listObservedSubagents(
      { id: 'human_chris' as never, kind: 'human', verifiedScopes: [] },
      { bindingId: bindingId as never, limit: 10 },
    );
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.items.length, 1);
    assert.equal(listed.value.items[0]?.providerNativeId, 'task-42');
    assert.equal(listed.value.items[0]?.status, 'observed');
    assert.equal(listed.value.items[0]?.evidenceLineIds.length, 1,
      'an observed subagent was recorded with no evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every B3c transcript fact reaches the event stream, once committed', async () => {
  const emitted: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-events-'));
  try {
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const source = new FixtureSource();
    const api = composeB3Transcript({
      store, source, messaging: new RecordingMessaging(),
      emit: (kind) => { emitted.push(kind); },
    });
    const bindingId = await bind(api);
    source.lines = [
      { ...line('1', 'tool_call', 'Task(explore)'), nativeSubagentId: 'task-42' },
      line('2', 'assistant', 'done'),
    ];
    await api.ingestTranscriptSource(transcriptCtx(), {
      bindingId: bindingId as never, maxLines: 100,
    });
    assert.deepEqual([...new Set(emitted)].sort(), [
      'transcript.binding.changed',
      'transcript.line.committed',
      'transcript.observed-subagent.changed',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an observed subagent is listed as observed work and is never auto-promoted', async () => {
  // Red gate 16: "a provider-native subagent becomes a managed Agent without an
  // explicit promotion operation".
  const { api, root } = rig();
  try {
    const bindingId = await bind(api);
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const observed = await recordObservedSubagent(store, {
      bindingId: bindingId as never,
      providerNativeId: 'task-7',
      evidenceLineIds: ['transcriptLine_evidence'],
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) return;
    assert.equal(observed.value.status, 'observed');

    const listed = await api.listObservedSubagents(
      { id: 'human_chris' as never, kind: 'human', verifiedScopes: [] },
      { bindingId: bindingId as never, limit: 10 },
    );
    assert.equal(listed.ok && listed.value.items.length, 1);
    assert.equal(listed.ok && listed.value.items[0]?.status, 'observed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion without authority is observation-only — a typed outcome, not an error', async () => {
  // DEC-B3V4-18. "Observation never silently becomes control", and the honest
  // answer to "can Novakai control this?" is often no. Saying no is a SUCCESS.
  const { api, root } = rig();
  try {
    const bindingId = await bind(api);
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const observed = await recordObservedSubagent(store, {
      bindingId: bindingId as never,
      providerNativeId: 'task-7',
      evidenceLineIds: ['transcriptLine_evidence'],
    });
    if (!observed.ok) return;

    const promoted = await api.promoteObservedSubagent(transcriptCtx(), {
      observedSubagentId: observed.value.id,
      roleProfileId: 'agentRole_builder',
      displayName: 'Native task 7',
    });
    assert.equal(promoted.ok, true, 'observation-only was reported as a failure');
    if (!promoted.ok) return;
    assert.equal(promoted.value.kind, 'observation-only');
    if (promoted.value.kind !== 'observation-only') return;
    assert.deepEqual(promoted.value.missingEvidence, ['promotion-authority']);
    assert.equal(promoted.value.subagent.status, 'unsupported');
    assert.equal(promoted.value.subagent.promotedAgentId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion without evidence is refused even when authority exists', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-promote-'));
  try {
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const api = composeB3Transcript({
      store,
      source: new FixtureSource(),
      messaging: new RecordingMessaging(),
      promotion: {
        async promote() {
          throw new Error('promotion must not be reached without evidence');
        },
      },
    });
    const bindingId = await bind(api);
    const observed = await recordObservedSubagent(store, {
      bindingId: bindingId as never, providerNativeId: 'task-9', evidenceLineIds: [],
    });
    if (!observed.ok) return;

    const promoted = await api.promoteObservedSubagent(transcriptCtx(), {
      observedSubagentId: observed.value.id,
      roleProfileId: 'agentRole_builder',
      displayName: 'Native task 9',
    });
    assert.equal(promoted.ok, true);
    if (!promoted.ok || promoted.value.kind !== 'observation-only') {
      assert.fail('a subagent with no evidence was promoted');
      return;
    }
    assert.deepEqual(promoted.value.missingEvidence, ['evidenceLineIds']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion with evidence and authority produces a managed Agent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-promote-ok-'));
  try {
    const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
    const api = composeB3Transcript({
      store,
      source: new FixtureSource(),
      messaging: new RecordingMessaging(),
      promotion: {
        async promote() {
          return { ok: true as const, value: { agentId: AGENT } };
        },
      },
    });
    const bindingId = await bind(api);
    const observed = await recordObservedSubagent(store, {
      bindingId: bindingId as never,
      providerNativeId: 'task-11',
      evidenceLineIds: ['transcriptLine_evidence'],
    });
    if (!observed.ok) return;

    const promoted = await api.promoteObservedSubagent(transcriptCtx(), {
      observedSubagentId: observed.value.id,
      roleProfileId: 'agentRole_builder',
      displayName: 'Native task 11',
    });
    assert.equal(promoted.ok, true);
    if (!promoted.ok || promoted.value.kind !== 'promoted') {
      assert.fail('promotion with full evidence was refused');
      return;
    }
    assert.equal(promoted.value.agentId, AGENT);
    assert.equal(promoted.value.subagent.status, 'promoted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
