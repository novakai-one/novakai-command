// B3e lane A — OQ-09's dual form, proven against a LIVE runtime.
//
// `nvk agent inspect` is one ratified command with two value types: an
// `AgentRunView` for an `agentRun_` argument, an `Agent` for an `agent_` one,
// with `CliOutput.command` as the ruled discriminator (X-1, X-3). Until this
// build the agent half had no operation behind it at all — `inspect` always
// called `getRun`, so an Agent id was simply an error — and the new
// `b3.agent.getAgent` (X-4 naming) was proven only by the hermetic harness,
// which asserts which `command` is emitted and can say nothing about the value
// because every call there fails `RuntimeUnavailable` before one exists.
//
// So: a real Runtime, a real role, a real spawn, and both halves of the
// command driven the way an operator drives them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { chatRole } from '../governed-role.js';
import { spawnAgentFixture } from '../support/spawn-agent-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

interface LiveAgent {
  readonly where: readonly string[];
  readonly agentId: string;
  readonly runId: string;
}

/** A live Runtime with one governed Agent prepared through its internal test door. */
async function withSpawnedAgent(work: (live: LiveAgent) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-inspect-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const roleFile = path.join(root, 'role.json');
    writeFileSync(roleFile, JSON.stringify(chatRole('inspect-builder')), 'utf8');
    const defined = await runNvk(['agent', 'define-role', '--file', roleFile, ...where]);
    assert.equal(defined.code, 0, `define-role failed: ${defined.out}`);

    const spawned = await spawnAgentFixture({
      root, port: host.port, roleName: 'inspect-builder', displayName: 'Inspector',
      workingDirectory: root,
    });
    const agentId = String(spawned.agent.agentId);
    const runId = String(spawned.run.id);

    await work({ where, agentId, runId });
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('nvk agent inspect <agentId> answers with the Agent, through b3.agent.getAgent', async () => {
  await withSpawnedAgent(async ({ where, agentId }) => {
    const run = await runNvk(['agent', 'inspect', agentId, ...where]);
    assert.equal(run.code, 0, `inspect <agentId> exited ${String(run.code)}: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'agent.inspect.agent');
    const value = envelope.value ?? {};
    assert.equal(value['id'], agentId);
    for (const field of ['displayName', 'roleProfileId', 'rootHumanPrincipalId', 'status']) {
      assert.ok(field in value, `Agent.${field} missing: ${JSON.stringify(value)}`);
    }
    // The half this closes: the agent form used to return whatever `getRun`
    // said. A `lifecycle` here would mean it is still answering with a Run.
    assert.equal('lifecycle' in value, false, `still an AgentRunView: ${JSON.stringify(value)}`);
    assert.equal(value['displayName'], 'Inspector');
  });
});

/**
 * `AgentRunView` is a composed projection, not a record: the Run itself sits
 * under `run`, beside `agent`, `provider`, `launch`, `family`, `usage` and
 * `transcript`. Read through one accessor so the two shapes are compared on
 * the same terms.
 */
const runViewSection = (value: Record<string, unknown>, name: string): Record<string, unknown> =>
  (value[name] ?? {}) as Record<string, unknown>;

test('nvk agent inspect <agentRunId> still answers with the Run', async () => {
  await withSpawnedAgent(async ({ where, runId }) => {
    const run = await runNvk(['agent', 'inspect', runId, ...where]);
    assert.equal(run.code, 0, `inspect <runId> exited ${String(run.code)}: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'agent.inspect.run');
    const value = envelope.value ?? {};
    for (const section of ['agent', 'provider', 'launch', 'family', 'usage', 'transcript', 'run']) {
      assert.ok(section in value, `AgentRunView.${section} missing: ${JSON.stringify(value)}`);
    }
    assert.equal(runViewSection(value, 'run')['id'], runId);
    assert.equal(runViewSection(value, 'run')['lifecycle'], 'ready');
  });
});

test('the two forms of one command return different records for the same Agent', async () => {
  // The pair, asserted together, because the defect X-1 closes is one command
  // string for both — which looks correct in isolation and is unusable as a
  // discriminator. A consumer must be able to branch on `command` alone and be
  // right about the type it is holding.
  await withSpawnedAgent(async ({ where, agentId, runId }) => {
    const asAgent = envelopeOf(await runNvk(['agent', 'inspect', agentId, ...where]));
    const asRun = envelopeOf(await runNvk(['agent', 'inspect', runId, ...where]));
    assert.notEqual(asAgent.command, asRun.command);
    // The Agent form IS the record — `id` at the top level. The Run form is a
    // projection whose top level has no `id` at all, which is the difference a
    // consumer must not have to discover by sniffing.
    assert.equal(asAgent.value?.['id'], agentId);
    assert.equal(asRun.value?.['id'], undefined);
    assert.equal(runViewSection(asRun.value ?? {}, 'run')['id'], runId);
    // Same Agent, both ways round: the Run names the Agent it belongs to.
    assert.equal(runViewSection(asRun.value ?? {}, 'run')['agentId'], agentId);
    assert.equal(runViewSection(asRun.value ?? {}, 'agent')['agentId'], agentId);
  });
});

test('an id that is neither form resolves to the agent form and is refused there', async () => {
  // X-3 spelled once: ONLY an `agentRun_` prefix picks the run form, so the
  // resolution is total. The refusal must come from the agent lookup — a
  // command that quietly fell back to the run form would report a Run that was
  // never asked for.
  await withSpawnedAgent(async ({ where }) => {
    const run = await runNvk(['agent', 'inspect', 'not-an-id', ...where]);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'agent.inspect.agent');
    assert.notEqual(run.code, 0, `a malformed id was accepted: ${run.out}`);
    assert.ok(envelope.error?.code !== undefined, `no typed error: ${run.out}`);
  });
});

test('the human form of an Agent inspect names the Agent, not a Run', async () => {
  await withSpawnedAgent(async ({ where, agentId }) => {
    const human = await runNvk(['agent', 'inspect', agentId,
      ...where.filter((flag) => flag !== '--json')]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.out, /Inspector/u, `no display name: ${human.out}`);
    assert.ok(human.out.includes(agentId), `no AgentId: ${human.out}`);
    // The role is named by its resolved id, not by the name the role file was
    // defined under: an Agent points at the profile that was resolved for it,
    // and a display name would go stale the moment the role is edited.
    assert.match(human.out, /role agentRole_/u, `no resolved role profile: ${human.out}`);
    assert.match(human.out, /active/u, `no status: ${human.out}`);
    assert.equal(/lifecycle|agentRun_/u.test(human.out), false,
      `the Agent form printed Run facts: ${human.out}`);
  });
});
