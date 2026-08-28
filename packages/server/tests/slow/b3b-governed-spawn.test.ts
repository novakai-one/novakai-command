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
import {
  createFakePtyHost, type FakePty, type FakePtyHost,
} from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import type {
  InteractiveProviderAdapter, ProviderAdapterRegistry,
} from '../../../agents/b3/contract/providers.js';
import type { ProviderKind } from '../../../agents/b3/contract/records.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';
import { governedRole, governedTokens } from '../governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  close(): Promise<void>;
}

async function createRig(
  options: { echoInput?: boolean; inlineSubmit?: boolean } = {},
): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-governed-'));
  // A composer, not a byte sink: a turn exists only once the submit key arrives
  // on its own. Everything below depends on that distinction.
  const ptyHost = createFakePtyHost({
    echoInput: options.echoInput ?? false, composer: true,
  });
  const host = await startRuntimeHost({
    root, port: 0, ptyHost,
    providers: options.inlineSubmit === true
      ? withInlineSubmit(createFakeProviderAdapters()) : createFakeProviderAdapters(),
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
 * Delivery with the submit key riding inside the text — the shape hold-out B3
 * measured a real `claude` never sending. Used to prove the pass above is
 * CAUSED by submission and not merely correlated with bytes arriving.
 */
function withInlineSubmit(registry: ProviderAdapterRegistry): ProviderAdapterRegistry {
  const built = {} as Record<ProviderKind, InteractiveProviderAdapter>;
  for (const [provider, adapter] of Object.entries(registry) as [
    ProviderKind, InteractiveProviderAdapter,
  ][]) {
    built[provider] = {
      ...adapter,
      deliverTurn: (text: string) => [
        { utf8Text: `${text}${String.fromCharCode(13)}`, pauseMsAfter: 0 },
      ],
    };
  }
  return built;
}

/**
 * Answer as the provider would — but ONLY a turn that was actually sent.
 *
 * This used to fire as soon as the first byte reached the PTY, which lands
 * during the production pause between the text write and the separate Enter
 * write. The gate then reached `ready` whether or not the Enter was ever sent,
 * so the pass proved that a supplied confirmation is accepted and nothing at
 * all about submission (NVK-KIMI-031 finding 3). Now the reply is a reaction to
 * a submitted turn: no submission, no reply, and the gate times out.
 */
function answerWhenAsked(ptyHost: FakePtyHost, text: string): { submitted(): number } {
  let seen = 0;
  const attach = (pty: FakePty): void => {
    pty.onTurn((turn) => {
      seen += 1;
      // Turn 1 is the question; turn 2 is the released work, which is answered
      // by doing it, not by confirming again.
      if (turn.includes('do NOT begin it yet')) pty.emit(`${text}\n`);
    });
  };
  const known = new Set<FakePty>();
  const timer = setInterval(() => {
    for (const pty of ptyHost.started) {
      if (known.has(pty)) continue;
      known.add(pty);
      attach(pty);
    }
  }, 5);
  timer.unref();
  return { submitted: () => seen };
}

test('a supervised launch through a real two-turn gate reaches ready', async () => {
  const rig = await createRig();
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-builder'), opId(),
    ), 'createRole');

    const provider = answerWhenAsked(
      rig.ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`,
    );
    const spawned = await rig.chris.call<{
      agent: { agentId: string };
      run: { id: string; lifecycle: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Governed Builder',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());

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

    // The causal half. The provider only ever answered because a turn was
    // SUBMITTED — two of them, question and released work — and the reply was a
    // reaction to that submission rather than to bytes appearing.
    assert.equal(provider.submitted(), 2,
      `the gate passed on ${String(provider.submitted())} submitted turn(s); `
      + 'a governed launch is exactly two');
    assert.deepEqual(
      rig.ptyHost.latest().turns.map((turn) => turn.includes('do NOT begin it yet')),
      [true, false],
      'the turns that were actually sent are not the question then the work',
    );
  } finally {
    await rig.close();
  }
});

test('an unsubmitted turn cannot pass the gate, however correct the reply', async () => {
  // The control experiment for the test above, and the whole of its causal
  // claim. Everything is identical except one thing: the submit key rides
  // inside the text write instead of arriving as its own, which is the shape a
  // real `claude` absorbs as paste and never sends. A scripted provider stands
  // ready with the exactly-correct confirmation and is never asked, because a
  // turn nobody sent is a turn nobody answers.
  const rig = await createRig({ inlineSubmit: true });
  try {
    const role = unwrap(await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('governed-unsent'), opId(),
    ), 'createRole');

    const provider = answerWhenAsked(
      rig.ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`,
    );
    const spawned = await rig.chris.call('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Never Sent',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());

    assert.equal(spawned.ok, false,
      'the gate passed without the turn ever being submitted');
    if (spawned.ok) return;
    // `ProviderTurnNeverStarted`, not `SkillsConfirmationFailed` (NVK-KIMI-079).
    // The property this test names is unchanged and still asserted below — the
    // gate did not pass, and the work turn was not released. What changed is
    // WHO the failure is attributed to. This session's turn sat in a composer
    // and was never sent, so the agent was never asked anything; recording it
    // as a failed skills confirmation convicted a session that never spoke,
    // which is the misattribution NVK-KIMI-078 found in production.
    assert.equal(spawned.error.code, 'ProviderTurnNeverStarted');
    assert.equal(spawned.error.details['attribution'], 'delivery');
    assert.equal(provider.submitted(), 0,
      'the composer registered a submitted turn from an inline Enter');
    const typed = rig.ptyHost.latest().written.join('');
    assert.equal(typed.includes('Begin the task now'), false,
      'the work turn was released behind an unsubmitted gate');
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

    answerWhenAsked(rig.ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`);
    const spawned = await rig.chris.call('b3.agent.spawn', {
      roleProfileId: role.id,
      displayName: 'Submit Check',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'Say the word BANANA once, then stop.' },
    }, opId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);

    // A real provider is a TUI, and a TUI takes a big fast burst for a PASTE:
    // an Enter INSIDE that burst is absorbed into the pasted text instead of
    // submitting it, so the turn lands in the composer, echoes, and sits there
    // for ever. Measured against `claude` 2.1.219 on 2026-08-02 — a 554-char
    // turn with the Enter inline was never submitted, 6/6; the same turn with
    // the Enter as its OWN write was submitted every time. That is hold-out B3.
    //
    // So the property is not "each write ends with Enter". It is: the text goes
    // in one write, and the key that sends it goes in another.
    const enter = String.fromCharCode(13);
    const written = rig.ptyHost.latest().written;
    assert.equal(written.length >= 4, true,
      'two turns delivered as text-then-key are four writes; fewer means the key rode along');
    for (const write of written) {
      if (write === enter) continue;
      assert.equal(write.includes(enter), false,
        `a turn carried its own Enter and can be absorbed as paste: ${JSON.stringify(write.slice(-40))}`);
    }
    for (const phrase of ['do NOT begin it yet', 'Begin the task now']) {
      const at = written.findIndex((write) => write.includes(phrase));
      assert.notEqual(at, -1, `${phrase} was never typed`);
      assert.equal(written[at + 1], enter, `${phrase} was never followed by the key that sends it`);
    }
  } finally {
    await rig.close();
  }
});
