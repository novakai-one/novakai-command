// `nvk-agent`, as an operator actually runs it (§17.1–17.2, red gates 22–23).
//
// Not a unit test of the argument parser: a real child process, a real socket,
// and a runtime in this one — because the claim B3b makes is that a person or
// a script with a shell can run a governed team WITHOUT importing anything.
// The only way to check that is to not import anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';

// From this file, never from the working directory: the same suite is run
// from the repo root and from `packages/server`, and a cwd-relative root
// silently resolves to a different tree in one of them.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const agentCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-agent.ts');
const spawnCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-agent-spawn.ts');

interface CliOutcome {
  readonly code: number | null;
  readonly json: { ok: boolean; value?: never; error?: { code: string; message: string } } | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Async on purpose: the runtime host runs in THIS process, so a synchronous
 * spawn would block the very event loop the CLI is trying to reach.
 */
function runCli(
  script: string, root: string, port: number, args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<CliOutcome> {
  const child = spawn(
    process.execPath,
    [tsx, script, ...args, '--json', '--root', root, '--port', String(port)],
    { cwd: repoRoot, env: { ...process.env, ...environment } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise<CliOutcome>((resolve) => {
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed: CliOutcome['json'] = null;
      try { parsed = line ? JSON.parse(line) as CliOutcome['json'] : null; } catch { parsed = null; }
      resolve({ code, json: parsed, stdout, stderr });
    });
  });
}

function chatRole(
  name: string, allowedChildRoleIds: readonly string[], provider: string,
): Record<string, unknown> {
  return {
    name,
    description: `${name} for the CLI suite`,
    status: 'active',
    providerPolicy: { allowed: [provider], defaultProvider: provider },
    modelPolicy: {
      allowedModelIds: ['cli-default'], defaultModelId: 'cli-default',
      allowNativeChange: false, allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
    skillRefs: [], hookRefs: [], instructionRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
    spawnPolicy: { allowedChildRoleIds, requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['fresh', 'resume'],
    },
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: [],
      parentNotificationMode: 'queue-only',
    },
    budgetPolicy: { hardStopEnabled: false },
  };
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly root: string;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-cli-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, root,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a person with a shell spawns a governed agent by ROLE NAME, and reads its family', async () => {
  const rig = await createRig();
  try {
    const child = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('cli-builder', [], 'codex'),
    );
    assert.equal(child.ok, true);
    if (!child.ok) return;
    const parent = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('cli-manager', [child.value.id], 'claude'),
    );
    assert.equal(parent.ok, true);

    const listed = await runCli(agentCli, rig.root, rig.host.port, ['roles']);
    assert.equal(listed.json?.ok, true, `roles failed: ${listed.stderr}`);

    // The name, not the uuid — ids are for machines.
    const spawned = await runCli(agentCli, rig.root, rig.host.port, [
      'spawn', '--role', 'cli-manager', '--name', 'CLI Manager', '--cwd', rig.root,
    ]);
    assert.equal(spawned.json?.ok, true, `spawn failed: ${JSON.stringify(spawned.json)}`);
    const view = spawned.json?.value as unknown as {
      agent: { agentId: string }; run: { id: string }; provider: { provider: string };
      launch: { surface: string; requestedBy: string };
    };
    assert.equal(view.provider.provider, 'claude');
    assert.equal(view.launch.surface, 'novakai-shell');

    const inspected = await runCli(agentCli, rig.root, rig.host.port, ['inspect', view.run.id]);
    assert.equal(inspected.json?.ok, true);

    // Positional, because `--root` belongs to the data root on every nvk CLI.
    const tree = await runCli(agentCli, rig.root, rig.host.port, [
      'tree', view.agent.agentId,
    ]);
    assert.equal(tree.json?.ok, true, `tree failed: ${JSON.stringify(tree.json)}`);

    const controls = await runCli(agentCli, rig.root, rig.host.port, ['controls', view.run.id]);
    assert.equal(controls.json?.ok, true, `controls failed: ${JSON.stringify(controls.json)}`);

    const attach = await runCli(agentCli, rig.root, rig.host.port, ['attach', view.run.id]);
    assert.equal(attach.json?.ok, true);
  } finally {
    await rig.close();
  }
});

