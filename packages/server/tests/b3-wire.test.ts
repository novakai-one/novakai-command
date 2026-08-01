// The wire contract (§16, AMD-001 A-02) and its negative test.
//
// Build 3 rides the EXISTING nvk-ws v1 frame. The negative test is the one that
// matters: a JSON-RPC 2.0 frame is close enough in shape to dispatch by
// accident, and accepting it would silently create a second dialect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { B3Result } from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import type { TerminalSession, TerminalSessionView } from '../../terminal/contract/index.js';
import type { RuntimeStatus } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly client: RuntimeClient;
  readonly pty: ReturnType<typeof createFakePtyHost>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3-wire-'));
  const pty = createFakePtyHost();
  const host = await startRuntimeHost({ root, port: 0, ptyHost: pty });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, client, pty,
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

test('every b3 method rides the existing {id, method, params, v:1} frame', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 41, method: 'b3.runtime.getStatus', v: 1,
      params: { contractVersion: 1, payload: {} },
    });
    assert.equal(raw.v, 1, 'the response frame is not v1');
    assert.equal(raw.id, 41);
    assert.equal(raw.error, undefined, 'a domain call used the frame-level error slot');

    // Domain success/failure travels as a Result INSIDE result (§16.1).
    const result = raw.result as B3Result<RuntimeStatus>;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.state, 'active');
    assert.equal(result.value.ownedByThisProcess, true);
  } finally {
    await rig.close();
  }
});

test('a JSON-RPC 2.0 frame is REFUSED rather than silently accepted', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      jsonrpc: '2.0', id: 42, method: 'b3.runtime.getStatus',
      params: { contractVersion: 1, payload: {} },
    });
    assert.equal(raw.result, undefined, 'a JSON-RPC frame was dispatched');
    assert.notEqual(raw.error, undefined);
    assert.equal(typeof raw.error === 'object' && raw.error.code, 'UnsupportedProtocolVersion');
  } finally {
    await rig.close();
  }
});

test('an unsupported contract version inside params is refused as a typed Result', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 43, method: 'b3.runtime.getStatus', v: 1,
      params: { contractVersion: 2, payload: {} },
    });
    const result = raw.result as B3Result<unknown>;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'UnsupportedContractVersion');
    assert.deepEqual(result.error.details['supported'], [1]);
  } finally {
    await rig.close();
  }
});

test('an unsupported SOCKET version is still refused at the frame level', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 44, method: 'b3.runtime.getStatus', v: 99,
      params: { contractVersion: 1, payload: {} },
    });
    assert.equal(raw.result, undefined);
    assert.equal(typeof raw.error === 'object' && raw.error.code, 'UnsupportedProtocolVersion');
  } finally {
    await rig.close();
  }
});

test('a terminal opened over the wire is visible, attachable, and survives detach', async () => {
  const rig = await createRig();
  try {
    const session = unwrap(await rig.client.call<TerminalSession>('b3.terminal.open', {
      owner: { kind: 'plain-shell', shellInstanceId: 'wire' },
      launchAuthorityRef: 'plain-shell',
      launchFingerprint: 'plain-shell:wire',
      workingDirectory: '/tmp',
      columns: 80, rows: 24,
    }), 'open');

    const attachment = unwrap(await rig.client.call<{ id: string }>('b3.terminal.attach', {
      terminalSessionId: session.id, controllerKind: 'external-terminal',
      columns: 80, rows: 24,
    }), 'attach');

    unwrap(await rig.client.call('b3.terminal.detach', {
      terminalSessionId: session.id, attachmentId: attachment.id,
    }), 'detach');

    const view = unwrap(await rig.client.call<TerminalSessionView>('b3.terminal.inspect', {
      terminalSessionId: session.id,
    }), 'inspect');
    assert.equal(view.session.status, 'live', 'detaching over the wire stopped the terminal');
    assert.equal(view.attachments.filter((item) => item.state === 'attached').length, 0);
  } finally {
    await rig.close();
  }
});

test('an unknown b3 method is a transport error, not a silent success', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 45, method: 'b3.runtime.doesNotExist', v: 1,
      params: { contractVersion: 1, payload: {} },
    });
    assert.equal(raw.result, undefined);
    assert.equal(typeof raw.error, 'string');
  } finally {
    await rig.close();
  }
});
