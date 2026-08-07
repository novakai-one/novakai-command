// The endpoint that outlived the Runtime that owned it — exam row D2.
//
// D2 sent a Novakai-originated Message to an Agent, got an acceptance carrying
// an `inboxItemId` in `queued-for-agent`, and watched it stall there. The
// exam's own data root says why, and it is not the send path:
//
//   runtimeEpochs.jsonl   17:15:23.069Z  a NEW epoch became active
//   agentRuns.jsonl       agent_ccf7d1d8's Run → interrupted,
//                         finalReason `runtime-reconciled-missing`
//   messagingStoreOps     that Agent's endpoint claim → still `active`,
//                         naming that same dead Run
//   D2's send             17:15:32.731Z — nine seconds after the restart
//
// Boot reconciliation (DEC-B3V4-23) settles a Run whose PTY died with its
// process, and expires the authority that Run issued. It does not drain that
// Run's Messaging endpoint. So the Agent was left advertising an ACTIVE
// endpoint on a Run that had ended and a terminal that no longer existed: a
// reader asking whether the Agent could be reached was told yes, the delivery
// pump correctly refused to type into a finished shift, and the Message queued
// for ever behind an endpoint that had no one behind it.
//
// `stopAgent` has drained the endpoint since the row above was first written
// (`closeEndpointOf`) — for exactly this reason, in its own words: "an
// exact-Run Message aimed at a Run that no longer exists was accepted and
// queued for the Agent — the silent redirect §8.1 forbids, reached by never
// closing the endpoint at all". A Run that ends because its Runtime died is no
// less ended.
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

interface EndpointView {
  readonly claim?: { readonly state: string; readonly agentRunId: string };
}

test('a Run reconciled after a restart does not leave its endpoint advertising itself', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-reconciled-endpoint-'));
  const first = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const before = await connectRuntime({ root, port: first.port, token: first.token });
  let agentId = '';
  let runId = '';
  try {
    const role = await before.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('reconciled-endpoint-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await before.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Reconciled', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;
    agentId = spawned.value.agent.agentId;
    runId = spawned.value.run.id;

    const live = await before.call<EndpointView>('b3.messaging.getAgentEndpoint', { agentId });
    assert.equal(live.ok && live.value.claim?.state, 'active',
      'the endpoint was not active while the Run was live — a different defect');
  } finally {
    before.close();
    await first.close();
  }

  // A new Runtime over the same data root: the epoch the Run belonged to is
  // over, and boot reconciliation settles it.
  const second = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const after = await connectRuntime({ root, port: second.port, token: second.token });
  try {
    const run = await after.call<{ run: { lifecycle: string } }>('b3.agent.getRun', {
      agentRunId: runId,
    });
    assert.equal(run.ok, true, run.ok ? '' : `${run.error.code}: ${run.error.message}`);
    assert.equal(run.ok && run.value.run.lifecycle, 'interrupted',
      'boot did not reconcile the Run at all — a different defect');

    const endpoint = await after.call<EndpointView>('b3.messaging.getAgentEndpoint', { agentId });
    assert.equal(endpoint.ok, true,
      endpoint.ok ? '' : `${endpoint.error.code}: ${endpoint.error.message}`);
    if (!endpoint.ok) return;
    assert.notEqual(endpoint.value.claim?.state, 'active',
      'the Run is over and its endpoint still says the Agent can be reached now: '
      + JSON.stringify(endpoint.value.claim));

    // §8.1 is untouched by any of this: the AGENT is the durable addressee, so
    // mail still queues for whoever comes next rather than being refused.
    const sent = await after.call<{ state: string; inboxItemId?: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId },
        text: 'for whoever picks this up', clientMessageId: 'cmid-reconciled',
      },
    );
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    assert.equal(sent.ok && sent.value.state, 'queued-for-agent');
    assert.notEqual(sent.ok && sent.value.inboxItemId, undefined);

    // And the exact-Run promise is narrowed rather than silently redirected —
    // the failure `closeEndpointOf` exists to prevent, now reached by the other
    // road into a finished shift.
    const exact = await after.call('b3.messaging.sendAgent', {
      target: { kind: 'exact-run', agentRunId: runId },
      text: 'only that shift', clientMessageId: 'cmid-reconciled-exact',
    });
    assert.equal(exact.ok, false,
      'a Message aimed at a Run that ended with its Runtime was accepted for it');
  } finally {
    after.close();
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
