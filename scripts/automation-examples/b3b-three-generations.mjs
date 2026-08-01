#!/usr/bin/env -S npx tsx
// B3b's public proof, as an OUTSIDE harness (§18 B3b, §24.4).
//
//   Claude Manager spawns Codex Builder, which spawns Kimi Auditor.
//   Forbidden role/control overrides fail WITHOUT spawning.
//   Restart-fresh preserves the Agent and its family, but creates a new Run.
//
// It uses published contracts only — the nvk-ws v1 socket and the `b3.*`
// methods — and never imports Shell or Server internals. Passing through Shell
// would be a failure of the proof, not a shortcut.
//
//   node scripts/automation-examples/b3b-three-generations.mjs            # fake providers
//   node scripts/automation-examples/b3b-three-generations.mjs --live     # the real CLIs
//
// `--live` launches real claude/codex/kimi PTYs. That is the proof Chris wants
// and it costs real tokens, so it is opt-in rather than what CI runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const live = process.argv.includes('--live');

const { startRuntimeHost } = await import(
  path.join(repoRoot, 'packages/server/core/b3/host.ts')
);
const { connectRuntime } = await import(
  path.join(repoRoot, 'packages/server/core/b3/client.ts')
);
const { createFakeProviderAdapters } = await import(
  path.join(repoRoot, 'packages/agents/b3/contract/index.ts')
);

let failures = 0;
const steps = [];

