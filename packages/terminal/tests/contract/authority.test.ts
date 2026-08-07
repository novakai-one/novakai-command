// Finding 6 (NVK-KIMI-021 SEVERE): Terminal performed zero authorisation.
//
// §3.2 requires every durable public mutation to authorise against current
// durable policy. §13.4: "Takeover is an explicit command WITH AUTHORITY".
// §22 puts "active attachment + lease" against every write-terminal-input row.
// B3a having one human principal explains the gap; it does not discharge it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintClientOpId, mintTraceCorrelationId,
  type AuthorityScope, type CommandContext, type HumanPrincipalId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import { TERMINAL_TAKEOVER_SCOPE } from '../../contract/index.js';
import {
  createRig, expectError, humanContext, openPlainShell, unwrap, type Rig,
} from '../harness.js';

const DANA = 'person_dana' as HumanPrincipalId;

/** A second human on the same machine — B3b's world, and today's threat model. */
function otherContext(scopes: readonly AuthorityScope[] = []): CommandContext {
  return {
    principal: { id: DANA, kind: 'human', verifiedScopes: scopes },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

async function shellWithHolder(rig: Rig) {
  const session = unwrap(await openPlainShell(rig), 'open');
  const mine = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
  }), 'attach');
  const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
    terminalSessionId: session.id, attachmentId: mine.id,
    mode: 'acquire-if-free', ttlMs: 60_000,
  }), 'lease');
  return { session, mine, lease };
}

test('a principal cannot detach a controller it does not own', async () => {
  const rig = createRig();
  try {
    const { session, mine } = await shellWithHolder(rig);

    const refused = await rig.terminal.detachController(otherContext(), {
      terminalSessionId: session.id, attachmentId: mine.id,
    });
    assert.equal(expectError(refused, 'foreign detach').code, 'PermissionDenied');

    const view = unwrap(await rig.terminal.getTerminalSession(
      { id: DANA, kind: 'human', verifiedScopes: [] }, session.id,
    ), 'inspect');
    assert.equal(view.attachments.filter((item) => item.state === 'attached').length, 1,
      'someone else closed a window that was not theirs');
  } finally {
    await rig.dispose();
  }
});

test('a principal cannot reshape a controller it does not own', async () => {
  const rig = createRig();
  try {
    const { session, mine } = await shellWithHolder(rig);
    const refused = await rig.terminal.resizeTerminal(otherContext(), {
      terminalSessionId: session.id, attachmentId: mine.id, columns: 20, rows: 5,
    });
    assert.equal(expectError(refused, 'foreign resize').code, 'PermissionDenied');
  } finally {
    await rig.dispose();
  }
});

test('a principal cannot release an input lease it does not hold', async () => {
  const rig = createRig();
  try {
    const { session, mine, lease } = await shellWithHolder(rig);

    const refused = await rig.terminal.releaseInputLease(otherContext(), {
      terminalSessionId: session.id, attachmentId: mine.id,
      leaseId: lease.id, generation: lease.generation,
    });
    assert.equal(expectError(refused, 'foreign release').code, 'PermissionDenied');

    const view = unwrap(await rig.terminal.getTerminalSession(
      { id: DANA, kind: 'human', verifiedScopes: [] }, session.id,
    ), 'inspect');
    assert.equal(view.activeInputLease?.id, lease.id, 'the lease was taken by a stranger');
  } finally {
    await rig.dispose();
  }
});

test('a principal cannot type through a controller it does not own', async () => {
  const rig = createRig();
  try {
    const { session, mine, lease } = await shellWithHolder(rig);

    const refused = await rig.terminal.writeInput(otherContext(), {
      terminalSessionId: session.id, attachmentId: mine.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'rm -rf /\r',
    });
    assert.equal(expectError(refused, 'foreign write').code, 'PermissionDenied');
    assert.deepEqual(rig.ptyHost.latest().written, [], 'a stranger typed into the shell');
  } finally {
    await rig.dispose();
  }
});

test('taking the keyboard from another principal requires authority', async () => {
  const rig = createRig();
  try {
    const { session, lease } = await shellWithHolder(rig);
    const theirs = unwrap(await rig.terminal.attachController(otherContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
    }), 'their attach');

    const refused = await rig.terminal.acquireInputLease(otherContext(), {
      terminalSessionId: session.id, attachmentId: theirs.id,
      mode: 'explicit-takeover', ttlMs: 60_000,
    });
    assert.equal(expectError(refused, 'unauthorised takeover').code, 'PermissionDenied');

    const held = unwrap(await rig.terminal.getTerminalSession(
      { id: DANA, kind: 'human', verifiedScopes: [] }, session.id,
    ), 'inspect');
    assert.equal(held.activeInputLease?.id, lease.id, 'the keyboard was taken without authority');

    // With the scope it is exactly what §13.4 describes: explicit, and it says why.
    const taken = unwrap(await rig.terminal.acquireInputLease(
      otherContext([TERMINAL_TAKEOVER_SCOPE]), {
        terminalSessionId: session.id, attachmentId: theirs.id,
        mode: 'explicit-takeover', ttlMs: 60_000,
      }), 'authorised takeover');
    assert.ok(taken.generation > lease.generation);
  } finally {
    await rig.dispose();
  }
});

test('a controller may still take over its OWN other window', async () => {
  const rig = createRig();
  try {
    const { session, lease } = await shellWithHolder(rig);
    const second = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
    }), 'second window');

    const taken = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: second.id,
      mode: 'explicit-takeover', ttlMs: 60_000,
    }), 'own takeover');
    assert.ok(taken.generation > lease.generation);
  } finally {
    await rig.dispose();
  }
});

test('lifecycle authority is checked, not merely declared in the type', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openPlainShell(rig), 'open');
    // A human context cast into the system seam — the shape a caller can forge.
    const forged = humanContext() as unknown as SystemCommandContext<'sys_agent_runtime'>;
    const refused = await rig.terminal.terminateTerminal(forged, {
      terminalSessionId: session.id,
      expectedRuntimeEpochId: rig.epochId,
      reason: 'stop-one',
    });
    assert.equal(expectError(refused, 'forged terminate').code, 'PermissionDenied');
    assert.equal(rig.ptyHost.latest().killed, false, 'a window stopped a session (red gate 1)');
  } finally {
    await rig.dispose();
  }
});
