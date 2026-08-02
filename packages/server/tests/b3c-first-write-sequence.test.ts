// The FIRST write, before any conflict exists — §17.2, §20, and the spec's own
// terminal surface.
//
// P0-7 repaired the conflict branch: a client that provokes `VersionConflict`
// is now told a sequence it is allowed to send back. But a client's first write
// provokes nothing, and it still has to supply `expectedNextInputSequence`.
//
// Where does it get it? Not from the published contract. `WriteTerminalInput`
// requires the field (pass2 line 2244) and NOTHING in the spec's terminal
// surface returns it: `TerminalSessionView`, `ControllerAttachment` and
// `TerminalInputLease` all say nothing about where the input stream is. The
// product added `nextInputSequence` to its own view during NVK-KIMI-025, which
// helps a client that reads THIS repository — and not one holding the contract.
//
// So a conformant client guesses, or omits the field, and both answer
// `ValidationFailed: expectedNextInputSequence must be a whole number between 1
// and 9007199254740991`, forever. That is the unwinnable shape P0-7 exists to
// forbid, one step earlier, and it is what left every provider leg of the
// hold-out exam blind: a terminal write is how a transcript turn comes to be.
//
// Written as a CLIENT: published methods only, and no product constant imported
// to paper over an answer the contract never gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface Rig {
  readonly chris: RuntimeClient;
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-firstwrite-'));
  const host: RunningRuntimeHost = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });

  const role = await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole('firstwrite'),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await chris.call<{ run: { terminalSessionId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: 'FirstWrite', workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
  const terminalSessionId = spawned.value.run.terminalSessionId;

  const attached = await chris.call<{ id: string }>('b3.terminal.attach', {
    terminalSessionId, controllerKind: 'novakai-shell', columns: 80, rows: 24,
  });
  assert.equal(attached.ok, true);
  if (!attached.ok) throw new Error('attach failed');

  const lease = await chris.call<{ id: string; generation: number }>(
    'b3.terminal.acquireLease', {
      terminalSessionId, attachmentId: attached.value.id,
      mode: 'acquire-if-free', ttlMs: 60_000,
    });
  assert.equal(lease.ok, true, lease.ok ? '' : lease.error.message);
  if (!lease.ok) throw new Error('lease failed');

  return {
    chris, terminalSessionId, attachmentId: attached.value.id,
    leaseId: lease.value.id, leaseGeneration: lease.value.generation,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a client holding only the published contract can land its first write', async () => {
  const rig = await createRig();
  try {
    // Every field the spec's `WriteTerminalInput` names EXCEPT the one it gives
    // the client no way to know. Holding the lease is what makes this safe:
    // exclusivity is the lease's promise, and the sequence is the second check
    // on top of it — so declining to claim a position is a stance a sole
    // keyboard-holder is entitled to take, not a hole in the concurrency rule.
    const written = await rig.chris.call<{ inputSequence: number }>('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId,
      attachmentId: rig.attachmentId,
      inputLeaseId: rig.leaseId,
      leaseGeneration: rig.leaseGeneration,
      kindOfInput: 'text',
      utf8Text: 'echo first\r',
    });
    assert.equal(written.ok, true,
      written.ok ? '' : `${written.error.code}: ${written.error.message}`);
    if (!written.ok) return;
    // It landed at a real position, so the next writer's claim still means
    // something.
    assert.equal(Number.isInteger(written.value.inputSequence), true);
    assert.equal(written.value.inputSequence >= 1, true);
  } finally {
    await rig.close();
  }
});

test('a claimed sequence is still checked, and a wrong one still conflicts', async () => {
  const rig = await createRig();
  try {
    const first = await rig.chris.call<{ inputSequence: number }>('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
      inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
      kindOfInput: 'text', utf8Text: 'one\r',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // A caller that DOES know the position keeps the optimistic check: claiming
    // a position that has passed is still a conflict, not a silent append.
    const stale = await rig.chris.call('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
      inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
      expectedNextInputSequence: first.value.inputSequence,
      kindOfInput: 'text', utf8Text: 'two\r',
    });
    assert.equal(stale.ok, false, 'a stale sequence claim was accepted');
    if (stale.ok) return;
    assert.equal(stale.error.code, 'VersionConflict');
  } finally {
    await rig.close();
  }
});

test('an out-of-range sequence is refused with the value it was sent', async () => {
  const rig = await createRig();
  try {
    // `0` is the value NVK-KIMI-025's conflict used to advertise, so it is the
    // guess a recovering client is most likely to make. Refusing it is right —
    // but the refusal has to be actionable, and "must be a whole number between
    // 1 and 9007199254740991" is the identical message an OMITTED field gets.
    // A client cannot tell which mistake it made, which is the difference
    // between a recoverable error and a wall.
    const refused = await rig.chris.call('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
      inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
      expectedNextInputSequence: 0, kindOfInput: 'text', utf8Text: 'zero\r',
    });
    assert.equal(refused.ok, false, 'sequence 0 was accepted');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'ValidationFailed');
    const issues = (refused.error.details as { issues?: { path: string; message: string }[] })
      .issues ?? [];
    const issue = issues.find((entry) => entry.path === 'expectedNextInputSequence');
    assert.notEqual(issue, undefined, 'no issue named the field that was wrong');
    assert.match(issue!.message, /received 0/,
      `the refusal does not say what it received: "${issue!.message}"`);
    assert.match(issue!.message, /omit/,
      `the refusal does not name the way out: "${issue!.message}"`);
  } finally {
    await rig.close();
  }
});
