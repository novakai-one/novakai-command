// §13.6 — a continuation is a NEW provider context, so it needs its own
// transcript custody.
//
// Spawn binds (§13.5 row 9). Continuation drains the old endpoint, finalises
// the old watermark and transfers the claim — and never binds. So the moment an
// Agent is continued, its live Run has no TranscriptBinding at all: nothing can
// mirror a turn it speaks, and `b3.transcript.getBinding` on the Run that is
// actually running answers `UnknownAgentRun`.
//
// §13.6's own rule that the superseded Run's binding is neither rewritten nor
// dropped is the other half of this, and it already holds — which is exactly
// why the gap is easy to miss: the OLD binding reads back perfectly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime } from '../../core/b3/client.js';
import { governedRole } from '../governed-role.js';

interface Binding {
  readonly id: string;
  readonly agentRunId: string;
  readonly providerSessionId: string;
}

test('a continuation binds the transcript of the Run that is now running', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-continuation-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('continuation-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Continued', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const first = await chris.call<Binding>('b3.transcript.getBinding', {
      agentRunId: spawned.value.run.id,
    });
    assert.equal(first.ok, true, first.ok ? '' : first.error.code);
    if (!first.ok) return;

    const continued = await chris.call<{ run: { id: string } }>('b3.agent.continue', {
      agentId: spawned.value.agent.agentId,
      expectedOldRunId: spawned.value.run.id,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true,
      continued.ok ? '' : `${continued.error.code}: ${continued.error.message}`);
    if (!continued.ok) return;
    assert.notEqual(continued.value.run.id, spawned.value.run.id,
      'the continuation returned the same Run');

    const second = await chris.call<Binding>('b3.transcript.getBinding', {
      agentRunId: continued.value.run.id,
    });
    assert.equal(second.ok, true,
      second.ok ? '' : `the continued Run has no transcript binding: ${second.error.code} `
        + `— ${second.error.message}`);
    if (!second.ok) return;

    assert.notEqual(second.value.id, first.value.id,
      'the new Run shares the old Run\'s binding: one custody record for two provider contexts');
    assert.equal(second.value.agentRunId, continued.value.run.id);
    assert.notEqual(second.value.providerSessionId, first.value.providerSessionId,
      'the new binding names the OLD provider session, so it would mirror the wrong file');

    // §13.6, restated: the superseded Run keeps its own custody. A continuation
    // moves forward; it does not rewrite what happened.
    const old = await chris.call<Binding>('b3.transcript.getBinding', {
      agentRunId: spawned.value.run.id,
    });
    assert.equal(old.ok, true);
    if (!old.ok) return;
    assert.equal(old.value.id, first.value.id,
      'the continuation rewrote the superseded Run\'s binding');
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
