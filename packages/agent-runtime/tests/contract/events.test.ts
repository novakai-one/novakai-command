// The public event stream (§15, §12.2 `subscribeRunEvents`).
//
// Thirty event kinds were published into a function that dropped them: nothing
// kept them, nothing served them, and `subscribeEvents` was not on the wire at
// all (hold-out H3). §24.4's second host has to be able to "subscribe from a
// cursor", and §15 is specific about what a cursor must do when it can no
// longer be honoured — a typed gap, never a silent resume at "now".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunsRig, type RunsRig } from '../runs-harness.js';

async function withRig<T>(work: (rig: RunsRig) => Promise<T>): Promise<T> {
  const rig = createRunsRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

const spawnInput = (roleProfileId: string, displayName: string) => ({
  roleProfileId: roleProfileId as never,
  displayName,
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

test('a spawn leaves events a consumer can read from the start of the stream', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('event-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Watched'));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);

    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true, page.ok ? '' : page.error.message);
    if (!page.ok) return;
    const kinds = page.value.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.operation.stage.changed'), true,
      `the spawn ladder published nothing readable: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.includes('agent.run.lifecycle.changed'), true);

    // §15: every event carries the whole envelope, not just a payload.
    const first = page.value.events[0]!;
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.sourceOwner, 'agent-runtime');
    assert.equal(typeof first.eventId, 'string');
    assert.equal(typeof first.traceId, 'string');
    assert.equal(typeof first.committedAt, 'string');
    assert.equal(typeof first.cursor, 'string');
  });
});

test('a cursor resumes exactly where its holder stopped reading', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('cursor-role');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'First'));
    assert.equal(first.ok, true);

    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const seen = page.value.events.length;
    assert.equal(seen > 0, true);

    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Second'));
    assert.equal(second.ok, true);

    const rest = await rig.runtime.readRunEvents(rig.principal(), {
      after: page.value.nextCursor, limit: 100,
    });
    assert.equal(rest.ok, true, rest.ok ? '' : rest.error.message);
    if (!rest.ok) return;
    assert.equal(rest.value.events.length > 0, true, 'the second spawn published nothing');
    for (const event of rest.value.events) {
      assert.equal(page.value.events.some((old) => old.eventId === event.eventId), false,
        'a cursor handed back an event its holder had already read');
    }
  });
});

test('a cursor this stream cannot honour is a typed gap, not a silent resume', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('gap-role');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Gapped'));
    assert.equal(spawned.ok, true);

    // A cursor minted by a Runtime that is gone. §20's last row: "event cursor
    // expired → typed gap"; the forbidden action is skipping history quietly.
    const stale = await rig.runtime.readRunEvents(rig.principal(), {
      after: 'aaaaaaaaaaaa.3' as never, limit: 10,
    });
    assert.equal(stale.ok, false, 'a foreign cursor was silently resumed');
    if (!stale.ok) {
      assert.equal(stale.error.code, 'CursorExpired');
      assert.equal(typeof stale.error.details['newestCursor'], 'string');
    }

    const nonsense = await rig.runtime.readRunEvents(rig.principal(), {
      after: 'not-a-cursor' as never, limit: 10,
    });
    assert.equal(nonsense.ok, false);
    if (!nonsense.ok) assert.equal(nonsense.error.code, 'ValidationFailed');
  });
});

test('subscribing from a cursor yields the events that follow it', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('subscribe-role');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Before'));
    assert.equal(first.ok, true);
    const page = await rig.runtime.readRunEvents(rig.principal(), { limit: 100 });
    assert.equal(page.ok, true);
    if (!page.ok) return;

    const received: string[] = [];
    const stream = rig.runtime.subscribeRunEvents(rig.principal(), page.value.nextCursor);
    const reading = (async () => {
      for await (const event of stream) {
        if (!event.ok) break;
        received.push(event.value.kind);
        if (received.length >= 3) break;
      }
    })();

    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'After'));
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    await reading;
    assert.equal(received.length, 3, 'the subscription delivered nothing after the cursor');
  });
});
