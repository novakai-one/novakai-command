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
import type {
  B3Result, HumanPrincipalId,
} from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import type { TerminalSession, TerminalSessionView } from '../../terminal/contract/index.js';
import type { RuntimeStatus } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { buildB3Methods } from '../core/b3/methods.js';

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

/**
 * NVK-KIMI-025 repair 4: this test used to check ONE method and claim "every".
 * It is now parameterised over the whole B3a method table, and the table is
 * READ FROM THE SERVER (`buildB3Methods`) rather than copied here — so a method
 * added without wire coverage fails this test instead of quietly riding along.
 *
 * Ordered on purpose: the calls are a real session's life (open, attach, take
 * the keyboard, type, resize, read, give it back, leave), because a method
 * answering a valid request proves more than one answering a rejected one.
 */
interface WireStep {
  readonly method: string;
  /** Built from what earlier steps returned — this is one session, not fourteen. */
  readonly payload: (state: WireState) => unknown;
  readonly remember?: (state: WireState, value: unknown) => void;
  readonly outcome?: 'success' | 'domain-refusal';
}

interface WireState {
  sessionId: string;
  attachmentId: string;
  leaseId: string;
  leaseGeneration: number;
  nextInputSequence: number;
  epochId: string;
}

const WIRE_STEPS: readonly WireStep[] = [
  {
    method: 'b3.runtime.ensure', payload: () => ({}),
    remember: (state, value) => {
      state.epochId = (value as { activeEpochId: string }).activeEpochId;
    },
  },
  { method: 'b3.runtime.getStatus', payload: () => ({}) },
  { method: 'b3.runtime.doctor', payload: () => ({}) },
  {
    method: 'b3.terminal.open',
    payload: () => ({
      owner: { kind: 'plain-shell', shellInstanceId: 'wire' },
      launchAuthorityRef: 'plain-shell',
      launchFingerprint: 'plain-shell:wire-coverage',
      workingDirectory: '/tmp', columns: 80, rows: 24,
    }),
    remember: (state, value) => { state.sessionId = (value as { id: string }).id; },
  },
  { method: 'b3.terminal.list', payload: () => ({ state: 'live' }) },
  {
    method: 'b3.terminal.inspect',
    payload: (state) => ({ terminalSessionId: state.sessionId }),
    remember: (state, value) => {
      state.nextInputSequence = (value as { nextInputSequence: number }).nextInputSequence;
    },
  },
  {
    method: 'b3.terminal.listIncompleteProviderTurnInputAttempts',
    payload: () => ({ limit: 50 }),
  },
  {
    method: 'b3.terminal.getProviderTurnInputAttempt',
    payload: (state) => ({
      terminalSessionId: state.sessionId,
      providerTurnId: 'providerTurn_019fc81c-f754-731f-a2de-4d4af92ac200',
      submissionEffectKey: 'wire-missing-provider-turn',
    }),
    outcome: 'domain-refusal',
  },
  {
    method: 'b3.terminal.attach',
    payload: (state) => ({
      terminalSessionId: state.sessionId, controllerKind: 'external-terminal',
      columns: 80, rows: 24,
    }),
    remember: (state, value) => { state.attachmentId = (value as { id: string }).id; },
  },
  {
    method: 'b3.terminal.acquireLease',
    payload: (state) => ({
      terminalSessionId: state.sessionId, attachmentId: state.attachmentId,
      mode: 'acquire-if-free', ttlMs: 30_000,
    }),
    remember: (state, value) => {
      const lease = value as { id: string; generation: number };
      state.leaseId = lease.id;
      state.leaseGeneration = lease.generation;
    },
  },
  {
    method: 'b3.terminal.write',
    payload: (state) => ({
      terminalSessionId: state.sessionId, attachmentId: state.attachmentId,
      inputLeaseId: state.leaseId, leaseGeneration: state.leaseGeneration,
      expectedNextInputSequence: state.nextInputSequence,
      kindOfInput: 'text', utf8Text: 'echo wire\r',
    }),
  },
  {
    method: 'b3.terminal.resize',
    payload: (state) => ({
      terminalSessionId: state.sessionId, attachmentId: state.attachmentId,
      columns: 100, rows: 30,
    }),
  },
  {
    method: 'b3.terminal.read',
    payload: (state) => ({ terminalSessionId: state.sessionId, afterOutputSequence: 0 }),
  },
  {
    method: 'b3.terminal.releaseLease',
    payload: (state) => ({
      terminalSessionId: state.sessionId, attachmentId: state.attachmentId,
      leaseId: state.leaseId, generation: state.leaseGeneration,
    }),
  },
  {
    method: 'b3.terminal.detach',
    payload: (state) => ({
      terminalSessionId: state.sessionId, attachmentId: state.attachmentId,
    }),
  },
  // Last, and deliberately: it ends the runtime this rig is talking to.
  {
    method: 'b3.runtime.stop',
    payload: (state) => ({ expectedEpochId: state.epochId, liveRuns: 'refuse' }),
  },
];

test('every b3 method rides the existing {id, method, params, v:1} frame', async () => {
  const rig = await createRig();
  try {
    // The list of methods is the SERVER's, not this file's opinion of it.
    const served = Object.keys(buildB3Methods({
      runtime: rig.host.runtime, principalId: 'person_chris' as HumanPrincipalId,
    }));
    assert.deepEqual(
      [...served].sort(),
      [...WIRE_STEPS.map((step) => step.method)].sort(),
      'a b3 method is served that this test never puts on the wire',
    );

    const state: WireState = {
      sessionId: '', attachmentId: '', leaseId: '',
      leaseGeneration: 0, nextInputSequence: 1, epochId: '',
    };
    for (const [index, step] of WIRE_STEPS.entries()) {
      const id = 100 + index;
      const raw = await rig.client.sendRaw({
        id, method: step.method, v: 1,
        params: { contractVersion: 1, payload: step.payload(state) },
      });
      assert.equal(raw.v, 1, `${step.method}: the response frame is not v1`);
      assert.equal(raw.id, id, `${step.method}: the frame id was not echoed`);
      assert.equal(raw.error, undefined,
        `${step.method}: a domain call used the frame-level error slot`);

      // Domain success/failure travels as a Result INSIDE result (§16.1).
      const result = raw.result as B3Result<unknown> | undefined;
      assert.equal(typeof result?.ok, 'boolean', `${step.method}: no Result inside result`);
      assert.equal(result?.ok, step.outcome !== 'domain-refusal',
        `${step.method} returned the wrong domain disposition: ${JSON.stringify(result)}`);
      if (result?.ok) step.remember?.(state, result.value);
    }
  } finally {
    await rig.close();
  }
});

test('the frame carries the runtime\'s own answer, not a shape that merely parses', async () => {
  const rig = await createRig();
  try {
    const raw = await rig.client.sendRaw({
      id: 41, method: 'b3.runtime.getStatus', v: 1,
      params: { contractVersion: 1, payload: {} },
    });
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
