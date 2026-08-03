import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import {
  createFakePtyHost,
  type FakePty,
} from '../../terminal/adapters/pty-host/fake.js';
import { connectRuntime } from '../core/b3/client.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { governedRole, governedTokens } from './governed-role.js';

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
    providers: createFakeProviderAdapters(),
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
      run: { activityGeneration: number };
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

    const submissions = rows<{
      id: string;
      providerTurnId: string;
      state: { kind: string; transcriptTurnCompletionId?: string; providerUsageEvidenceId?: string };
    }>(root, 'providerTurnSubmissions');
    assert.equal(submissions.length, 2, 'both governed origins use the correlation operation');
    const completed = submissions.find((item) => item.state.kind === 'completed');
    const active = submissions.find((item) => item.state.kind === 'submitted-confirmed');
    assert.ok(completed);
    assert.ok(active);
    const completions = rows<{ id: string; providerTurnId: string }>(
      root, 'transcriptTurnCompletions',
    );
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.providerTurnId, completed!.providerTurnId);
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

    const listed = await client.call<{ items: typeof submissions }>(
      'b3.agent.listTurnSubmissions', { includeTerminal: true, limit: 20 },
    );
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error.message);
    if (listed.ok) assert.equal(listed.value.items.length, 2);
    const exact = await client.call<{ providerTurnId: string }>(
      'b3.agent.getTurnSubmission', { providerTurnId: completed!.providerTurnId },
    );
    assert.equal(exact.ok, true, exact.ok ? '' : exact.error.message);
    if (exact.ok) assert.equal(exact.value.providerTurnId, completed!.providerTurnId);
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

test.todo('§11.2 raw input starts zero turns and one semantic submit starts one');
test.todo('§11.2 all five governed system origins enter the same correlation operation');
test.todo('§11.2 exact provider profiles accept terminal framing and reject every mutant');
test.todo('§11.2 provider-native and Runtime namespaces cannot be confused');
test.todo('§11.2 submission and immutable completion replays preserve one identity');
test.todo('§11.2 concurrent completions cannot both advance one active tuple');
test.todo('§11.2 old completion A cannot mutate newer active turn B');
test.todo('§11.2 transient owner prerequisites resume under the same receipt');
test.todo('§11.2 interrupt and completion races preserve the durable barrier winner');
test.todo('§11.2 unproven completion closes only after both liveness owners are final');
