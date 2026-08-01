// Finding 4 (NVK-KIMI-021 SEVERE): controller attachments never went stale and
// were never reaped, so "N windows attached" only ever counted upward.
//
// §13.4's ladder is `attached -> stale -> detached`. `stale` is a claim about a
// CONNECTION, which Terminal does not own — the Runtime host does — so it is
// written through the system seam, the same way the active provider turn is.
// §24.5 requires controllers 0/1/many to render honestly; red gate 4 makes
// controller truth load-bearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControllerAttachmentId } from '@novakai/foundation/contract';
import {
  createRig, humanContext, openPlainShell, runtimeContext, unwrap,
} from '../harness.js';

const STALE_AFTER_MS = 120_000;

async function twoWindowsOn(rig: ReturnType<typeof createRig>) {
  const session = unwrap(await openPlainShell(rig), 'open');
  const shell = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
  }), 'attach shell');
  const script = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'script', columns: 80, rows: 24,
  }), 'attach script');
  return { session, shell, script };
}

async function attachedCount(
  rig: ReturnType<typeof createRig>, terminalSessionId: string,
): Promise<number> {
  const view = unwrap(await rig.terminal.getTerminalSession(
    humanContext().principal, terminalSessionId as never,
  ), 'inspect');
  return view.attachments.filter((item) => item.state === 'attached').length;
}

test('a controller the Runtime can no longer see goes stale and stops counting', async () => {
  const rig = createRig({ staleAfterMs: STALE_AFTER_MS });
  try {
    const { session, shell, script } = await twoWindowsOn(rig);
    assert.equal(await attachedCount(rig, session.id), 2);

    // The script's process is gone. It never said goodbye — the case the
    // controller-close suite claims to cover and does not.
    rig.clock.advance(STALE_AFTER_MS + 1);
    const observed = unwrap(await rig.terminal.system.observeControllers(
      runtimeContext(rig.epochId), { attachmentIds: [shell.id] },
    ), 'observe');

    assert.deepEqual(observed.staleAttachmentIds, [script.id]);
    assert.equal(await attachedCount(rig, session.id), 1,
      'a controller nobody can see is still being counted as a window');
    const view = unwrap(await rig.terminal.getTerminalSession(
      humanContext().principal, session.id,
    ), 'inspect');
    assert.equal(view.attachments.find((item) => item.id === script.id)?.state, 'stale');
    assert.equal(view.attachments.find((item) => item.id === shell.id)?.state, 'attached');
  } finally {
    await rig.dispose();
  }
});

test('a controller that is still there is never marked stale, however long it is quiet', async () => {
  const rig = createRig({ staleAfterMs: STALE_AFTER_MS });
  try {
    const { session, shell, script } = await twoWindowsOn(rig);
    const seen: readonly ControllerAttachmentId[] = [shell.id, script.id];

    for (let round = 0; round < 4; round += 1) {
      rig.clock.advance(STALE_AFTER_MS - 1);
      const observed = unwrap(await rig.terminal.system.observeControllers(
        runtimeContext(rig.epochId), { attachmentIds: seen },
      ), 'observe');
      assert.deepEqual(observed.staleAttachmentIds, [],
        'a window that is still open was called stale');
    }
    assert.equal(await attachedCount(rig, session.id), 2);
  } finally {
    await rig.dispose();
  }
});

test('a controller that comes back is attached again, not left stale forever', async () => {
  const rig = createRig({ staleAfterMs: STALE_AFTER_MS });
  try {
    const { session, shell, script } = await twoWindowsOn(rig);
    rig.clock.advance(STALE_AFTER_MS + 1);
    unwrap(await rig.terminal.system.observeControllers(
      runtimeContext(rig.epochId), { attachmentIds: [shell.id] },
    ), 'first observe');
    assert.equal(await attachedCount(rig, session.id), 1);

    unwrap(await rig.terminal.system.observeControllers(
      runtimeContext(rig.epochId), { attachmentIds: [shell.id, script.id] },
    ), 'second observe');
    assert.equal(await attachedCount(rig, session.id), 2,
      'a reconnected controller was left stale');
  } finally {
    await rig.dispose();
  }
});

test('an explicit detach still wins: observing never resurrects a closed window', async () => {
  const rig = createRig({ staleAfterMs: STALE_AFTER_MS });
  try {
    const { session, shell, script } = await twoWindowsOn(rig);
    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: script.id,
    }), 'detach');

    unwrap(await rig.terminal.system.observeControllers(
      runtimeContext(rig.epochId), { attachmentIds: [shell.id, script.id] },
    ), 'observe');
    assert.equal(await attachedCount(rig, session.id), 1,
      'a detached window came back because a socket was still open');
  } finally {
    await rig.dispose();
  }
});

test('only the Runtime may declare a controller stale', async () => {
  const rig = createRig({ staleAfterMs: STALE_AFTER_MS });
  try {
    const { shell } = await twoWindowsOn(rig);
    const refused = await rig.terminal.system.observeControllers(
      humanContext() as never, { attachmentIds: [shell.id] },
    );
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, 'PermissionDenied');
  } finally {
    await rig.dispose();
  }
});
