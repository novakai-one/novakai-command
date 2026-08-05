// B3e TRACER BULLET — one Run, two hosts, one truth (FZ-VIEW-034).
//
// The freeze's cross-lane consistency law says Shell and CLI must render plain,
// non-contradictory status for the same Run. B3d's SEVERE-2 was two consumers
// quietly disagreeing about the same record, so this suite refuses to accept
// "both look right" — it demands the two hosts hand back the SAME BYTES for the
// same Run out of the same frozen projection (FZ-CLI-011 · FZ-VIEW-001/002).
//
// Nothing is stubbed at the seam: a real Runtime host, a real spawned Run, the
// real `nvk-agent` executable in a real child process, and the real Shell read
// door over the real nvk-ws v1 frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { agentRunViewDrift, createShellAgentServices } from '../../shell/app/agentRuns.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const agentCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-agent.ts');

interface CliOutcome {
  readonly code: number | null;
  readonly json: {
    schemaVersion?: number; ok: boolean; command?: string;
    value?: unknown; error?: { code: string; message: string };
  } | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(root: string, port: number, args: readonly string[]): Promise<CliOutcome> {
  const child = spawn(
    process.execPath,
    [tsx, agentCli, ...args, '--json', '--root', root, '--port', String(port)],
    { cwd: repoRoot, env: { ...process.env } },
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

/**
 * THE ONE FIELD THAT MAY DIFFER, AND WHY.
 *
 * `usage.observedAt` answers "when was this projection computed", not "what is
 * true of this Run": `packages/supervision/core/usage/projection.ts:113` falls
 * back to the clock when a Run carries no provider usage evidence yet. Two
 * hosts reading the same Run a few milliseconds apart therefore MUST differ
 * there, and that difference is not a disagreement.
 *
 * It is normalised here rather than spot-skipped in each assertion so the
 * exemption is one named line that a reviewer can see — and the test below
 * proves it is the ONLY field that ever needs it.
 */
const READ_STAMP = '<read-stamp>';

function normalise(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, member: unknown) =>
    (key === 'observedAt' ? READ_STAMP : member)) as unknown;
}

function tracerRole(name: string): Record<string, unknown> {
  return {
    name,
    description: `${name} for the B3e tracer`,
    status: 'active',
    providerPolicy: { allowed: ['claude'], defaultProvider: 'claude' },
    modelPolicy: {
      allowedModelIds: ['tracer-default'], defaultModelId: 'tracer-default',
      allowNativeChange: false, allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
    skillRefs: [], hookRefs: [], instructionRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
    spawnPolicy: { allowedChildRoleIds: [], requireManagedSpawn: true },
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
  // A throwaway root per rig: E-01 says a reused data root refuses its second
  // boot, so the tracer never reuses one.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-tracer-'));
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

/** Spawn one real governed Run and return its ids. */
async function spawnTracerRun(rig: Rig, displayName: string): Promise<{
  readonly agentId: string; readonly agentRunId: string;
}> {
  const role = await rig.chris.call<{ id: string }>(
    'b3.agent.createRole', tracerRole(`tracer-${displayName.toLowerCase()}`),
  );
  assert.equal(role.ok, true, 'the tracer role must be definable');
  if (!role.ok) throw new Error('unreachable');
  const spawned = await runCli(rig.root, rig.host.port, [
    'spawn', '--role', `tracer-${displayName.toLowerCase()}`, '--name', displayName,
    '--cwd', rig.root,
  ]);
  assert.equal(spawned.json?.ok, true, `spawn failed: ${JSON.stringify(spawned.json)}`);
  const view = spawned.json?.value as { agent: { agentId: string }; run: { id: string } };
  return { agentId: view.agent.agentId, agentRunId: view.run.id };
}

/**
 * THE TRACER. The CLI's `--json` value and the Shell's view-model row are the
 * same bytes for the same Run, or the freeze cannot carry truth end to end.
 *
 * Byte-comparable, not field-spot-checked: a spot check is exactly what lets a
 * host quietly rename `run.id` to `agentRunId` and drop `launch` — the drift
 * that was live in `serverClient.ts` when this seat opened.
 */
test('the CLI and the Shell hand back the SAME BYTES for the same Run', async () => {
  const rig = await createRig();
  try {
    const { agentRunId } = await spawnTracerRun(rig, 'Tracer');

    const cli = await runCli(rig.root, rig.host.port, ['list', '--state', 'all']);
    assert.equal(cli.json?.ok, true, `list failed: ${JSON.stringify(cli.json)}`);
    assert.equal(cli.code, 0, 'a successful list exits 0');
    assert.equal(cli.json?.schemaVersion, 1, 'FZ-CLI-SCHEMA-001 envelope');

    // The Shell reads through its OWN door (FZ-VIEW-001), over the same wire.
    const shell = createShellAgentServices({
      call: (method, payload) => rig.chris.call(method, payload),
    });
    const page = await shell.runs.listAgentRuns({ state: 'all' });
    assert.equal(page.ok, true, `shell door failed: ${JSON.stringify(page)}`);
    if (!page.ok) return;

    type Row = { run: { id: string }; usage: { observedAt: string } };
    const cliPage = cli.json?.value as { items: readonly Row[] };
    const fromCli = cliPage.items.find((item) => item.run.id === agentRunId);
    const fromShell = page.value.items.find((item) => item.run.id === agentRunId);
    assert.ok(fromCli, 'the CLI must see the Run it just spawned');
    assert.ok(fromShell, 'the Shell must see the same Run');

    assert.equal(
      JSON.stringify(normalise(fromShell)), JSON.stringify(normalise(fromCli)),
      'Shell and CLI must render the SAME Run from the SAME projection, byte for byte',
    );

    // The exemption may never widen. Blanking that ONE field — surgically, not
    // through the recursive normaliser — has to be enough on its own; if any
    // other field ever drifts, this fails instead of hiding inside a skip list.
    assert.equal(
      JSON.stringify({ ...fromShell, usage: { ...fromShell.usage, observedAt: READ_STAMP } }),
      JSON.stringify({ ...fromCli, usage: { ...fromCli.usage, observedAt: READ_STAMP } }),
      'blanking usage.observedAt ALONE must make the two views identical',
    );
  } finally {
    await rig.close();
  }
});

/**
 * The whole page, not just one row: ordering, `omissions` and `nextCursor` are
 * part of the frozen projection (FZ-CLI-SCHEMA-010). A host that re-sorted or
 * recomputed omissions would still pass a per-row check.
 */
test('the whole Page is the same bytes, including omissions and order', async () => {
  const rig = await createRig();
  try {
    await spawnTracerRun(rig, 'First');
    await spawnTracerRun(rig, 'Second');

    const cli = await runCli(rig.root, rig.host.port, ['list', '--state', 'all']);
    assert.equal(cli.json?.ok, true, `list failed: ${JSON.stringify(cli.json)}`);

    const shell = createShellAgentServices({
      call: (method, payload) => rig.chris.call(method, payload),
    });
    const page = await shell.runs.listAgentRuns({ state: 'all' });
    assert.equal(page.ok, true);
    if (!page.ok) return;

    assert.equal(page.value.items.length, 2, 'both Runs are visible');
    assert.equal(
      JSON.stringify(normalise(page.value)), JSON.stringify(normalise(cli.json?.value)),
      'the whole frozen Page must be identical across the two hosts',
    );
  } finally {
    await rig.close();
  }
});

/**
 * `--state` is the one filter FZ-CLI-011 publishes, and OQ-07 is exactly the
 * "two lanes disagree about what live means" risk. Whatever it means, it must
 * mean the SAME thing on both sides.
 */
test('--state means the same thing to both hosts', async () => {
  const rig = await createRig();
  try {
    await spawnTracerRun(rig, 'Live');

    const shell = createShellAgentServices({
      call: (method, payload) => rig.chris.call(method, payload),
    });
    for (const state of ['live', 'final', 'all'] as const) {
      const cli = await runCli(rig.root, rig.host.port, ['list', '--state', state]);
      assert.equal(cli.json?.ok, true, `list --state ${state} failed`);
      const page = await shell.runs.listAgentRuns({ state });
      assert.equal(page.ok, true, `shell --state ${state} failed`);
      if (!page.ok) return;
      assert.equal(
        JSON.stringify(normalise(page.value)), JSON.stringify(normalise(cli.json?.value)),
        `--state ${state} must select the same Runs on both hosts`,
      );
    }
  } finally {
    await rig.close();
  }
});

/**
 * The browser-safe copy is a SECOND place a contract lives, and a copy of a
 * contract rots silently: the capability grows a field, the Shell keeps
 * rendering the six it knows, and nobody finds out until two screens disagree.
 *
 * So the copy is checked against a REAL view from the REAL Runtime, in both
 * directions — a field the projection carries that the Shell has never heard
 * of, and a field the Shell believes in that the projection does not send.
 */
test('the browser-safe copy still matches the real projection', async () => {
  const rig = await createRig();
  try {
    const { agentRunId } = await spawnTracerRun(rig, 'Drift');
    const shell = createShellAgentServices({
      call: (method, payload) => rig.chris.call(method, payload),
    });
    const page = await shell.runs.listAgentRuns({ state: 'all' });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const view = page.value.items.find((item) => item.run.id === agentRunId);
    assert.ok(view, 'the spawned Run must be readable');

    assert.deepEqual(
      agentRunViewDrift(view), [],
      'the frozen projection and the Shell copy must describe the same fields',
    );

    // The guard has to be able to FAIL, or it is decoration. A field the Shell
    // has never heard of is caught...
    assert.deepEqual(
      agentRunViewDrift({ ...view, mood: 'cheerful' }),
      ['<view>.mood is not in the frozen projection'],
    );
    // ...and so is a fact that went missing on the way through.
    const { displayName: _dropped, ...thinAgent } = view.agent;
    assert.deepEqual(
      agentRunViewDrift({ ...view, agent: thinAgent }),
      ['agent.displayName is missing from the projection'],
    );
  } finally {
    await rig.close();
  }
});

/**
 * AMD-005 A5-01. `--limit` bounds the page the CLI ASKS for; it never trims a
 * page the owner already sent, because trimming client-side would make
 * `nextCursor` and `omissions` describe a page that no longer exists.
 */
test('--limit is passed through and bounded 1-200 (A5-01)', async () => {
  const rig = await createRig();
  try {
    await spawnTracerRun(rig, 'One');
    await spawnTracerRun(rig, 'Two');

    const limited = await runCli(rig.root, rig.host.port, ['list', '--state', 'all', '--limit', '1']);
    assert.equal(limited.json?.ok, true, `list --limit failed: ${JSON.stringify(limited.json)}`);
    const page = limited.json?.value as { items: readonly unknown[] };
    assert.equal(page.items.length, 1, '--limit 1 must return one Run, not two');

    for (const bad of ['0', '201', 'many']) {
      const refused = await runCli(rig.root, rig.host.port, ['list', '--limit', bad]);
      assert.equal(refused.json?.ok, false, `--limit ${bad} must be refused`);
      assert.equal(refused.json?.error?.code, 'ValidationFailed');
      assert.equal(refused.code, 2, 'a usage failure exits 2 (FZ-CLI-SCHEMA-004)');
    }
  } finally {
    await rig.close();
  }
});

/** The Shell asks the same way, so a paged Shell and a paged CLI agree. */
test('--limit means the same thing through the Shell door', async () => {
  const rig = await createRig();
  try {
    await spawnTracerRun(rig, 'Alpha');
    await spawnTracerRun(rig, 'Beta');

    const cli = await runCli(rig.root, rig.host.port, ['list', '--state', 'all', '--limit', '1']);
    assert.equal(cli.json?.ok, true);
    const shell = createShellAgentServices({
      call: (method, payload) => rig.chris.call(method, payload),
    });
    const page = await shell.runs.listAgentRuns({ state: 'all', limit: 1 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(
      JSON.stringify(normalise(page.value)), JSON.stringify(normalise(cli.json?.value)),
      'a limited page must be identical on both hosts',
    );
  } finally {
    await rig.close();
  }
});

/**
 * The structural guard that keeps the drift from growing back. The browser
 * client must obtain its Run rows from the door and hand them on untouched;
 * a second mapping in `serverClient.ts` is how F-2 happened the first time.
 */
test('the browser client owns no second Run projection', () => {
  const client = readFileSync(
    path.join(repoRoot, 'packages', 'shell', 'app', 'serverClient.ts'), 'utf8',
  );
  assert.match(
    client, /createShellAgentServices/,
    'the browser client must read Runs through the frozen door',
  );
  // The old reshape, named exactly: `run.id` renamed on its way to the browser.
  assert.doesNotMatch(
    client, /agentRunId:\s*view\.run\.id/,
    'the browser client must not rename fields out of the frozen projection',
  );
});