test('nvk-agent-spawn is the same operation, not a second one', async () => {
  const rig = await createRig();
  try {
    const role = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('compat-role', [], 'kimi'),
    );
    assert.equal(role.ok, true);

    const throughCompatibility = await runCli(spawnCli, rig.root, rig.host.port, [
      '--role', 'compat-role', '--name', 'Compat', '--cwd', rig.root,
    ]);
    assert.equal(throughCompatibility.json?.ok, true,
      `nvk-agent-spawn failed: ${JSON.stringify(throughCompatibility.json)}`);

    const throughCanonical = await runCli(agentCli, rig.root, rig.host.port, [
      'spawn', '--role', 'compat-role', '--name', 'Canonical', '--cwd', rig.root,
    ]);
    assert.equal(throughCanonical.json?.ok, true);

    // Same policy, same shape, same launch surface. A compatibility door that
    // produced a DIFFERENT kind of Run would be red gate 23 exactly.
    const compat = throughCompatibility.json?.value as unknown as {
      launch: { surface: string }; provider: { provider: string };
    };
    const canonical = throughCanonical.json?.value as unknown as {
      launch: { surface: string }; provider: { provider: string };
    };
    assert.deepEqual(compat.launch.surface, canonical.launch.surface);
    assert.deepEqual(compat.provider.provider, canonical.provider.provider);
  } finally {
    await rig.close();
  }
});

test('a forbidden override fails at the CLI too, and spawns nothing', async () => {
  const rig = await createRig();
  try {
    const role = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('locked-role', [], 'claude'),
    );
    assert.equal(role.ok, true);

    const refused = await runCli(agentCli, rig.root, rig.host.port, [
      'spawn', '--role', 'locked-role', '--name', 'Impostor',
      '--cwd', rig.root, '--provider', 'kimi',
    ]);
    assert.equal(refused.json?.ok, false);
    assert.equal(refused.json?.error?.code, 'LaunchPlanInvalid');
    assert.notEqual(refused.code, 0, 'a refused command must not exit 0');

    const runs = await rig.chris.call<{ items: readonly unknown[] }>(
      'b3.agent.listRuns', { includeFinal: true, limit: 50 },
    );
    assert.equal(runs.ok && runs.value.items.length, 0,
      'the refusal must have happened before anything was spawned');
  } finally {
    await rig.close();
  }
});

test('an Agent running inside its own PTY spawns as ITSELF, from the same CLI', async () => {
  const rig = await createRig();
  try {
    const child = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('env-child', [], 'codex'),
    );
    assert.equal(child.ok, true);
    if (!child.ok) return;
    const parentRole = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', chatRole('env-parent', [child.value.id], 'claude'),
    );
    assert.equal(parentRole.ok, true);
    if (!parentRole.ok) return;

    const parent = await rig.chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: parentRole.value.id, displayName: 'Env Parent', workingDirectory: rig.root,
    });
    assert.equal(parent.ok, true);
    if (!parent.ok) return;

    // Exactly what the Runtime puts in a managed PTY's environment at launch.
    const credentials = rig.host.runtime.credentials.issue(parent.value.run.id as never);
    const asAgent = await runCli(agentCli, rig.root, rig.host.port, [
      'spawn', '--role', 'env-child', '--name', 'Env Child', '--cwd', rig.root,
    ], credentials);
    assert.equal(asAgent.json?.ok, true, `agent spawn failed: ${JSON.stringify(asAgent.json)}`);
    const view = asAgent.json?.value as unknown as {
      family: { parentAgentId?: string }; launch: { surface: string };
    };
    assert.equal(view.family.parentAgentId, parent.value.agent.agentId,
      'the parent came from the credential, and nothing in argv said so');
    assert.equal(view.launch.surface, 'agent');

    // A wrong token from the same CLI is not a weaker identity; it is no
    // connection at all.
    const forged = await runCli(agentCli, rig.root, rig.host.port, [
      'spawn', '--role', 'env-child', '--name', 'Forged', '--cwd', rig.root,
    ], { ...credentials, NVK_AGENT_RUN_TOKEN: 'not-the-issued-token' });
    assert.equal(forged.json?.ok, false);
    assert.equal(forged.json?.error?.code, 'RuntimeUnavailable',
      'a forged credential must fail to connect, not spawn as the human');
  } finally {
    await rig.close();
  }
});
