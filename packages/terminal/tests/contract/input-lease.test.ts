// The input lease (DEC-B3V4-29, red gate 30).
//
// Many controllers may watch. Exactly one may type. Everything here is about
// making "two people typing into one shell" impossible rather than unlikely.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeaseGeneration, TerminalSessionId } from '@novakai/foundation/contract';
import { CONTROL_C } from '../../core/input.js';
import {
  createRig, expectError, humanContext, humanPrincipal, openPlainShell, unwrap, type Rig,
} from '../harness.js';

async function twoControllers(rig: Rig) {
  const session = unwrap(await openPlainShell(rig), 'open');
  const first = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
  }), 'attach 1');
  const second = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
  }), 'attach 2');
  return { sessionId: session.id, first, second };
}

test('two controllers race for the lease: exactly one wins, the other is told who holds it', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const [left, right] = await Promise.all([
      rig.terminal.acquireInputLease(humanContext(), {
        terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 30_000,
      }),
      rig.terminal.acquireInputLease(humanContext(), {
        terminalSessionId: sessionId, attachmentId: second.id, mode: 'acquire-if-free', ttlMs: 30_000,
      }),
    ]);
    const winners = [left, right].filter((item) => item.ok);
    const losers = [left, right].filter((item) => !item.ok);
    assert.equal(winners.length, 1, 'both controllers were granted the lease');
    assert.equal(losers.length, 1);
    const failure = expectError(losers[0]!, 'losing acquire');
    assert.equal(failure.code, 'InputLeaseBusy');
    assert.ok(failure.details['holderAttachmentId'], 'the loser is not told who holds it');
  } finally {
    await rig.dispose();
  }
});

test('the holder types in order; a non-holder cannot type at all', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');

    for (const [index, text] of ['echo one\r', 'echo two\r'].entries()) {
      unwrap(await rig.terminal.writeInput(humanContext(), {
        terminalSessionId: sessionId, attachmentId: first.id,
        inputLeaseId: lease.id, leaseGeneration: lease.generation,
        expectedNextInputSequence: index + 1, kindOfInput: 'text', utf8Text: text,
      }), `write ${index}`);
    }
    assert.deepEqual(rig.ptyHost.latest().written, ['echo one\r', 'echo two\r']);

    const intruder = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: second.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 3, kindOfInput: 'text', utf8Text: 'rm -rf /\r',
    });
    assert.equal(expectError(intruder, 'non-holder write').code, 'InputLeaseGenerationChanged');
    assert.deepEqual(rig.ptyHost.latest().written, ['echo one\r', 'echo two\r'],
      'a controller without the lease reached the process');
  } finally {
    await rig.dispose();
  }
});

test('a stale input sequence is refused rather than silently reordered', async () => {
  const rig = createRig();
  try {
    const { sessionId, first } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');
    unwrap(await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'first\r',
    }), 'write 1');

    const stale = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'again\r',
    });
    const failure = expectError(stale, 'stale sequence write');
    assert.equal(failure.code, 'VersionConflict');
    assert.deepEqual(failure.details['expected'], 1);
    assert.deepEqual(failure.details['actual'], 2);
    assert.deepEqual(rig.ptyHost.latest().written, ['first\r']);
  } finally {
    await rig.dispose();
  }
});

test('lease expiry while input is queued: the late write is refused, not applied', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 5_000,
    }), 'acquire');

    rig.clock.advance(5_001); // the holder went quiet and its time ran out

    const late = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'too late\r',
    });
    assert.equal(expectError(late, 'expired write').code, 'InputLeaseGenerationChanged');
    assert.deepEqual(rig.ptyHost.latest().written, []);

    // The lease is genuinely free now, so the other controller can take it.
    const next = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: second.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire after expiry');
    assert.ok(next.generation > lease.generation);
  } finally {
    await rig.dispose();
  }
});

test('renew keeps the same generation; an explicit takeover moves it and says why', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 5_000,
    }), 'acquire');

    rig.clock.advance(4_000);
    const renewed = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'renew',
      expectedLeaseGeneration: lease.generation, ttlMs: 5_000,
    }), 'renew');
    assert.equal(renewed.generation, lease.generation, 'a renewal moved the generation');
    assert.equal(renewed.id, lease.id);

    rig.clock.advance(4_000); // would have expired without the renewal
    const taken = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: second.id, mode: 'explicit-takeover', ttlMs: 30_000,
    }), 'takeover');
    assert.ok(taken.generation > lease.generation);

    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), sessionId), 'view');
    assert.equal(view.activeInputLease?.id, taken.id);

    // The loser's writes now fail with the exact reason it lost.
    const evicted = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'still mine?\r',
    });
    const failure = expectError(evicted, 'evicted write');
    assert.equal(failure.code, 'InputLeaseGenerationChanged');
    assert.equal(failure.details['reason'], 'not-holder');
  } finally {
    await rig.dispose();
  }
});

test('renewing a lease you do not hold cannot steal it', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');
    const theft = await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: second.id, mode: 'renew',
      expectedLeaseGeneration: lease.generation, ttlMs: 30_000,
    });
    assert.equal(expectError(theft, 'renew by non-holder').code, 'InputLeaseGenerationChanged');
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), sessionId), 'view');
    assert.equal(view.activeInputLease?.attachmentId, first.id);
  } finally {
    await rig.dispose();
  }
});

test('raw Ctrl-C is ordinary ordered input under the lease, not a lifecycle path', async () => {
  const rig = createRig();
  try {
    const { sessionId, first, second } = await twoControllers(rig);
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id, mode: 'acquire-if-free', ttlMs: 30_000,
    }), 'acquire');

    unwrap(await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'sleep 100\r',
    }), 'write');
    unwrap(await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: first.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 2, kindOfInput: 'raw-control-c',
    }), 'ctrl-c');

    assert.deepEqual(rig.ptyHost.latest().written, ['sleep 100\r', CONTROL_C],
      'Ctrl-C did not stay in the ordinary input order');
    // It did NOT end the session, and it did NOT move the lease.
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), sessionId), 'view');
    assert.equal(view.session.status, 'live');
    assert.equal(view.activeInputLease?.generation, lease.generation);

    // ...and a controller WITHOUT the lease cannot send it either.
    const refused = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: sessionId, attachmentId: second.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 3, kindOfInput: 'raw-control-c',
    });
    assert.equal(expectError(refused, 'unleased ctrl-c').code, 'InputLeaseGenerationChanged');
  } finally {
    await rig.dispose();
  }
});

test('a write against an unknown session is typed absence, never a throw', async () => {
  const rig = createRig();
  try {
    const missing = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: 'terminal_00000000-0000-7000-8000-00000000dead' as TerminalSessionId,
      attachmentId: 'controller_00000000-0000-7000-8000-00000000beef' as never,
      inputLeaseId: 'terminalInputLease_00000000-0000-7000-8000-00000000cafe' as never,
      leaseGeneration: 1 as LeaseGeneration,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'hello\r',
    });
    assert.equal(expectError(missing, 'write to nowhere').code, 'UnknownTerminalSession');
  } finally {
    await rig.dispose();
  }
});