function check(name, passed, detail = '') {
  steps.push({ name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${name}${detail === '' ? '' : `\n      ${detail}`}\n`);
}

/** A role whose gate is off — a chat launch, the one case §6.3 permits. */
function chatRole(name, allowedChildRoleIds, provider) {
  return {
    name,
    description: `${name} for the three-generation proof`,
    status: 'active',
    providerPolicy: { allowed: [provider], defaultProvider: provider },
    modelPolicy: {
      allowedModelIds: ['cli-default'],
      defaultModelId: 'cli-default',
      allowNativeChange: false,
      allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
    skillRefs: [],
    hookRefs: [],
    instructionRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
    spawnPolicy: { allowedChildRoleIds, requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['fresh', 'resume'],
    },
    supervisionPolicy: { requiredWatcherTemplates: [], parentNotificationMode: 'queue-only' },
    budgetPolicy: { hardStopEnabled: false },
  };
}

const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-proof-'));
let host;
try {
  host = await startRuntimeHost({
    root,
    port: 0,
    hostVersion: 'b3b-proof',
    ...(live ? {} : { providers: createFakeProviderAdapters() }),
  });
  process.stdout.write(
    `runtime on ${host.httpUrl} · providers: ${live ? 'REAL claude/codex/kimi' : 'fake'}\n\n`,
  );

  const chris = await connectRuntime({ root, port: host.port });

  // ── Roles: auditor ← builder ← manager ────────────────────────────────────
  const auditorRole = await chris.call('b3.agent.createRole', chatRole('auditor', [], 'kimi'));
  check('a role profile is created through the public method', auditorRole.ok,
    auditorRole.ok ? auditorRole.value.id : auditorRole.error.message);
  if (!auditorRole.ok) throw new Error('cannot continue without roles');

  const builderRole = await chris.call('b3.agent.createRole',
    chatRole('builder', [auditorRole.value.id], 'codex'));
  const managerRole = await chris.call('b3.agent.createRole',
    chatRole('manager', [builderRole.ok ? builderRole.value.id : ''], 'claude'));
  check('three roles form a permitted spawn chain', builderRole.ok && managerRole.ok);
  if (!builderRole.ok || !managerRole.ok) throw new Error('cannot continue without roles');

  // ── Generation 1: Chris spawns the Claude Manager ─────────────────────────
  const manager = await chris.call('b3.agent.spawn', {
    roleProfileId: managerRole.value.id,
    displayName: 'Manager',
    workingDirectory: repoRoot,
  });
  check('generation 1 — a claude Manager is spawned by the human', manager.ok,
    manager.ok ? `${manager.value.run.id} (${manager.value.provider.provider})`
      : manager.error.message);
  if (!manager.ok) throw new Error('generation 1 failed');
  check('the Manager records the surface it was started from',
    manager.value.launch.surface === 'novakai-shell',
    `surface = ${manager.value.launch.surface}`);

  // ── The forbidden override, BEFORE anything else ──────────────────────────
  const forbidden = await chris.call('b3.agent.spawn', {
    roleProfileId: managerRole.value.id,
    displayName: 'Impostor',
    workingDirectory: repoRoot,
    requestedProvider: 'kimi',
  });
  check('a forbidden provider override fails', !forbidden.ok,
    forbidden.ok ? 'it was allowed' : `${forbidden.error.code}: ${forbidden.error.message}`);
  const runsAfterRefusal = await chris.call('b3.agent.listRuns', { includeFinal: true, limit: 50 });
  check('the forbidden override spawned NOTHING',
    runsAfterRefusal.ok && runsAfterRefusal.value.items.length === 1,
    `runs = ${runsAfterRefusal.ok ? runsAfterRefusal.value.items.length : '?'}`);

  // ── Generation 2: the Manager spawns the Codex Builder, as ITSELF ─────────
  const asManager = await connectRuntime({
    root,
    port: host.port,
    ...host.runtime.credentials.issue(manager.value.run.id).NVK_AGENT_RUN_TOKEN === undefined
      ? {}
      : {
        agentRunId: manager.value.run.id,
        runToken: host.runtime.credentials.issue(manager.value.run.id).NVK_AGENT_RUN_TOKEN,
      },
  });
  const builder = await asManager.call('b3.agent.spawn', {
    roleProfileId: builderRole.value.id,
    displayName: 'Builder',
    workingDirectory: repoRoot,
  });
  check('generation 2 — the Manager spawns a codex Builder as itself', builder.ok,
    builder.ok ? `${builder.value.run.id} (${builder.value.provider.provider})`
      : builder.error.message);
  if (!builder.ok) throw new Error('generation 2 failed');
  check('the Builder\'s parent is the Manager, from the CONNECTION not the payload',
    builder.value.family.parentAgentId === manager.value.agent.agentId);
  check('the Builder records the agent launch surface',
    builder.value.launch.surface === 'agent', `surface = ${builder.value.launch.surface}`);

  // A role the Manager may not spawn, asked for by the Manager itself.
  const overreach = await asManager.call('b3.agent.spawn', {
    roleProfileId: auditorRole.value.id,
    displayName: 'Overreach',
    workingDirectory: repoRoot,
  });
  check('the Manager cannot spawn a role its own role forbids', !overreach.ok,
    overreach.ok ? 'it was allowed' : `${overreach.error.code}`);

  // ── Generation 3: the Builder spawns the Kimi Auditor ─────────────────────
  const asBuilder = await connectRuntime({
    root,
    port: host.port,
    agentRunId: builder.value.run.id,
    runToken: host.runtime.credentials.issue(builder.value.run.id).NVK_AGENT_RUN_TOKEN,
  });
  const auditor = await asBuilder.call('b3.agent.spawn', {
    roleProfileId: auditorRole.value.id,
    displayName: 'Auditor',
    workingDirectory: repoRoot,
  });
  check('generation 3 — the Builder spawns a kimi Auditor', auditor.ok,
    auditor.ok ? `${auditor.value.run.id} (${auditor.value.provider.provider})`
      : auditor.error.message);
  if (!auditor.ok) throw new Error('generation 3 failed');

  const providers = [
    manager.value.provider.provider,
    builder.value.provider.provider,
    auditor.value.provider.provider,
  ];
  check('three generations, three DIFFERENT providers',
    new Set(providers).size === 3, providers.join(' → '));

  const tree = await chris.call('b3.agent.getTree', {
    rootAgentId: manager.value.agent.agentId, maxDepth: 8,
  });
  check('the whole family is queryable from the root',
    tree.ok && tree.value.nodes.length === 3,
    tree.ok ? tree.value.nodes.map((node) => node.agent.displayName).join(' / ') : '');

  // ── Restart-fresh: same Agent, same family, NEW Run ───────────────────────
  const restarted = await chris.call('b3.agent.continue', {
    agentId: builder.value.agent.agentId,
    expectedOldRunId: builder.value.run.id,
    mode: 'fresh',
    configurationMode: 'inherit-plan',
  });
  check('restart-fresh produces a new Run', restarted.ok,
    restarted.ok ? `${builder.value.run.id} → ${restarted.value.run.id}`
      : restarted.error.message);
  if (restarted.ok) {
    check('restart-fresh keeps the same Agent',
      restarted.value.agent.agentId === builder.value.agent.agentId);
    check('restart-fresh keeps the family edge',
      restarted.value.family.parentAgentId === manager.value.agent.agentId);
    check('restart-fresh mints a DIFFERENT Run id',
      restarted.value.run.id !== builder.value.run.id);
    const old = await chris.call('b3.agent.getRun', { agentRunId: builder.value.run.id });
    check('the replaced Run reads as replaced, not as stopped by a human',
      old.ok && old.value.run.finalReason === 'replaced-by-continuation',
      old.ok ? old.value.run.finalReason : '');
    // The grandchild is still there, under a supervisor.
    const grandchild = await chris.call('b3.agent.getRun', { agentRunId: auditor.value.run.id });
    check('the grandchild survived its parent being replaced',
      grandchild.ok && grandchild.value.run.lifecycle === 'ready',
      grandchild.ok ? grandchild.value.run.lifecycle : '');
  }

  // ── Stop the tree, from the outside, with a confirmation ──────────────────
  const prepared = await chris.call('b3.agent.prepareStopTree', {
    rootAgentId: manager.value.agent.agentId,
  });
  check('stopping a tree requires a confirmation over what the caller was shown',
    prepared.ok && typeof prepared.value.confirmationToken === 'string',
    prepared.ok ? `${prepared.value.visibleDescendantCount} descendant(s)` : '');
  if (prepared.ok) {
    const stopped = await chris.call('b3.agent.stopTree', {
      rootAgentId: manager.value.agent.agentId,
      confirmationToken: prepared.value.confirmationToken,
      confirmation: 'stop-tree',
    });
    check('the whole tree stops, with a per-Agent result',
      stopped.ok && stopped.value.perAgentOutcomes.length >= 3,
      stopped.ok ? stopped.value.perAgentOutcomes
        .map((item) => `${item.agentId.slice(0, 12)}=${item.outcome}`).join(' ') : '');
  }

  asBuilder.close();
  asManager.close();
  chris.close();
} catch (cause) {
  check('the harness ran to completion', false, String(cause));
} finally {
  await host?.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${steps.length - failures}/${steps.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
