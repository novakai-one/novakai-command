import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, deterministicId, mintClientOpId, mintProviderTurnId,
  mintTraceCorrelationId, providerTurnSubmissionId,
  type SystemCommandContext, type TranscriptBindingId,
} from '@novakai/foundation/contract';
import { composeB3Transcript } from '../core/compose.js';
import { createTranscriptStore } from '../core/store.js';

const AGENT = 'agent_123e4567-e89b-42d3-a456-426614174001' as never;
const RUN = 'agentRun_01900000-0000-7000-8000-000000000001' as never;
const SESSION = 'sess_123e4567-e89b-42d3-a456-426614174002' as never;

const context = <P extends 'sys_agent_runtime' | 'sys_reconciler'>(
  id: P,
): SystemCommandContext<P> => ({
  principal: { id, kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

const source = {
  async read() { return { kind: 'missing' as const }; },
  async readPrefixDigests() { return { kind: 'missing' as const }; },
};
const messaging = {
  async commitTerminalOriginatedMessage() {
    return b3ok({ messageId: 'message_unused', duplicate: false });
  },
  async currentEndpointClaimId() { return null; },
};

test('Transcript commits one deterministic completion only from a proven native boundary', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-turn-completion-'));
  const providerTurnId = mintProviderTurnId();
  const submissionId = providerTurnSubmissionId(
    RUN, { kind: 'runtime-effect', source: 'skills-gate' }, 'effect:gate:one',
  );
  let framingDigest = 'b'.repeat(64);
  try {
    const api = composeB3Transcript({
      store: createTranscriptStore({ root, dataRoot: path.join(root, 'stores') }),
      source,
      messaging,
      turnCompletion: {
        async getSubmission() {
          return b3ok({
            id: submissionId,
            providerTurnId,
            agentRunId: RUN,
            providerSessionId: SESSION,
            providerConversationId: 'provider-native-session',
            transcriptBindingId: deterministicId('transcriptBinding', [
              RUN, 'claude', SESSION,
            ]) as never,
            inputDigest: 'a'.repeat(64),
            startTranscriptWatermark: null,
          });
        },
        async getProviderSession() {
          return b3ok({
            provider: 'claude' as const,
            providerConversationId: 'provider-native-session',
            providerNativeSessionId: 'provider-native-session',
            providerVersion: 'claude-fixture-1.0.0',
          });
        },
        async observe(input) {
          return b3ok({
            kind: 'proven' as const,
            providerCorrelationId: 'native-correlation-7',
            providerNativeTurnId: 'native-turn-7',
            submittedInputSourcePosition: '0000000007',
            completionSourcePosition: '0000000011',
            completionSourceCommittedAt: '2026-08-03T03:04:05.000Z' as never,
            submittedInputEvidenceDigest: input.inputDigest,
            sourceLineIds: [deterministicId('transcriptLine', ['line-7']) as never] as const,
            resultingWatermark: '0000000011',
            turnBoundaryProfileId: deterministicId('turnBoundaryProfile', [
              'claude-fixture-1.0.0',
            ]) as never,
            framingEvidenceDigest: framingDigest,
            limitations: [],
          });
        },
      },
    });
    const bound = await api.bindTranscriptToRun(context('sys_agent_runtime'), {
      agentId: AGENT,
      agentRunId: RUN,
      provider: 'claude',
      providerSessionId: SESSION,
      threadId: 'thread_fixture',
    });
    assert.equal(bound.ok, true, bound.ok ? '' : bound.error.message);
    if (!bound.ok) return;

    const first = await api.reconcileProviderTurnCompletion(context('sys_reconciler'), {
      providerTurnId,
      expectedProviderTurnSubmissionId: submissionId,
    });
    const replay = await api.reconcileProviderTurnCompletion(context('sys_reconciler'), {
      providerTurnId,
      expectedProviderTurnSubmissionId: submissionId,
    });
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (!first.ok || first.value.kind !== 'completed'
      || !replay.ok || replay.value.kind !== 'completed') return;
    assert.deepEqual(replay.value.completion, first.value.completion);
    assert.equal(first.value.completion.observedAt, '2026-08-03T03:04:05.000Z');
    assert.equal(first.value.completion.providerTurnId, providerTurnId);
    assert.equal(first.value.completion.providerNativeTurnId, 'native-turn-7');
    assert.notEqual(first.value.completion.providerNativeTurnId, providerTurnId,
      'provider-native ids stay opaque and never enter the Runtime namespace');

    framingDigest = 'c'.repeat(64);
    const conflicting = await api.reconcileProviderTurnCompletion(context('sys_reconciler'), {
      providerTurnId,
      expectedProviderTurnSubmissionId: submissionId,
    });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.error.code, 'TranscriptCorrupt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncertain or unavailable boundary observations never create a completion fact', async () => {
  for (const kind of ['uncertain', 'unavailable'] as const) {
    const root = mkdtempSync(path.join(tmpdir(), `nvk-transcript-${kind}-`));
    const providerTurnId = mintProviderTurnId();
    const submissionId = providerTurnSubmissionId(
      RUN, { kind: 'runtime-effect', source: 'skills-gate' }, `effect:${kind}`,
    );
    try {
      const store = createTranscriptStore({ root, dataRoot: path.join(root, 'stores') });
      let bindingId = '' as TranscriptBindingId;
      const api = composeB3Transcript({
        store, source, messaging,
        turnCompletion: {
          async getSubmission() {
            return b3ok({
              id: submissionId, providerTurnId, agentRunId: RUN,
              providerSessionId: SESSION, providerConversationId: null,
              transcriptBindingId: bindingId, inputDigest: 'a'.repeat(64),
              startTranscriptWatermark: null,
            });
          },
          async getProviderSession() {
            return b3ok({
              provider: 'kimi' as const, providerConversationId: null,
              providerNativeSessionId: 'native', providerVersion: 'fixture',
            });
          },
          async observe() {
            return b3ok(kind === 'uncertain'
              ? { kind, reason: 'end-frame-ambiguous' as const, evidenceRefs: ['fixture'] }
              : { kind, reason: 'source-unavailable' as const, evidenceRefs: ['fixture'] });
          },
        },
      });
      const bound = await api.bindTranscriptToRun(context('sys_agent_runtime'), {
        agentId: AGENT, agentRunId: RUN, provider: 'kimi', providerSessionId: SESSION,
        threadId: 'thread_fixture',
      });
      assert.equal(bound.ok, true);
      if (!bound.ok) continue;
      bindingId = bound.value.id;
      const outcome = await api.reconcileProviderTurnCompletion(context('sys_reconciler'), {
        providerTurnId, expectedProviderTurnSubmissionId: submissionId,
      });
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.value.kind, kind);
      const listed = await store.list('transcriptTurnCompletion');
      assert.equal(listed.ok, true);
      if (listed.ok) assert.equal(listed.value.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
