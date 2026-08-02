// §15's stream after a LONG exchange — exam row L1, second cause.
//
// `b3c-live-event-stream.test.ts` proves all five §15 kinds reach
// `b3.agent.subscribeEvents` after a SHORT exchange. It passes, and exam L1
// still failed:
//
//   missing: messaging.agent-inbox.changed, messaging.agent-endpoint.changed,
//            transcript.binding.changed
//   saw:     transcript.line.committed, messaging.agent-message.committed
//
// The two it saw are the two the mirror emits continuously. The three it
// missed are emitted once and early — at the bind, at the endpoint ladder, at
// the send. The stream is a bounded 1,000-event ring
// (`agent-runtime/core/events.ts`), and the mirror pump announced
// `transcript.line.committed` on every pass over every binding whether or not
// that pass committed a line. Measured on this tree before the fix: one Run
// with no transcript file at all put 594 of them on the stream in twelve
// seconds. In production's one-second tick, three live Runs turn the whole
// ring over in about five and a half minutes, and the exam waits four minutes
// per provider for a reply. The three kinds were emitted, retained, and then
// evicted by an announcement that nothing had happened.
//
// The assertion below is the cause rather than the symptom, because the cause
// is the honest sentence: an event named `transcript.line.committed` says a
// transcript line was committed, and a pass that committed none has nothing to
// announce. Asserting the eviction directly would mean idling a test for the
// twenty-odd seconds it takes to overrun a 1,000-event ring, and would still
// be measuring this.
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

const REQUIRED = [
  'messaging.agent-message.committed',
  'messaging.agent-inbox.changed',
  'messaging.agent-endpoint.changed',
  'transcript.binding.changed',
] as const;

interface StreamEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

test('an idle mirror announces nothing, so §15 kinds are not evicted by noise', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-stream-survival-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    // One pass every 5ms rather than every second, so a few seconds of test
    // time stands in for several minutes of a real session.
    mirrorIntervalMs: 5,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('survival-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    // Three live Runs, as the exam has three providers up at once.
    let first: string | null = null;
    for (const name of ['SurvivorA', 'SurvivorB', 'SurvivorC']) {
      const spawned: Awaited<ReturnType<typeof chris.call<{ agent: { agentId: string } }>>>
        = await chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
          roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
        });
      assert.equal(spawned.ok, true,
        spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
      if (!spawned.ok) return;
      first ??= spawned.value.agent.agentId;
    }

    const sent = await chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: first },
      text: 'the one message this exchange contains', clientMessageId: 'cmid-survival',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);

    const readStream = async (): Promise<readonly StreamEvent[]> => {
      const page = await chris.call<{ events: readonly StreamEvent[] }>(
        'b3.agent.subscribeEvents', { limit: 1_000 },
      );
      assert.equal(page.ok, true, page.ok ? '' : `${page.error.code}: ${page.error.message}`);
      return page.ok ? page.value.events : [];
    };
    const lineEvents = (events: readonly StreamEvent[]): readonly StreamEvent[] =>
      events.filter((event) => event.kind === 'transcript.line.committed');

    const before = await readStream();
    for (const kind of REQUIRED) {
      assert.equal(before.some((event) => event.kind === kind), true,
        `${kind} never reached the stream at all — a different defect from this one`);
    }

    // Everything this exchange had to say has now been said. From here the
    // Runs just sit there, exactly as the exam's Runs sit waiting on a model.
    const quietFrom = lineEvents(before).length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await readStream();
    const added = lineEvents(after).length - quietFrom;

    assert.equal(added, 0,
      `three idle Runs put ${String(added)} transcript.line.committed events on a `
      + `1,000-event stream in three seconds, each of them saying nothing happened: `
      + JSON.stringify(lineEvents(after).slice(-1).map((event) => event.payload)));

    // The consequence L1 reads, restated: nothing has been pushed off the ring.
    const kinds = new Set(after.map((event) => event.kind));
    const missing = REQUIRED.filter((kind) => !kinds.has(kind));
    assert.deepEqual(missing, [],
      `the idle stretch cost the stream ${missing.join(', ')}`);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
