// THE headline proof of B3a (red gate 1, DEC-B3V4-08, §13.10).
//
// Closing a window is not a kill signal. Every way a controller can go away —
// tidy detach, the last one leaving, both at once, a hard-killed controller
// that never says goodbye — leaves the session alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRig, humanContext, humanPrincipal, openMockManagedSession, openPlainShell,
  unwrap, expectError, runtimeContext,
} from '../harness.js';

test('closing one controller detaches it and the plain shell keeps running', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const shell = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach shell');

    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: shell.id,
    }), 'detach');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'get');
    assert.equal(view.session.status, 'live', 'detaching a controller stopped the session');
    assert.equal(rig.ptyHost.latest().killed, false, 'the PTY was killed by a window close');
    assert.equal(view.attachments.find((item) => item.id === shell.id)?.state, 'detached');
  } finally {
    await rig.dispose();
  }
});

test('the LAST controller leaving still leaves the session live and reattachable', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const only = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
    }), 'attach');
    rig.ptyHost.latest().emit('before the window closed\r\n');

    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: only.id,
    }), 'detach');

    const afterClose = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'get');
    assert.equal(afterClose.session.status, 'live');
    assert.equal(afterClose.attachments.filter((item) => item.state === 'attached').length, 0);

    // ...and output produced while NOBODY watched is still there on return.
    rig.ptyHost.latest().emit('while nobody was watching\r\n');
    unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'reattach');

    const frames: string[] = [];
    for await (const frame of rig.terminal.readTerminalStream(humanPrincipal(), {
      terminalSessionId: session.id, afterOutputSequence: 0, replayOnly: true,
    })) {
      const value = unwrap(frame, 'frame');
      if (value.kind === 'bytes') frames.push(Buffer.from(value.base64, 'base64').toString('utf8'));
    }
    assert.equal(frames.join(''), 'before the window closed\r\nwhile nobody was watching\r\n');
  } finally {
    await rig.dispose();
  }
});

test('two controllers on one session: either can close without touching the other', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const inApp = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach app');
    const inTerminal = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 120, rows: 40,
    }), 'attach tty');

    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: inTerminal.id,
    }), 'close Terminal.app');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'get');
    assert.equal(view.session.status, 'live');
    assert.equal(view.attachments.find((item) => item.id === inApp.id)?.state, 'attached');
    assert.equal(view.attachments.find((item) => item.id === inTerminal.id)?.state, 'detached');
    assert.equal(rig.ptyHost.latest().killed, false);
  } finally {
    await rig.dispose();
  }
});

test('a detaching lease holder releases the lease without ending the session', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const holder = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: holder.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');

    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: holder.id,
    }), 'detach');

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'get');
    assert.equal(view.session.status, 'live');
    assert.equal(view.activeInputLease, undefined, 'a released lease is still held');
    assert.equal(rig.ptyHost.latest().killed, false);

    // the freed lease is immediately acquirable by whoever is still there
    const second = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
    }), 'attach 2');
    const next = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: second.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire 2');
    assert.ok(next.generation > lease.generation, 'lease generation did not advance');
  } finally {
    await rig.dispose();
  }
});

/**
 * NVK-KIMI-025 repair 1 (SEVERE, found by Fable's behavioural probe): close the
 * window, reopen it, type — and the Runtime answered `VersionConflict: the input
 * stream moved on before this write`, forever.
 *
 * The cause is a contract hole, not a UI slip. `expectedNextInputSequence` is an
 * optimistic-concurrency claim about the input stream, and the input stream's
 * position is RUNTIME-PRIVATE state. A controller that has just arrived cannot
 * know it and must not guess — so the session view has to say it out loud.
 */
