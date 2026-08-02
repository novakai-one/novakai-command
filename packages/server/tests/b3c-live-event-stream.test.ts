// §15's event stream, driven the way a consumer drives it — nothing composed by
// hand, nothing called that production does not call itself.
//
// The existing `b3c-event-stream.test.ts` composes the capabilities directly and
// performs the endpoint ladder, the bind and the ingest itself. That proves the
// emitters fire when called; it cannot prove PRODUCTION calls them. Exam L1
// watched the same stream through `b3.agent.subscribeEvents` after a real
// exchange and never saw `transcript.line.committed`.
//
// So this test spawns through the wire, sends through the wire, ingests through
// the published `b3.transcript.ingest`, and reads the stream through
// `b3.agent.subscribeEvents`. If a rung is only reachable by a test that
// performs it, this test does not reach it either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

test('a real exchange puts every §15 messaging and transcript kind on the stream', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-live-events-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('events-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Events', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;

    const sent = await chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: spawned.value.agent.agentId },
      text: 'on the record', clientMessageId: 'cmid-live-events',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);

    // Spawn binds the transcript (§13.6 row 9), so the binding this ingest names
    // is one production made — not one the test bound for it.
    const binding = await chris.call<{ id: string }>('b3.transcript.getBinding', {
      agentRunId: spawned.value.run.id,
    });
    assert.equal(binding.ok, true,
      binding.ok ? '' : `no binding for a spawned Run: ${binding.error.code} — ${binding.error.message}`);
    if (!binding.ok) return;

    const ingested = await chris.call('b3.transcript.ingest', {
      bindingId: binding.value.id, maxLines: 50,
    });
    assert.equal(ingested.ok, true,
      ingested.ok ? '' : `the published ingest failed on a production binding: `
        + `${ingested.error.code} — ${ingested.error.message}`);

    const page = await chris.call<{ events: readonly { kind: string }[] }>(
      'b3.agent.subscribeEvents', { limit: 500 },
    );
    assert.equal(page.ok, true, page.ok ? '' : `${page.error.code}: ${page.error.message}`);
    if (!page.ok) return;
    const kinds = new Set(page.value.events.map((event) => event.kind));

    for (const required of [
      'messaging.agent-message.committed',
      'messaging.agent-inbox.changed',
      'messaging.agent-endpoint.changed',
      'transcript.binding.changed',
      'transcript.line.committed',
    ]) {
      assert.equal(kinds.has(required), true,
        `${required} never reached the stream after a real exchange; `
        + `saw ${[...kinds].sort().join(', ')}`);
    }
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
