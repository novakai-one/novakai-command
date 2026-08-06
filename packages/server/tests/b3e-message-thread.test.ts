// A5-07: `nvk agent message <agentId|agentRunId> --thread <threadId> --text <text>`.
//
// This is the amendment that closes OQ-11 (freeze §4: "`nvk agent message` has
// no `--thread` flag although `SendAgentMessageInput.threadId` is required …
// Thread selection/creation for a CLI-originated Message is undefined"). The
// ratified answer is the plainest one available: the OPERATOR names the thread.
//
// The shipped CLI answered it a different way — it minted one. With no
// `--thread` it called `b3.messaging.ensureDirectThread` and used whatever came
// back, so `nvk agent message builder --text "status?"` CREATED a durable
// conversation as a side effect of sending one line. Two things are wrong with
// that once A5-07 exists:
//
//   * the flag is not optional in the ratified form, so a script written
//     against §17.1 and a script written against the shipped CLI disagree about
//     what a Message with no thread means;
//   * "a send may create a conversation" is a policy, and it was the CLI's
//     alone. Messaging publishes `ensureDirectThread` precisely so that minting
//     is a thing you ask for on purpose.
//
// The refusal is an encoding error the CLI can see without a Runtime, so it is
// proven on a data root with no runtime token: reaching a socket at all would
// answer `RuntimeUnavailable` instead, which is exactly how we know nothing was
// dispatched — and therefore that no Thread was minted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

/** No runtime token under this root: a dispatched call cannot reach a socket. */
const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59419';
const HERMETIC = ['--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT] as const;

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[], where: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args, ...where], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly ok?: boolean;
  readonly value?: { readonly threadId?: string; readonly messageId?: string };
  readonly error?: { readonly code?: string; readonly message?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

test('a Message with no --thread is refused, and the usage line names the flag', async () => {
  const run = await runNvk(['agent', 'message', 'agent_x', '--text', 'status?'], HERMETIC);
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'ValidationFailed',
    `the CLI dispatched a Message with no thread: ${run.out}`);
  assert.equal(run.code, 2, `exit drifted from the ruled table: ${run.out}`);
  assert.equal(envelope.command, 'agent.message');
  assert.match(envelope.error?.message ?? '', /--thread <threadId>/,
    `the refusal did not name the flag an operator must supply: ${run.out}`);
});

test('a Message with no --text is refused the same way', async () => {
  const run = await runNvk(['agent', 'message', 'agent_x', '--thread', 'thread_x'], HERMETIC);
  assert.equal(envelopeOf(run).error?.code, 'ValidationFailed', run.out);
  assert.equal(run.code, 2);
});

test('an exact-run target obeys the same rule — a Run does not name a thread', async () => {
  const run = await runNvk(['agent', 'message', 'agentRun_x', '--text', 'status?'], HERMETIC);
  assert.equal(envelopeOf(run).error?.code, 'ValidationFailed', run.out);
  assert.equal(run.code, 2);
});

interface Rig {
  readonly where: readonly string[];
  readonly chris: RuntimeClient;
  spawn(name: string): Promise<string>;
}

async function withRuntime(work: (rig: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-msg-thread-'));
  let host: RunningRuntimeHost | null = null;
  let chris: RuntimeClient | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    chris = await connectRuntime({ root, port: host.port, token: host.token });
    const client = chris;
    await work({
      where: ['--root', root, '--port', String(host.port), '--json'],
      chris: client,
      async spawn(name) {
        const role = await client.call<{ id: string }>('b3.agent.createRole', {
          ...governedRole(`${name}-role`),
          skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
        });
        assert.equal(role.ok, true, role.ok ? '' : `${role.error.code}: ${role.error.message}`);
        if (!role.ok) throw new Error('createRole failed');
        const spawned = await client.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
          roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
        });
        assert.equal(spawned.ok, true,
          spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
        if (!spawned.ok) throw new Error('spawn failed');
        return spawned.value.agent.agentId;
      },
    });
  } finally {
    chris?.close();
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('the thread the operator names is the thread the Message lands in', async () => {
  await withRuntime(async (rig) => {
    const agentId = await rig.spawn('Threaded');
    // Minting is a deliberate act, asked for by name. The CLI has no ratified
    // command for it — see the lane report's finding; here the test plays the
    // part of whatever mints the operator's thread.
    const thread = await rig.chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
      between: [{ kind: 'human', personId: 'person_chris' }, { kind: 'agent', agentId }],
    });
    assert.equal(thread.ok, true, thread.ok ? '' : `${thread.error.code}: ${thread.error.message}`);
    if (!thread.ok) return;

    const sent = await runNvk(
      ['agent', 'message', agentId, '--thread', thread.value.id, '--text', 'status?'],
      rig.where,
    );
    assert.equal(sent.code, 0, `the ratified form was refused: ${sent.out}`);
    const envelope = envelopeOf(sent);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'agent.message');
    // The whole point of the flag: the Message is in the thread that was named,
    // not one the CLI picked.
    assert.equal(envelope.value?.threadId, thread.value.id);
  });
});
