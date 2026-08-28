// The other half of the first write: the client that DOES claim a position, and
// computes it the only way the contract allows.
//
// Shift 3 made `expectedNextInputSequence` optional and left `0` a
// `ValidationFailed`, reasoning that refusing it is right as long as the refusal
// says how to proceed. The hold-out exam then blinded all seventeen provider
// rows on exactly that refusal — because a conformant client does not omit the
// field. `WriteTerminalInput` REQUIRES it (pass2 line 2244), so a client holding
// the contract supplies it, and the only value it can derive without a surface
// to read is "nothing has been written, so the next input is the 0th".
//
// The product counts from 1. The spec names neither base — `nextInputSequence`
// appears nowhere in pass2 outside the request field itself — so 0-based is not
// a client error, it is the other legal reading of a contract that never chose.
// Walling one of the two readings out of its FIRST write, permanently, is the
// same unwinnable shape §17.2 exists to forbid.
//
// The rule this file pins: a claim of `0` is the assertion "the stream is still
// empty". On an empty stream that is TRUE, so it is honoured. On a stream that
// has moved it is FALSE — and it fails as `VersionConflict`, which carries the
// real position, rather than as `ValidationFailed`, which carries nothing and
// cannot be recovered from. The optimistic check is not weakened; it is applied
// to a claim that used to be thrown away before it could be checked.
//
// Written as a CLIENT: published methods only, no product constant imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';
import { governedRole } from '../governed-role.js';

interface Rig {
  readonly chris: RuntimeClient;
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-firstzero-'));
  const host: RunningRuntimeHost = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });

  const role = await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole('firstzero'),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await chris.call<{ run: { terminalSessionId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: 'FirstZero', workingDirectory: tmpdir(),
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

test('a first write claiming sequence 0 — "nothing written yet" — is honoured', async () => {
  const rig = await createRig();
  try {
    const written = await rig.chris.call<{ inputSequence: number }>('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId,
      attachmentId: rig.attachmentId,
      inputLeaseId: rig.leaseId,
      leaseGeneration: rig.leaseGeneration,
      expectedNextInputSequence: 0,
      kindOfInput: 'text',
      utf8Text: 'echo zero\r',
    });
    assert.equal(written.ok, true, written.ok
      ? ''
      : `a conformant client's first write was refused — ${written.error.code}: `
        + written.error.message);
  } finally {
    await rig.close();
  }
});

test('claiming 0 on a stream that has MOVED conflicts, and the conflict is recoverable',
  async () => {
    const rig = await createRig();
    try {
      const first = await rig.chris.call<{ inputSequence: number }>('b3.terminal.write', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
        kindOfInput: 'text', utf8Text: 'one\r',
      });
      assert.equal(first.ok, true);

      // The stream is no longer empty, so "nothing has been written" is now a
      // false claim about the world rather than a malformed field.
      const late = await rig.chris.call('b3.terminal.write', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
        expectedNextInputSequence: 0, kindOfInput: 'text', utf8Text: 'two\r',
      });
      assert.equal(late.ok, false, 'a stale "stream is empty" claim was accepted');
      if (late.ok) return;
      assert.equal(late.error.code, 'VersionConflict',
        `a false position claim must conflict, not fail validation (got ${late.error.code})`);

      // And the conflict has to be winnable: it names a value the validator
      // accepts, so the client's next attempt lands.
      const advertised = (late.error.details as { expectedNextInputSequence?: number })
        .expectedNextInputSequence;
      assert.equal(typeof advertised, 'number', 'the conflict advertised no position');
      const retried = await rig.chris.call('b3.terminal.write', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
        expectedNextInputSequence: advertised, kindOfInput: 'text', utf8Text: 'two\r',
      });
      assert.equal(retried.ok, true, retried.ok
        ? ''
        : `the value the conflict advertised was itself refused — ${retried.error.code}`);
    } finally {
      await rig.close();
    }
  });

test('a negative or fractional claim is still a typed refusal that says what it got',
  async () => {
    const rig = await createRig();
    try {
      const refused = await rig.chris.call('b3.terminal.write', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        inputLeaseId: rig.leaseId, leaseGeneration: rig.leaseGeneration,
        expectedNextInputSequence: -1, kindOfInput: 'text', utf8Text: 'neg\r',
      });
      assert.equal(refused.ok, false, 'sequence -1 was accepted');
      if (refused.ok) return;
      assert.equal(refused.error.code, 'ValidationFailed');
      const issues = (refused.error.details as { issues?: { path: string; message: string }[] })
        .issues ?? [];
      const issue = issues.find((entry) => entry.path === 'expectedNextInputSequence');
      assert.notEqual(issue, undefined, 'no issue named the field that was wrong');
      assert.match(issue!.message, /received -1/,
        `the refusal does not say what it received: "${issue!.message}"`);
    } finally {
      await rig.close();
    }
  });
