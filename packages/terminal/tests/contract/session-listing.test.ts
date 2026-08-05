// A5-05: `listTerminalSessions` is a paged, filtered read (B3V4-AMD-005).
//
// Before this, the query answered `readonly TerminalSessionView[]` behind a
// `state: 'live'|'final'|'all'` filter of the product's own invention — an
// unbounded array with no cursor and no way for a caller to ask for a page.
// A5-05 ratifies it into §12.3 with the same list law every other list method
// obeys: `limit` 1–200, an opaque keyset cursor over the stable
// `(createdAt,id)` order, conjunctive filters, and `Page<T>` omissions.
//
// Everything here drives the PUBLIC contract. The cursor is never constructed
// by a test — only ever handed back, which is what makes it opaque.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventCursor, TerminalSessionId } from '@novakai/foundation/contract';
import {
  createRig, humanPrincipal, openMockManagedSession, openPlainShell, unwrap,
} from '../harness.js';

/** Ids in the order the sessions were opened — the order the page must use. */
async function openSessions(
  rig: ReturnType<typeof createRig>, plain: number, managed: number,
): Promise<readonly TerminalSessionId[]> {
  const ids: TerminalSessionId[] = [];
  for (let index = 0; index < plain; index += 1) {
    ids.push(unwrap(await openPlainShell(rig), 'open plain shell').id);
  }
  for (let index = 0; index < managed; index += 1) {
    ids.push(unwrap(await openMockManagedSession(rig), 'open managed session').id);
  }
  return ids;
}

test('A5-05: the listing answers a Page, not a bare array', async () => {
  const rig = createRig();
  try {
    await openSessions(rig, 2, 0);
    const page = unwrap(
      await rig.terminal.listTerminalSessions(humanPrincipal(), { limit: 200 }),
      'list terminal sessions',
    );
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.omissions, []);
    assert.equal(page.nextCursor, undefined, 'a complete page states no continuation');
  } finally {
    await rig.dispose();
  }
});

test('A5-05: `limit` cuts the page and mints a continuation cursor', async () => {
  const rig = createRig();
  try {
    const opened = await openSessions(rig, 3, 0);
    const first = unwrap(
      await rig.terminal.listTerminalSessions(humanPrincipal(), { limit: 2 }),
      'first page',
    );
    assert.equal(first.items.length, 2);
    assert.notEqual(first.nextCursor, undefined, 'a cut page must say there is more');

    const second = unwrap(
      await rig.terminal.listTerminalSessions(humanPrincipal(), {
        limit: 2, cursor: first.nextCursor!,
      }),
      'second page',
    );
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, undefined);

    // The two pages together are every session, each exactly once, in the
    // stable `(createdAt,id)` order — no gap, no repeat across the boundary.
    const paged = [...first.items, ...second.items].map((view) => view.session.id);
    assert.deepEqual([...paged].sort(), [...opened].sort());
    assert.equal(new Set(paged).size, 3);
  } finally {
    await rig.dispose();
  }
});

test('A5-05: `status` and `owner` filter conjunctively', async () => {
  const rig = createRig();
  try {
    await openSessions(rig, 1, 2);
    const principal = humanPrincipal();

    const live = unwrap(
      await rig.terminal.listTerminalSessions(principal, { limit: 200, status: ['live'] }),
      'live only',
    );
    assert.ok(live.items.length > 0, 'the fake PTY host opens sessions live');
    assert.ok(live.items.every((view) => view.session.status === 'live'));

    const exited = unwrap(
      await rig.terminal.listTerminalSessions(principal, { limit: 200, status: ['exited'] }),
      'exited only',
    );
    assert.deepEqual(exited.items, [], 'nothing has exited yet');

    const agentOwned = unwrap(
      await rig.terminal.listTerminalSessions(principal, {
        limit: 200, owner: { kind: 'agent-run', agentRunId: 'agentRun_00000000-0000-7000-8000-000000000001' as never },
      }),
      'agent-run owned',
    );
    assert.equal(agentOwned.items.length, 2);
    assert.ok(agentOwned.items.every((view) => view.session.owner.kind === 'agent-run'));

    // Conjunctive: an owner that exists AND a status nothing holds is empty,
    // not "the owner match wins".
    const neither = unwrap(
      await rig.terminal.listTerminalSessions(principal, {
        limit: 200, status: ['failed'],
        owner: { kind: 'plain-shell', shellInstanceId: 'shell_1' },
      }),
      'conjunction',
    );
    assert.deepEqual(neither.items, []);
  } finally {
    await rig.dispose();
  }
});

test('A5-05: a cursor from another listing is refused, never misread', async () => {
  const rig = createRig();
  try {
    await openSessions(rig, 1, 0);
    const foreign = await rig.terminal.listTerminalSessions(humanPrincipal(), {
      limit: 200, cursor: 'agentRuns.eyJhIjoxfQ' as EventCursor,
    });
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.error.code, 'ValidationFailed');
    assert.equal(
      (foreign.error.details['issues'] as readonly { path: string }[])[0]?.path, 'cursor',
    );
  } finally {
    await rig.dispose();
  }
});

test('A5-05: `limit` outside 1–200 is refused by the owner', async () => {
  const rig = createRig();
  try {
    for (const limit of [0, -1, 201, 1.5]) {
      const refused = await rig.terminal.listTerminalSessions(humanPrincipal(), { limit });
      assert.equal(refused.ok, false, `limit ${limit} must be refused`);
      if (refused.ok) continue;
      assert.equal(refused.error.code, 'ValidationFailed');
      assert.equal(
        (refused.error.details['issues'] as readonly { path: string }[])[0]?.path, 'limit',
      );
    }
    // The two ends of the range are inside it.
    for (const limit of [1, 200]) {
      const accepted = await rig.terminal.listTerminalSessions(humanPrincipal(), { limit });
      assert.equal(accepted.ok, true, `limit ${limit} must be accepted`);
    }
  } finally {
    await rig.dispose();
  }
});
