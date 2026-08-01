// Finding 4 (NVK-KIMI-021 SEVERE), the half that only the host can fix: a
// controller that goes away without saying goodbye.
//
// §13.4: "Closing Shell, Terminal.app, or a socket is detach." Red gate 4 and
// §24.5 make the controller count load-bearing — 0/1/many must render honestly,
// and "no controller" must never be reachable only by asking politely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { B3Result } from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import type { ControllerAttachment, TerminalSession } from '../../terminal/contract/index.js';
import type { RuntimeStatus } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

async function openAndAttach(client: RuntimeClient): Promise<TerminalSession> {
  const session = unwrap(await client.call<TerminalSession>('b3.terminal.open', {
    owner: { kind: 'plain-shell', shellInstanceId: 'test-shell' },
    launchAuthorityRef: 'plain-shell',
    launchFingerprint: 'plain-shell:/bin/zsh',
    workingDirectory: '/tmp', columns: 80, rows: 24,
  }), 'open');
  unwrap(await client.call<ControllerAttachment>('b3.terminal.attach', {
    terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 80, rows: 24,
  }), 'attach');
  return session;
}

/** Ask the runtime, through the wire, what it believes right now. */
async function controllerCount(host: RunningRuntimeHost): Promise<number> {
  const asking = await connectRuntime({ root: host.runtime.dataRoot.replace(/\/stores$/, ''), port: host.port, token: host.token });
  try {
    const status = unwrap(await asking.call<RuntimeStatus>('b3.runtime.getStatus', {}), 'status');
    return status.attachedControllerCount;
  } finally {
    asking.close();
  }
}

async function settlesTo(
  host: RunningRuntimeHost, expected: number, within = 5_000,
): Promise<number> {
  const deadline = Date.now() + within;
  let seen = await controllerCount(host);
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    seen = await controllerCount(host);
  }
  return seen;
}

test('a controller that closes its socket without saying goodbye is detached', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-controller-truth-'));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const session = await openAndAttach(client);
    assert.equal(await controllerCount(host), 1);

    client.close(); // the window is gone. Nobody detached anything.

    assert.equal(await settlesTo(host, 0), 0,
      'the runtime still believes a window is attached that no longer exists');

    // ...and the session is untouched: a socket closing is detach, never a kill.
    const still = unwrap(await (await connectRuntime({ root, port: host.port, token: host.token }))
      .call<TerminalSession>('b3.terminal.inspect', { terminalSessionId: session.id }), 'inspect');
    assert.equal((still as unknown as { session: TerminalSession }).session.status, 'live');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one window closing does not detach another window on the same session', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-controller-two-'));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const staying = await connectRuntime({ root, port: host.port, token: host.token });
  const leaving = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const session = await openAndAttach(staying);
    unwrap(await leaving.call<ControllerAttachment>('b3.terminal.attach', {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 90, rows: 30,
    }), 'second attach');
    assert.equal(await controllerCount(host), 2);

    leaving.close();
    assert.equal(await settlesTo(host, 1), 1,
      'closing one window took the other one down with it');
  } finally {
    staying.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
