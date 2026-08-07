// Ordered output with honest gaps, and viewport arbitration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuthoritativeViewport } from '../../contract/index.js';
import {
  createRig, humanContext, humanPrincipal, openPlainShell, unwrap,
} from '../harness.js';
import type { TerminalOutputFrame } from '../../contract/api.js';

async function drain(
  stream: AsyncIterable<{ ok: boolean }>,
): Promise<TerminalOutputFrame[]> {
  const frames: TerminalOutputFrame[] = [];
  for await (const item of stream as AsyncIterable<{ ok: true; value: TerminalOutputFrame } | { ok: false }>) {
    if (item.ok) frames.push(item.value);
  }
  return frames;
}

test('output frames are sequenced and replay from any position', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    for (const text of ['one\n', 'two\n', 'three\n']) rig.ptyHost.latest().emit(text);

    const all = await drain(rig.terminal.readTerminalStream(humanPrincipal(), {
      terminalSessionId: session.id, afterOutputSequence: 0, replayOnly: true,
    }));
    assert.deepEqual(all.map((frame) => frame.kind), ['bytes', 'bytes', 'bytes']);
    assert.deepEqual(all.map((frame) => (frame.kind === 'bytes' ? frame.sequence : -1)), [1, 2, 3]);

    const tail = await drain(rig.terminal.readTerminalStream(humanPrincipal(), {
      terminalSessionId: session.id, afterOutputSequence: 2, replayOnly: true,
    }));
    assert.equal(tail.length, 1);
    assert.equal(tail[0]!.kind === 'bytes' && Buffer.from(tail[0]!.base64, 'base64').toString(), 'three\n');
  } finally {
    await rig.dispose();
  }
});

test('output that aged out of the buffer is reported as a GAP, never as silence', async () => {
  const rig = createRig({ replayBytes: 32 });
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    for (let index = 0; index < 20; index += 1) rig.ptyHost.latest().emit(`line-${index}\n`);

    const frames = await drain(rig.terminal.readTerminalStream(humanPrincipal(), {
      terminalSessionId: session.id, afterOutputSequence: 0, replayOnly: true,
    }));
    const gap = frames[0];
    assert.equal(gap?.kind, 'gap', 'a truncated replay pretended to be complete');
    if (gap?.kind !== 'gap') return;
    assert.ok(gap.earliestAvailable > 1, 'the gap does not say what was lost');
    assert.equal(gap.latestAvailable, 20);

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.replay.latestSequence, 20);
    assert.equal(view.replay.earliestSequence, gap.earliestAvailable);
  } finally {
    await rig.dispose();
  }
});

test('a live reader receives frames produced after it subscribed, then the exit', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const received: TerminalOutputFrame[] = [];
    const reader = (async () => {
      for await (const item of rig.terminal.readTerminalStream(humanPrincipal(), {
        terminalSessionId: session.id, afterOutputSequence: 0,
      })) {
        if (item.ok) received.push(item.value);
        if (item.ok && item.value.kind === 'exit') break;
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    rig.ptyHost.latest().emit('live output\n');
    rig.ptyHost.latest().finish({ exitCode: 0 });
    await reader;

    assert.equal(received.at(-1)?.kind, 'exit');
    assert.ok(received.some((frame) => frame.kind === 'bytes'
      && Buffer.from(frame.base64, 'base64').toString() === 'live output\n'));
  } finally {
    await rig.dispose();
  }
});

test('the lease holder owns the size; without a holder the focused controller does', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig, 80, 24), 'open');
    const wide = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 200, rows: 50,
    }), 'attach wide');
    const narrow = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 60, rows: 20,
    }), 'attach narrow');

    // No lease yet → the most recently focused controller wins.
    let view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(resolveAuthoritativeViewport(view)?.source, 'most-recently-focused');
    assert.deepEqual(rig.ptyHost.latest().resizes.at(-1), { columns: 60, rows: 20 });

    // The lease holder's viewport takes over, even though it is not the newest.
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: wide.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');
    view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    const chosen = resolveAuthoritativeViewport(view);
    assert.equal(chosen?.source, 'input-lease-holder');
    assert.equal(chosen?.attachmentId, wide.id);
    assert.deepEqual(rig.ptyHost.latest().resizes.at(-1), { columns: 200, rows: 50 });

    // A non-holder resizing records its own viewport but does not move the PTY.
    const beforeCount = rig.ptyHost.latest().resizes.length;
    unwrap(await rig.terminal.resizeTerminal(humanContext(), {
      terminalSessionId: session.id, attachmentId: narrow.id, columns: 70, rows: 22,
    }), 'resize non-holder');
    assert.equal(rig.ptyHost.latest().resizes.length, beforeCount,
      'a background window reshaped the shell');

    // ...and when the holder lets go, the other controller's size applies.
    unwrap(await rig.terminal.releaseInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: wide.id,
      leaseId: lease.id, generation: lease.generation,
    }), 'release');
    unwrap(await rig.terminal.resizeTerminal(humanContext(), {
      terminalSessionId: session.id, attachmentId: narrow.id, columns: 71, rows: 23,
    }), 'resize after release');
    assert.deepEqual(rig.ptyHost.latest().resizes.at(-1), { columns: 71, rows: 23 });
  } finally {
    await rig.dispose();
  }
});

test('a detached controller is never chosen as the size source', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig, 80, 24), 'open');
    const staying = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 120, rows: 40,
    }), 'attach staying');
    const leaving = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 60, rows: 20,
    }), 'attach leaving');
    assert.deepEqual(rig.ptyHost.latest().resizes.at(-1), { columns: 60, rows: 20 });

    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: leaving.id,
    }), 'detach');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(resolveAuthoritativeViewport(view)?.attachmentId, staying.id);
    assert.deepEqual(rig.ptyHost.latest().resizes.at(-1), { columns: 120, rows: 40 });
  } finally {
    await rig.dispose();
  }
});
