// A conflict a well-behaved client can always recover from — §17.2, §20.
//
// Both terminal-write conflicts are typed and `retryable`, which is a promise:
// a caller that reads the error and does what it says gets through. One of them
// was not keeping it. `InputLeaseGenerationChanged` advertised `actual: 0` when
// no lease was held, and `readWriteTerminalInput` refuses `leaseGeneration: 0`
// — so a client that trusted the error had no legal value to send, forever.
// That is the loop that blinded every provider leg of the hold-out exam: a
// terminal write is how a transcript turn comes to exist.
//
// The test is written as a CLIENT: it may read the error's details and the
// published methods, and nothing else. No product constant is imported to
// paper over an unusable answer.
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
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-conflicts-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });

  const role = await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole('conflicts'),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await chris.call<{ run: { terminalSessionId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: 'Conflicts', workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error('spawn failed');
  const terminalSessionId = spawned.value.run.terminalSessionId;

  const attached = await chris.call<{ id: string }>('b3.terminal.attach', {
    terminalSessionId, controllerKind: 'novakai-shell', columns: 80, rows: 24,
  });
  assert.equal(attached.ok, true);
  if (!attached.ok) throw new Error('attach failed');

  return {
    host, chris, terminalSessionId, attachmentId: attached.value.id,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ConflictDetails {
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly reason?: string;
  readonly expectedNextInputSequence?: unknown;
  readonly nextAction?: string;
}

test('a write with no lease tells the client what to DO, not an illegal generation', async () => {
  const rig = await createRig();
  try {
    // No lease acquired: exactly the state a client lands in after a takeover,
    // a lease expiry, or a Runtime restart.
    const refused = await rig.chris.call('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId,
      attachmentId: rig.attachmentId,
      inputLeaseId: 'terminalInputLease_019fc000-0000-7000-8000-000000000000',
      leaseGeneration: 1,
      expectedNextInputSequence: 1,
      kindOfInput: 'text',
      utf8Text: 'hello\r',
    });
    assert.equal(refused.ok, false, 'a write with no lease succeeded');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'InputLeaseGenerationChanged');

    const details = refused.error.details as ConflictDetails;
    // `0` was the advertised generation, and the write validator rejects it.
    // A client obeying the error therefore could not construct a legal retry.
    assert.notEqual(details.actual, 0,
      'the conflict advertises generation 0, which b3.terminal.write refuses as '
      + 'a validation error — a client that trusts this error can never recover');
    assert.equal(details.nextAction, 'acquire-lease',
      'a retryable conflict with no legal generation to retry with must say what '
      + 'the client should do instead');

    // And doing what it says works, first time.
    const lease = await rig.chris.call<{ id: string; generation: number }>(
      'b3.terminal.acquireLease', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        mode: 'acquire-if-free', ttlMs: 60_000,
      },
    );
    assert.equal(lease.ok, true);
    if (!lease.ok) return;
    const written = await rig.chris.call('b3.terminal.write', {
      terminalSessionId: rig.terminalSessionId,
      attachmentId: rig.attachmentId,
      inputLeaseId: lease.value.id,
      leaseGeneration: lease.value.generation,
      expectedNextInputSequence: 1,
      kindOfInput: 'text',
      utf8Text: 'hello\r',
    });
    assert.equal(written.ok, true,
      written.ok ? '' : `${written.error.code}: ${written.error.message}`);
  } finally {
    await rig.close();
  }
});

test('a sequence conflict names the value the next write must claim', async () => {
  const rig = await createRig();
  try {
    const lease = await rig.chris.call<{ id: string; generation: number }>(
      'b3.terminal.acquireLease', {
        terminalSessionId: rig.terminalSessionId, attachmentId: rig.attachmentId,
        mode: 'acquire-if-free', ttlMs: 60_000,
      },
    );
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const write = async (sequence: number): ReturnType<RuntimeClient['call']> =>
      rig.chris.call('b3.terminal.write', {
        terminalSessionId: rig.terminalSessionId,
        attachmentId: rig.attachmentId,
        inputLeaseId: lease.value.id,
        leaseGeneration: lease.value.generation,
        expectedNextInputSequence: sequence,
        kindOfInput: 'text',
        utf8Text: 'x\r',
      });

    const stale = await write(99);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, 'VersionConflict');

    const details = stale.error.details as ConflictDetails;
    // `expected` holds what the CALLER sent and `actual` holds the truth, which
    // reads backwards to anyone recovering from it. The field the request uses
    // is named explicitly, so there is nothing to guess.
    assert.equal(typeof details.expectedNextInputSequence, 'number',
      'the conflict does not name the sequence the next write must claim');
    assert.equal(Number(details.expectedNextInputSequence) >= 1, true,
      'the advertised sequence is below the minimum the write validator accepts');

    const recovered = await write(Number(details.expectedNextInputSequence));
    assert.equal(recovered.ok, true,
      recovered.ok ? '' : `recovery using the advertised sequence failed: `
        + `${recovered.error.code} — ${recovered.error.message}`);
  } finally {
    await rig.close();
  }
});
