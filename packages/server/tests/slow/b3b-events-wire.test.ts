// `b3.agent.subscribeEvents` on the socket (§16.2, §15, §24.4).
//
// The blind hold-out found no event subscription on the public wire at all —
// no alias, no near-miss — while thirty event kinds were being published
// internally. A second host cannot follow a Run it did not start without it,
// which is precisely what §24.4's proof requires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime } from '../../core/b3/client.js';
import { chatRole } from '../governed-role.js';

interface EventPage {
  events: readonly { kind: string; cursor: string; eventId: string }[];
  nextCursor: string;
}

test('a second host follows a Run it did not start, from a cursor', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-events-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  // Two clients: the one that spawns, and an observer that only ever reads.
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  const observer = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const pushed: { kind: string }[] = [];
    observer.onEvent((name, data) => {
      if (name === 'b3.agent.event') pushed.push(data as { kind: string });
    });

    const start = await observer.call<EventPage>('b3.agent.subscribeEvents', {}, mintClientOpId());
    assert.equal(start.ok, true, start.ok ? '' : `subscribeEvents: ${start.error.message}`);
    if (!start.ok) return;
    const cursor = start.value.nextCursor;

    const role = await chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('event-wire'), mintClientOpId(),
    );
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Observed', workingDirectory: tmpdir(),
    }, mintClientOpId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);

    const since = await observer.call<EventPage>('b3.agent.subscribeEvents', {
      after: cursor,
    }, mintClientOpId());
    assert.equal(since.ok, true, since.ok ? '' : since.error.message);
    if (!since.ok) return;
    const kinds = since.value.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.lifecycle.changed'), true,
      `a spawn nobody could see: ${JSON.stringify(kinds)}`);
    assert.notEqual(since.value.nextCursor, cursor, 'the cursor never moved');

    // The live half: the same facts arrive as ordinary v1 event frames.
    assert.equal(pushed.length > 0, true, 'no event frame was pushed to a connected observer');

    // §15/§20: a cursor this stream cannot honour is a typed gap.
    const stale = await observer.call('b3.agent.subscribeEvents', {
      after: 'ffffffffffff.9',
    }, mintClientOpId());
    assert.equal(stale.ok, false, 'a foreign cursor was silently resumed');
    if (!stale.ok) assert.equal(stale.error.code, 'CursorExpired');
  } finally {
    observer.close();
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
