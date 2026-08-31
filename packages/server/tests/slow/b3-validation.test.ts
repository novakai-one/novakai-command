// Finding 2 (NVK-KIMI-021 SEVERE): §4.2's MUST was unimplemented. `isValidId`
// existed, with a red-gate-3 comment on it, and had ZERO production call sites;
// every b3.* payload reached the contract through a TypeScript cast, which is
// erased at runtime.
//
// §4.2: "Every store, CLI, and wire boundary MUST also run the matching runtime
// validator." §3.2: "validate its complete boundary payload." §24.1 requires
// runtime validation tests for every public input and ID prefix / cross-ID
// rejection tests. Red gates 3 and 24.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { B3Result } from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import type { ControllerAttachment, TerminalSession } from '../../../terminal/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly client: RuntimeClient;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3-validate-'));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, client,
    async close() {
      client.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const GOOD_SHELL = {
  owner: { kind: 'plain-shell', shellInstanceId: 'validation-test' },
  launchAuthorityRef: 'plain-shell',
  launchFingerprint: 'plain-shell:/bin/zsh',
  workingDirectory: '/tmp', columns: 80, rows: 24,
};

async function refusal(
  client: RuntimeClient, method: string, payload: unknown,
): Promise<string> {
  const result = await client.call<unknown>(method, payload);
  if (result.ok) return 'ACCEPTED';
  return result.error.code;
}

test('a wire payload that lies about its shape is refused, not persisted', async () => {
  const rig = await createRig();
  try {
    const refusals = await Promise.all([
      // A controller kind nobody defined.
      refusal(rig.client, 'b3.terminal.open', { ...GOOD_SHELL, columns: -1 }),
      refusal(rig.client, 'b3.terminal.open', { ...GOOD_SHELL, columns: 'eighty' }),
      refusal(rig.client, 'b3.terminal.open', { ...GOOD_SHELL, workingDirectory: '' }),
      refusal(rig.client, 'b3.terminal.open', { ...GOOD_SHELL, owner: { kind: 'root' } }),
      refusal(rig.client, 'b3.terminal.open', { ...GOOD_SHELL, owner: 'plain-shell' }),
    ]);
    assert.deepEqual(refusals, refusals.map(() => 'ValidationFailed'), refusals.join(', '));
  } finally {
    await rig.close();
  }
});

test('an identity of the WRONG KIND is refused, however well-formed it looks', async () => {
  const rig = await createRig();
  try {
    const session = unwrap(await rig.client.call<TerminalSession>(
      'b3.terminal.open', GOOD_SHELL,
    ), 'open');
    const attachment = unwrap(await rig.client.call<ControllerAttachment>('b3.terminal.attach', {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');

    const refusals = await Promise.all([
      // A controller id in the terminal-session slot: well-formed, wrong type.
      refusal(rig.client, 'b3.terminal.inspect', { terminalSessionId: attachment.id }),
      refusal(rig.client, 'b3.terminal.attach', {
        terminalSessionId: attachment.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
      }),
      // A terminal-session id in the attachment slot, the other way round.
      refusal(rig.client, 'b3.terminal.detach', {
        terminalSessionId: session.id, attachmentId: session.id,
      }),
      // An agent-run owner whose id is a controller id (§4.2 cross-ID).
      refusal(rig.client, 'b3.terminal.open', {
        ...GOOD_SHELL, owner: { kind: 'agent-run', agentRunId: attachment.id },
      }),
      // Prefix-strict: the body is a valid UUIDv7, the prefix is not ours.
      refusal(rig.client, 'b3.terminal.inspect', {
        terminalSessionId: session.id.replace('terminal_', 'agentRun_'),
      }),
    ]);
    assert.deepEqual(refusals, refusals.map(() => 'ValidationFailed'), refusals.join(', '));
  } finally {
    await rig.close();
  }
});

test('a closed enum is closed: unknown members of it never reach the contract', async () => {
  const rig = await createRig();
  try {
    const session = unwrap(await rig.client.call<TerminalSession>(
      'b3.terminal.open', GOOD_SHELL,
    ), 'open');

    const refusals = await Promise.all([
      refusal(rig.client, 'b3.terminal.attach', {
        terminalSessionId: session.id, controllerKind: 'root', columns: 80, rows: 24,
      }),
      refusal(rig.client, 'b3.terminal.acquireLease', {
        terminalSessionId: session.id,
        attachmentId: 'controller_00000000-0000-7000-8000-000000000001',
        mode: 'just-take-it', ttlMs: 1000,
      }),
      // A5-05: `status` is a set of the owner's own statuses, and `limit` is
      // required — a filter with neither is not a smaller question, it is an
      // unstated one.
      refusal(rig.client, 'b3.terminal.list', { limit: 10, status: ['everything'] }),
      refusal(rig.client, 'b3.terminal.list', {}),
      refusal(rig.client, 'b3.runtime.stop', {
        expectedEpochId: session.id, liveRuns: 'refuse',
      }),
      refusal(rig.client, 'b3.runtime.stop', {
        expectedEpochId: 'runtimeEpoch_00000000-0000-7000-8000-000000000001',
        liveRuns: 'burn-it-down',
      }),
    ]);
    assert.deepEqual(refusals, refusals.map(() => 'ValidationFailed'), refusals.join(', '));

    // A kindOfInput nobody defined must not reach a real process either.
    const attachment = unwrap(await rig.client.call<ControllerAttachment>('b3.terminal.attach', {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');
    const lease = unwrap(await rig.client.call<{ id: string; generation: number }>(
      'b3.terminal.acquireLease', {
        terminalSessionId: session.id, attachmentId: attachment.id,
        mode: 'acquire-if-free', ttlMs: 60_000,
      }), 'lease');
    assert.equal(await refusal(rig.client, 'b3.terminal.write', {
      terminalSessionId: session.id, attachmentId: attachment.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'anything', utf8Text: 'hello',
    }), 'ValidationFailed');
  } finally {
    await rig.close();
  }
});

test('a well-formed payload still works — the validator is a gate, not a wall', async () => {
  const rig = await createRig();
  try {
    const session = unwrap(await rig.client.call<TerminalSession>(
      'b3.terminal.open', GOOD_SHELL,
    ), 'open');
    const attachment = unwrap(await rig.client.call<ControllerAttachment>('b3.terminal.attach', {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');
    const lease = unwrap(await rig.client.call<{ id: string; generation: number }>(
      'b3.terminal.acquireLease', {
        terminalSessionId: session.id, attachmentId: attachment.id,
        mode: 'acquire-if-free', ttlMs: 60_000,
      }), 'lease');
    const written = await rig.client.call<{ inputSequence: number }>('b3.terminal.write', {
      terminalSessionId: session.id, attachmentId: attachment.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'echo hello\r',
    });
    assert.equal(written.ok, true);
    unwrap(await rig.client.call('b3.terminal.resize', {
      terminalSessionId: session.id, attachmentId: attachment.id, columns: 120, rows: 40,
    }), 'resize');
    unwrap(await rig.client.call('b3.terminal.read', {
      terminalSessionId: session.id, afterOutputSequence: 0,
    }), 'read');
    unwrap(await rig.client.call('b3.terminal.releaseLease', {
      terminalSessionId: session.id, attachmentId: attachment.id,
      leaseId: lease.id, generation: lease.generation,
    }), 'release');
    unwrap(await rig.client.call('b3.terminal.detach', {
      terminalSessionId: session.id, attachmentId: attachment.id,
    }), 'detach');
  } finally {
    await rig.close();
  }
});
