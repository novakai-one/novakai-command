import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import {
  createFakePtyHost,
  type FakePty,
} from '../../../terminal/adapters/pty-host/fake.js';
import { connectRuntime } from '../../core/b3/client.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import {
  fakeProvidersWithCompletionLimit, governedRole, governedTokens,
} from '../governed-role.js';

const rows = <T extends { id?: string }>(root: string, kind: string): T[] => {
  const parsed = readFileSync(path.join(root, 'stores', `${kind}.jsonl`), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { envelope?: object; payload?: object } & T;
      return record.envelope === undefined
        ? record
        : { ...record.envelope, ...record.payload } as T;
    });
  const latest = new Map<string, T>();
  for (const [index, row] of parsed.entries()) latest.set(row.id ?? String(index), row);
  return [...latest.values()];
};

test('a completed real-composition provider turn advances ActivityGeneration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-provider-turn-generation-'));
  const ptyHost = createFakePtyHost({ echoInput: false, composer: true });
  const providers = fakeProvidersWithCompletionLimit(1);
  const known = new Set<FakePty>();
  let completedProviderTurns = 0;
  const attach = setInterval(() => {
    for (const pty of ptyHost.started) {
      if (known.has(pty)) continue;
      known.add(pty);
      pty.onTurn((turn) => {
        if (!turn.includes('do NOT begin it yet')) return;
        completedProviderTurns += 1;
        pty.emit(`SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}\n`);
      });
    }
  }, 1);
  attach.unref();

  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers,
    gateTimeoutMs: 5_000,
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });

  try {
    const role = await client.call<{ id: string }>(
      'b3.agent.createRole',
      governedRole('provider-turn-generation'),
    );
    assert.equal(role.ok, true, role.ok ? '' : role.error.message);
    if (!role.ok) return;

    const spawned = await client.call<{
      run: { id: string; activityGeneration: number };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id,
      displayName: 'Provider Turn Generation',
      workingDirectory: root,
      task: { kind: 'supervised', brief: 'Wait for one turn.' },
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    assert.equal(completedProviderTurns, 1);
    assert.equal(spawned.value.run.activityGeneration, 4,
      'submit, completion, and work release must each advance one generation');

    // Force at least one periodic reconciliation pass. An unfinished work turn
    // remains active; the gate completion must not be reused to finish it.
    await new Promise((resolve) => { setTimeout(resolve, 1_200); });

    const submissions = rows<{
      id: string;
      providerTurnId: string;
      terminalSessionId: string;
      submissionEffectKey: string;
      state: {
        kind: string;
        terminalInputAttemptId?: string;
        activationActivityGeneration?: number;
        transcriptTurnCompletionId?: string;
        providerUsageEvidenceId?: string;
      };
      startTranscriptWatermark: string | null;
    }>(root, 'providerTurnSubmissions');
    assert.equal(submissions.length, 2, 'both governed origins use the correlation operation');
    const completed = submissions.find((item) => item.state.kind === 'completed');
    const active = submissions.find((item) => item.state.kind === 'submitted-confirmed');
    assert.ok(completed);
    assert.ok(active, `unfinished work turn did not remain active: ${JSON.stringify(submissions)}`);
    const completions = rows<{ id: string; providerTurnId: string }>(
      root, 'transcriptTurnCompletions',
    );
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.providerTurnId, completed!.providerTurnId);
    assert.notEqual(active!.startTranscriptWatermark, null,
      'the successor turn could reuse completion evidence from before its start');
    const evidence = rows<{
      id: string;
      scope: { kind: string; providerTurnId: string; transcriptTurnCompletionId: string };
      measurement: { quality: string; providerTurns: number };
    }>(root, 'providerUsageEvidence').filter(
      (item) => item.scope.kind === 'runtime-turn-completion',
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.scope.providerTurnId, completed!.providerTurnId);
    assert.equal(evidence[0]!.scope.transcriptTurnCompletionId, completions[0]!.id);
    assert.deepEqual(evidence[0]!.measurement, {
      quality: 'partial',
      providerTurns: 1,
      limitations: [
        'provider turn completion is measured; per-turn token and cost attribution is unavailable',
      ],
      evidenceDigest: rows<{ id?: string; completionEvidenceDigest: string }>(
        root, 'transcriptTurnCompletions',
      )[0]!.completionEvidenceDigest,
    });

    const firstPage = await client.call<{
      items: typeof submissions; nextCursor?: string;
    }>(
      'b3.agent.listTurnSubmissions', { includeTerminal: true, limit: 1 },
    );
    assert.equal(firstPage.ok, true, firstPage.ok ? '' : firstPage.error.message);
    assert.equal(firstPage.ok && firstPage.value.items.length, 1);
    assert.equal(firstPage.ok && typeof firstPage.value.nextCursor, 'string');
    if (!firstPage.ok || firstPage.value.nextCursor === undefined) return;
    const secondPage = await client.call<{ items: typeof submissions }>(
      'b3.agent.listTurnSubmissions', {
        includeTerminal: true, limit: 1, cursor: firstPage.value.nextCursor,
      },
    );
    assert.equal(secondPage.ok, true, secondPage.ok ? '' : secondPage.error.message);
    assert.equal(secondPage.ok && secondPage.value.items.length, 1);
    if (secondPage.ok) assert.notEqual(
      secondPage.value.items[0]!.id, firstPage.value.items[0]!.id,
    );
    const exact = await client.call<{ providerTurnId: string }>(
      'b3.agent.getTurnSubmission', { providerTurnId: completed!.providerTurnId },
    );
    assert.equal(exact.ok, true, exact.ok ? '' : exact.error.message);
    if (exact.ok) assert.equal(exact.value.providerTurnId, completed!.providerTurnId);

    const completionStatus = await client.call<{
      kind: string; completion?: { id: string; providerTurnId: string };
    }>('b3.transcript.getTurnCompletionStatus', {
      providerTurnId: completed!.providerTurnId,
    });
    assert.equal(completionStatus.ok, true,
      completionStatus.ok ? '' : completionStatus.error.message);
    if (completionStatus.ok) {
      assert.equal(completionStatus.value.kind, 'completed');
      assert.equal(completionStatus.value.completion?.id, completions[0]!.id);
    }
    const completionExact = await client.call<{ id: string; providerTurnId: string }>(
      'b3.transcript.getTurnCompletion', {
        transcriptTurnCompletionId: completions[0]!.id,
      },
    );
    assert.equal(completionExact.ok, true,
      completionExact.ok ? '' : completionExact.error.message);
    if (completionExact.ok) {
      assert.equal(completionExact.value.providerTurnId, completed!.providerTurnId);
    }
    const completionPage = await client.call<{ items: typeof completions }>(
      'b3.transcript.listTurnCompletions', { limit: 1 },
    );
    assert.equal(completionPage.ok, true,
      completionPage.ok ? '' : completionPage.error.message);
    if (completionPage.ok) assert.deepEqual(
      completionPage.value.items.map((item) => item.id), completions.map((item) => item.id),
    );

    const evidencePage = await client.call<{ items: typeof evidence }>(
      'b3.agent.listProviderTurnCompletionEvidence', {
        providerTurnId: completed!.providerTurnId, limit: 1,
      },
    );
    assert.equal(evidencePage.ok, true, evidencePage.ok ? '' : evidencePage.error.message);
    if (evidencePage.ok) assert.deepEqual(
      evidencePage.value.items.map((item) => item.id), evidence.map((item) => item.id),
    );

    const attemptExact = await client.call<{
      id: string; providerTurnId: string;
      effectState: { kind: string }; turnBarrier: { kind: string };
    }>('b3.terminal.getProviderTurnInputAttempt', {
      terminalSessionId: active!.terminalSessionId,
      providerTurnId: active!.providerTurnId,
      submissionEffectKey: active!.submissionEffectKey,
    });
    assert.equal(attemptExact.ok, true, attemptExact.ok ? '' : attemptExact.error.message);
    assert.equal(attemptExact.ok && attemptExact.value.id, active!.state.terminalInputAttemptId);
    if (attemptExact.ok) assert.equal(
      attemptExact.value.turnBarrier.kind, 'active',
      `active Runtime submission must own an active Terminal barrier; got ${attemptExact.value.turnBarrier.kind}`,
    );
    const incompleteAttempts = await client.call<{ items: Array<{ id: string }> }>(
      'b3.terminal.listIncompleteProviderTurnInputAttempts', {
        terminalSessionId: active!.terminalSessionId, limit: 20,
      },
    );
    assert.equal(incompleteAttempts.ok, true,
      incompleteAttempts.ok ? '' : incompleteAttempts.error.message);
    if (incompleteAttempts.ok) assert.deepEqual(
      incompleteAttempts.value.items.map((item) => item.id),
      [active!.state.terminalInputAttemptId],
    );

    const deniedEnsure = await client.call('b3.agent.ensureTurnCompletionEvidence', {
      transcriptTurnCompletionId: completions[0]!.id,
    });
    assert.equal(deniedEnsure.ok, false);
    if (!deniedEnsure.ok) assert.equal(deniedEnsure.error.code, 'PermissionDenied');
    const deniedComplete = await client.call('b3.agent.completeProviderTurn', {
      agentRunId: spawned.value.run.id,
      providerTurnId: completed!.providerTurnId,
      expectedActiveTuple: {
        providerTurnId: completed!.providerTurnId,
        activityGeneration: completed!.state.activationActivityGeneration,
      },
      transcriptTurnCompletionId: completions[0]!.id,
      providerUsageEvidenceId: evidence[0]!.id,
    });
    assert.equal(deniedComplete.ok, false);
    if (!deniedComplete.ok) assert.equal(deniedComplete.error.code, 'PermissionDenied');
    const deniedReconcile = await client.call('b3.transcript.reconcileTurnCompletion', {
      providerTurnId: completed!.providerTurnId,
      expectedProviderTurnSubmissionId: completed!.id,
    });
    assert.equal(deniedReconcile.ok, false);
    if (!deniedReconcile.ok) assert.equal(deniedReconcile.error.code, 'PermissionDenied');

    const eventPage = await client.call<{
      events: Array<{ kind: string; sourceOwner: string }>;
    }>('b3.agent.subscribeEvents', { limit: 200 });
    assert.equal(eventPage.ok, true, eventPage.ok ? '' : eventPage.error.message);
    if (eventPage.ok) {
      const kinds = new Set(eventPage.value.events.map((event) => event.kind));
      for (const required of [
        'agent.run.provider-turn-submission.changed',
        'transcript.provider-turn.completed',
        'agent.run.provider-turn.completed',
        'terminal.provider-turn-barrier.changed',
        'agent.provider-usage-evidence.committed',
      ]) assert.equal(kinds.has(required), true, `missing public event ${required}`);
      assert.equal(kinds.has('agent.provider-turn.submitted'), false);
      assert.equal(kinds.has('agent.provider-turn.completed'), false);
    }
  } finally {
    clearInterval(attach);
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic submit wire requires the caller root clientOpId', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-submit-client-op-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const uuid = '01900000-0000-7000-8000-000000000001';
    const response = await client.sendRaw({
      v: 1, id: 73, method: 'b3.agent.submitProviderTurn',
      params: {
        contractVersion: 1,
        payload: {
          kind: 'controller',
          agentRunId: `agentRun_${uuid}`,
          terminalSessionId: `terminal_${uuid}`,
          transcriptBindingId: `transcriptBinding_${'a'.repeat(52)}`,
          attachmentId: `controller_${uuid}`,
          inputLeaseId: `terminalInputLease_${uuid}`,
          leaseGeneration: 1,
          expectedNextInputSequence: 1,
          utf8Text: 'one semantic turn',
        },
      },
    });
    const result = response.result as { ok: boolean; error?: { code: string; details: { issues: unknown[] } } };
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ValidationFailed');
    assert.deepEqual(result.error?.details.issues, [{ path: 'clientOpId', message: 'required' }]);
  } finally {
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
