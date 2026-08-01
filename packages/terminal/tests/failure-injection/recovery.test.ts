// Runtime restart and power loss (DEC-B3V4-23, red gate 27).
//
// The forbidden answer is "still running" when we do not know. A session left
// by a dead epoch is either provably gone (`exited`, with no invented exit
// time) or genuinely unknown (`recovery-required`) — never a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintRuntimeEpochId } from '@novakai/foundation/contract';
import {
  createRig, expectError, humanContext, humanPrincipal, openPlainShell,
  runtimeContext, unwrap,
} from '../harness.js';

test('a session from a dead epoch whose process is gone becomes exited, with no invented exit time', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');

    // The runtime died: its process is gone and a new epoch has taken over.
    rig.ptyHost.forget(session.privateProcessRef);
    const nextEpoch = mintRuntimeEpochId();
    rig.setActiveEpoch(nextEpoch);

    const reconciled = unwrap(await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(nextEpoch), { activeRuntimeEpochId: nextEpoch },
    ), 'reconcile');
    assert.deepEqual(reconciled.reconciledSessionIds, [session.id]);

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.session.status, 'exited');
    assert.equal(view.session.exitedAt, undefined, 'recovery invented an exit time it never observed');
    assert.equal(view.session.exitCode, undefined, 'recovery invented an exit code');
    assert.equal(view.attachments.every((item) => item.state === 'detached'), true,
      'controllers of a dead session still claim to be attached');
  } finally {
    await rig.dispose();
  }
});

test('a session whose process may still exist becomes recovery-required, not exited', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const nextEpoch = mintRuntimeEpochId();
    rig.setActiveEpoch(nextEpoch);

    unwrap(await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(nextEpoch), { activeRuntimeEpochId: nextEpoch },
    ), 'reconcile');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.session.status, 'recovery-required');
  } finally {
    await rig.dispose();
  }
});

test('reconciliation is idempotent and leaves sessions of the CURRENT epoch alone', async () => {
  const rig = createRig();
  try {
    const mine = unwrap(await openPlainShell(rig), 'open');
    const first = unwrap(await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(rig.epochId), { activeRuntimeEpochId: rig.epochId },
    ), 'reconcile 1');
    assert.deepEqual(first.reconciledSessionIds, [], 'live sessions of the active epoch were touched');

    const nextEpoch = mintRuntimeEpochId();
    rig.setActiveEpoch(nextEpoch);
    await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(nextEpoch), { activeRuntimeEpochId: nextEpoch },
    );
    const second = unwrap(await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(nextEpoch), { activeRuntimeEpochId: nextEpoch },
    ), 'reconcile 3');
    assert.deepEqual(second.reconciledSessionIds, [], 'a second pass reconciled the same session again');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), mine.id), 'view');
    assert.equal(view.session.status, 'recovery-required');
  } finally {
    await rig.dispose();
  }
});

test('with no active epoch at all, nothing may open a PTY', async () => {
  const rig = createRig();
  try {
    rig.setActiveEpoch(null);
    const refused = await openPlainShell(rig);
    assert.equal(expectError(refused, 'open with no runtime').code, 'RuntimeUnavailable');
    assert.equal(rig.ptyHost.started.length, 0, 'a PTY was started with no runtime owning it');
  } finally {
    await rig.dispose();
  }
});

test('a recovered session refuses new controllers and new input instead of pretending', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const nextEpoch = mintRuntimeEpochId();
    rig.setActiveEpoch(nextEpoch);
    await rig.terminal.system.reconcileAfterRestart(
      runtimeContext(nextEpoch), { activeRuntimeEpochId: nextEpoch },
    );

    const attach = await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    });
    const failure = expectError(attach, 'attach to recovered session');
    assert.equal(failure.code, 'TerminalNotLive');
    assert.equal(failure.details['status'], 'recovery-required');
  } finally {
    await rig.dispose();
  }
});