test('a window that closes and comes back can still type', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const first = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach 1');
    const firstLease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: first.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire 1');
    for (const [index, text] of ['echo one\r', 'echo two\r'].entries()) {
      unwrap(await rig.terminal.writeInput(humanContext(), {
        terminalSessionId: session.id, attachmentId: first.id,
        inputLeaseId: firstLease.id, leaseGeneration: firstLease.generation,
        expectedNextInputSequence: index + 1, kindOfInput: 'text', utf8Text: text,
      }), `write ${text}`);
    }

    // The window closes. The session keeps running — and keeps its stream position.
    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: first.id,
    }), 'close the window');

    // A NEW window opens on the same session, exactly as reopening the page does.
    const reopened = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'reattach');
    const secondLease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: reopened.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire 2');

    // It asks the Runtime where the stream is instead of assuming it starts over.
    const view = unwrap(
      await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'inspect',
    );
    assert.equal(view.nextInputSequence, 3,
      'the view does not tell a reattaching controller where the input stream is');

    const typed = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: reopened.id,
      inputLeaseId: secondLease.id, leaseGeneration: secondLease.generation,
      expectedNextInputSequence: view.nextInputSequence, kindOfInput: 'text',
      utf8Text: 'echo after reopening\r',
    });
    assert.equal(typed.ok, true, 'a reattached window could not type');
    if (!typed.ok) return;
    assert.equal(typed.value.inputSequence, 3);
    assert.equal(typed.value.outcome, 'submitted-confirmed');
  } finally {
    await rig.dispose();
  }
});

/**
 * The other half of the same repair: a controller that guesses "the stream must
 * start at 1 because I just arrived" is still refused, and the refusal now says
 * what the truth is — so a client can recover instead of retrying forever.
 */
test('a reattached window that guesses the stream position is refused, and told the truth', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    const first = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach 1');
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: first.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire 1');
    unwrap(await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'echo one\r',
    }), 'write');
    unwrap(await rig.terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: first.id,
    }), 'close the window');

    const reopened = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'reattach');
    const secondLease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: reopened.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire 2');

    const guessed = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: reopened.id,
      inputLeaseId: secondLease.id, leaseGeneration: secondLease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'echo guessed\r',
    });
    const refusal = expectError(guessed, 'guessed sequence');
    assert.equal(refusal.code, 'VersionConflict');
    assert.equal(refusal.details['actual'], 2,
      'the refusal did not say where the input stream actually is');
  } finally {
    await rig.dispose();
  }
});

test('a mock managed session survives every controller close case too', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed');
    const first = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 100, rows: 30,
    }), 'attach');
    const second = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'script', columns: 100, rows: 30,
    }), 'attach 2');

    for (const attachment of [first, second]) {
      unwrap(await rig.terminal.detachController(humanContext(), {
        terminalSessionId: session.id, attachmentId: attachment.id,
      }), 'detach');
    }

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'get');
    assert.equal(view.session.status, 'live');
    assert.equal(rig.ptyHost.latest().killed, false);
  } finally {
    await rig.dispose();
  }
});

test('generic input cannot activate a managed provider turn', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed');
    const attachment = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 100, rows: 30,
    }), 'attach');
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: attachment.id,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');
    const refused = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: attachment.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1,
      kindOfInput: 'provider-turn-submit', utf8Text: 'bypass attempt',
    });
    const error = expectError(refused, 'semantic submit bypass');
    assert.equal(error.code, 'SemanticSubmitRequired');
    assert.deepEqual(error.details, {
      terminalSessionId: session.id, kindOfInput: 'provider-turn-submit',
    });
    assert.equal(rig.ptyHost.latest().written.length, 0);
  } finally {
    await rig.dispose();
  }
});

test('stopping a session requires Runtime lifecycle authority, not a controller', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open');

    // A controller has no way to ask for termination: the only entry point
    // demands the Agent Runtime system principal AND the active epoch.
    const stale = await rig.terminal.terminateTerminal(runtimeContext(rig.epochId), {
      terminalSessionId: session.id,
      expectedRuntimeEpochId: 'runtimeEpoch_00000000-0000-7000-8000-0000000000ff' as never,
      reason: 'stop-one',
    });
    assert.equal(expectError(stale, 'stale-epoch terminate').code, 'StaleRuntimeEpoch');
    assert.equal(rig.ptyHost.latest().killed, false);

    const stopped = unwrap(await rig.terminal.terminateTerminal(runtimeContext(rig.epochId), {
      terminalSessionId: session.id,
      expectedRuntimeEpochId: rig.epochId,
      reason: 'stop-one',
    }), 'terminate');
    assert.equal(stopped.status, 'exited');
    assert.equal(rig.ptyHost.latest().killed, true);
  } finally {
    await rig.dispose();
  }
});
