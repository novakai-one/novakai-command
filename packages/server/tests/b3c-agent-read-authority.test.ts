// What an Agent Run may READ — §12.5, §19.2, and red gate 5.
//
// The wire composes the server's own system authority for the two
// `sys_transcript` operations, and that elevation is by design FOR THE HUMAN:
// the server IS the composition root, and a human asking it to ingest is the
// root asking Transcript. An AGENT RUN on the same socket got the same
// elevation, and the same unrestricted reads:
//
//   - it could enumerate ANY Agent's communications, inbox, endpoint and the
//     whole conversation-view sidebar, none of which are its own;
//   - it could call `b3.transcript.ingest` and `promoteObservedSubagent`, both
//     typed `sys_transcript`, by being connected.
//
// `verifiedScopes: []` is set deliberately on the agent-run principal — "an
// Agent's authority comes from its GRANTS, never from the socket" — and then
// nothing downstream read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface Spawned {
  readonly agentId: string;
  readonly agentRunId: string;
}

/** The same credential the Runtime issues a child, derived the same way. */
function runToken(root: string, agentRunId: string): string {
  const secret = readFileSync(
    path.join(root, 'runtime', 'run-credential-secret'), 'utf8',
  ).trim();
  return createHmac('sha256', secret).update(agentRunId, 'utf8').digest('hex');
}

test('an Agent Run cannot read other Agents, or reach the sys_transcript operations', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-read-auth-'));
  let host: RunningRuntimeHost | null = null;
  let chris: RuntimeClient | null = null;
  let agent: RuntimeClient | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    chris = await connectRuntime({ root, port: host.port, token: host.token });

    const spawn = async (name: string): Promise<Spawned> => {
      const role = await chris!.call<{ id: string }>('b3.agent.createRole', {
        ...governedRole(`${name}-role`),
        skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      });
      assert.equal(role.ok, true);
      if (!role.ok) throw new Error('createRole failed');
      const spawned = await chris!.call<{
        agent: { agentId: string }; run: { id: string };
      }>('b3.agent.spawn', {
        roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
      });
      assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
      if (!spawned.ok) throw new Error('spawn failed');
      return { agentId: spawned.value.agent.agentId, agentRunId: spawned.value.run.id };
    };

    const reader = await spawn('Reader');
    const other = await spawn('Other');

    // Chris says something to the OTHER Agent. It is none of Reader's business.
    const sent = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: other.agentId },
      text: 'between me and you', clientMessageId: 'cmid-private',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error.message);

    agent = await connectRuntime({
      root, port: host.port, token: host.token,
      agentRunId: reader.agentRunId,
      runToken: runToken(root, reader.agentRunId),
    });

    const binding = await chris.call<{ id: string }>('b3.transcript.getBinding', {
      agentRunId: reader.agentRunId,
    });
    assert.equal(binding.ok, true);
    if (!binding.ok) return;

    const forbidden: readonly { readonly method: string; readonly payload: unknown }[] = [
      { method: 'b3.messaging.listAgentCommunications', payload: { agentIds: [other.agentId] } },
      { method: 'b3.messaging.listAgentInbox', payload: { agentId: other.agentId } },
      { method: 'b3.messaging.getAgentEndpoint', payload: { agentId: other.agentId } },
      { method: 'b3.messaging.listConversationViews', payload: {} },
      { method: 'b3.transcript.ingest', payload: { bindingId: binding.value.id, maxLines: 5 } },
      {
        method: 'b3.transcript.promoteObservedSubagent',
        payload: {
          observedSubagentId:
            'observedSubagent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          roleProfileId: 'agentRole_019fc000-0000-7000-8000-000000000009',
          displayName: 'Smuggled',
        },
      },
    ];

    const allowed: string[] = [];
    for (const probe of forbidden) {
      const answered = await agent.call(probe.method, probe.payload);
      if (answered.ok) { allowed.push(probe.method); continue; }
      // A refusal has to be an AUTHORITY refusal. `ValidationFailed` on a
      // made-up id would let the method through for a real one.
      if (!['PermissionDenied', 'NotAuthorized'].includes(answered.error.code)) {
        allowed.push(`${probe.method} (refused as ${answered.error.code})`);
      }
    }
    assert.deepEqual(allowed, [],
      `an Agent Run reached operations that are not its own: ${allowed.join(', ')}`);

    // The control, twice over. The human keeps every one of them — the server is
    // the composition root and this elevation is by design for Chris...
    for (const probe of forbidden.slice(0, 4)) {
      const answered: Awaited<ReturnType<RuntimeClient['call']>> =
        await chris.call(probe.method, probe.payload);
      assert.equal(answered.ok, true,
        answered.ok ? '' : `the human lost a read they are meant to have: `
          + `${probe.method} → ${answered.error.code}`);
    }
    // ...and the Agent keeps the reads that ARE its own.
    const own = await agent.call('b3.messaging.listAgentInbox', { agentId: reader.agentId });
    assert.equal(own.ok, true,
      own.ok ? '' : `an Agent Run cannot read its own inbox: ${own.error.code}`);
  } finally {
    agent?.close();
    chris?.close();
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
