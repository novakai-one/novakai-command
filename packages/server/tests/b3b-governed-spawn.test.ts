// The governed launch — the one shape the skills gate exists for (§6.3, §25-B3b).
//
// Every shipped suite and the bundled three-generation proof used roles whose
// gate was `disabled`, so the only launch that actually exercises the gate was
// never launched by anything. Three independent verifiers each found the same
// thing by trying it: a supervised, gated spawn failed 100% of the time at the
// gate-prompt write and stranded its Run in `provisioning`.
//
// Two properties are proved here, and neither is provable by a fake that owns
// the answer:
//
//   1. a correct provider reply — composed by the TEST from the role's pinned
//      skills, never parsed out of the prompt — passes the gate and releases
//      exactly one work turn;
//   2. a session that only ECHOES what the Runtime typed at it (which is what a
//      real PTY in canonical mode does) can never confirm itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type B3Result, type ClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole, governedTokens } from './governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  close(): Promise<void>;
}

async function createRig(options: { echoInput?: boolean } = {}): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-governed-'));
  const ptyHost = createFakePtyHost({ echoInput: options.echoInput ?? false });
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(),
    // Short, because every refusal case here is proved by the gate giving up.
    gateTimeoutMs: 2_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost,
    async close() {
      await chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function unwrap<T>(result: B3Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const opId = (): ClientOpId => mintClientOpId();

/**
 * Reply as the provider would, once the Runtime has actually opened the PTY.
 * The tokens come from the role WE created, so nothing here can pass by reading
 * the prompt back — which is exactly the failure mode being guarded.
 */
async function replyAsProvider(ptyHost: FakePtyHost, text: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ptyHost.started.length > 0 && ptyHost.started[0]!.written.length > 0) {
      ptyHost.latest().emit(`${text}\n`);
      return;
    }
    await new Promise((settle) => { setTimeout(settle, 25); });
  }
  throw new Error('the Runtime never typed the gate prompt at a PTY');
}

test('a supervised launch through a real two-turn gate reaches ready', async () => {
  const rig = await createRig();
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-builder'), opId(),
    ), 'createRole');

    const spawning = rig.chris.call<{
      agent: { agentId: string };
      run: { id: string; lifecycle: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Governed Builder',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());

    await replyAsProvider(
      rig.ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`,
    );
    const spawned = await spawning;

    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `governed spawn failed: ${spawned.error.code} — ${spawned.error.message}`);
    if (!spawned.ok) return;
    assert.equal(spawned.value.run.lifecycle, 'ready');

    // Exactly two turns: the held prompt, then the released work.
    const typed = rig.ptyHost.latest().written.join('');
    assert.equal(typed.includes('do NOT begin it yet'), true, 'turn 1 never went out');
    assert.equal(typed.includes('Begin the task now'), true, 'the work turn was never released');
    assert.equal(typed.split('Begin the task now').length - 1, 1,
      'the work turn was released more than once');
  } finally {
    await rig.close();
  }
});

test('a session that only echoes the prompt cannot confirm itself', async () => {
  const rig = await createRig({ echoInput: true });
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-echo'), opId(),
    ), 'createRole');

    const spawned = await rig.chris.call('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Echo Only',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());

    assert.equal(spawned.ok, false,
      'the gate accepted its own prompt, echoed back, as the agent confirming its skills');
    if (spawned.ok) return;
    assert.equal(spawned.error.code, 'SkillsConfirmationFailed');
    const typed = rig.ptyHost.latest().written.join('');
    assert.equal(typed.includes('Begin the task now'), false,
      'an echo released the work turn');
  } finally {
    await rig.close();
  }
});

test('a failed governed launch never strands its Run in provisioning', async () => {
  const rig = await createRig();
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-stranding'), opId(),
    ), 'createRole');

    // Nobody ever replies, so the gate times out — the ordinary way a governed
    // launch fails in the field.
    await rig.chris.call('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Maybe Stranded',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'anything' },
    }, opId());

    const runs = unwrap(await rig.chris.call<{ items: readonly { run: { lifecycle: string } }[] }>(
      'b3.agent.listRuns', { includeFinal: true, limit: 50 }, opId(),
    ), 'listRuns');
    const stranded = runs.items.filter((view) => view.run.lifecycle === 'provisioning');
    assert.deepEqual(stranded, [],
      'a Run left in provisioning is a Run nothing will ever finish or clean up');
  } finally {
    await rig.close();
  }
});

test('every turn the Runtime types ends with the key that SENDS it', async () => {
  const rig = await createRig();
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-submit'), opId(),
    ), 'createRole');

    const spawning = rig.chris.call('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Submit Check',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());
    await replyAsProvider(
      rig.ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`,
    );
    const spawned = await spawning;
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);

    // A real provider is a TUI: text typed without Enter sits in its composer
    // for ever. Against `claude` 2.1.219 the gate prompt landed, echoed, and
    // was never sent — so no confirmation could ever arrive and every governed
    // launch failed after the full gate timeout (hold-out B3).
    const enter = String.fromCharCode(13);
    const written = rig.ptyHost.latest().written;
    assert.equal(written.length >= 2, true, 'the gate typed fewer than two turns');
    for (const turn of written) {
      assert.equal(turn.endsWith(enter), true,
        `a turn the Runtime typed was never sent: ${JSON.stringify(turn.slice(-40))}`);
    }
  } finally {
    await rig.close();
  }
});
