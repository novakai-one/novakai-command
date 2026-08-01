#!/usr/bin/env -S npx tsx
// B3b's public proof, as an OUTSIDE harness (§25 B3b, §24.4).
//
//   A governed Claude Manager — real two-turn skills gate — spawns a governed
//   Codex Builder, which spawns a governed Kimi Auditor. Forbidden role and
//   provider overrides fail WITHOUT spawning. Restart-fresh keeps the Agent and
//   its family and mints a new Run. The tree stops with a confirmation.
//
// What makes it a proof rather than a demo: after the Runtime is started, this
// file touches NOTHING but the published surface. It speaks the nvk-ws v1 frame
// with the platform's own WebSocket, reads the connection token off disk the way
// the shipped CLIs do, and takes each generation's credential from the RUN'S OWN
// TERMINAL — never from a Runtime object. It imports no Novakai module except
// the host it is booting, because somebody has to boot one.
//
//   node scripts/automation-examples/b3b-three-generations.mjs         # scripted providers
//   node scripts/automation-examples/b3b-three-generations.mjs --live  # the real CLIs
//
// `--live` launches real claude/codex/kimi PTYs and lets THEM answer the gate.
// That is the proof Chris wants and it costs real tokens, so it is opt-in.
// Without it, a scripted stand-in confirms from the launch plan it was given —
// the same place a real model's skills come from, never the prompt.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const live = process.argv.includes('--live');

// The one import: the runtime this harness is about to treat as a stranger.
const { startRuntimeHost } = await import(
  path.join(repoRoot, 'packages/server/core/b3/host.ts')
);
const { createFakeProviderAdapters } = await import(
  path.join(repoRoot, 'packages/agents/b3/contract/index.ts')
);

let failures = 0;
const steps = [];

function check(name, passed, detail = '') {
  steps.push({ name, passed, detail });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `\n      ${detail}`}\n`);
}

// ── A published-frame client, written from the spec rather than imported ─────

/** §16.1: `{id, method, params:{contractVersion, clientOpId, payload}, v:1}`. */
function openSocket(port, token, identity = {}) {
  const query = identity.agentRunId === undefined
    ? ''
    : `&agentRunId=${encodeURIComponent(identity.agentRunId)}`
      + `&runToken=${encodeURIComponent(identity.runToken)}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}${query}`);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'event') { events.push(frame); return; }
    const settle = pending.get(frame.id);
    if (settle) { pending.delete(frame.id); settle(frame); }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
    events,
    async call(method, payload) {
      const id = nextId;
      nextId += 1;
      const frame = await new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({
          id, method, v: 1,
          params: { contractVersion: 1, clientOpId: clientOpId(), payload },
        }));
      });
      if (frame.error !== undefined) {
        return { ok: false, error: { code: 'TransportError', message: String(frame.error) } };
      }
      return frame.result;
    },
    close() { socket.close(); },
  };
}

/** §4.1 `op_<uuidv4>`. The harness mints its own; nothing hands it one. */
const clientOpId = () => `op_${crypto.randomUUID()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A governed role: a REAL two-turn gate over real pinned skills (§6.3). */
function governedRole(name, allowedChildRoleIds, provider) {
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
    skillRefs: [
      { id: 'elite-codebase-engineering', version: 3, digest: 'a1b2c3d4' },
      { id: 'test-driven-development', version: 2, digest: 'e5f6a7b8' },
    ],
    hookRefs: [],
    instructionRefs: [],
    skillsConfirmationGate: {
      mode: 'required-two-turn',
      confirmationMarker: 'SKILLS-CONFIRMED:',
      confirmationTokenFormat: 'skill-id@v<version>#<digest>',
      comparison: 'exact-set-canonical-order',
      subagentEvidenceMarker: 'SUBAGENT-SKILLS:',
      providerNativeSubagentPolicy: 'managed-only-for-supervised-work',
      onFailure: 'terminate-run-and-record-drift',
    },
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

const supervised = (roleProfileId, displayName, brief) => ({
  roleProfileId,
  displayName,
  workingDirectory: repoRoot,
  task: { kind: 'supervised', brief },
});

/** Everything this Run's terminal has printed, through the published read. */
async function terminalText(client, terminalSessionId) {
  const frames = await client.call('b3.terminal.read', { terminalSessionId });
  if (!frames.ok) return '';
  return frames.value
    .filter((frame) => frame.kind === 'bytes')
    .map((frame) => Buffer.from(frame.base64, 'base64').toString('utf8'))
    .join('');
}

/**
 * How a stranger becomes an Agent: the Runtime puts the Run credential in the
 * managed PTY's environment, and this harness reads what that PTY printed. No
 * Runtime object is consulted — the same route a real agent takes when it uses
 * the credential it was handed.
 */
async function credentialOf(client, view) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await terminalText(client, view.run.terminalSessionId);
    const found = /NVK-RUN-CREDENTIAL: (\S+) (\S+)/.exec(text);
    if (found) return { agentRunId: found[1], runToken: found[2] };
    await sleep(100);
  }
  return null;
}

const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-proof-'));
let host;
const clients = [];
try {
  host = await startRuntimeHost({
    root,
    port: 0,
    hostVersion: 'b3b-proof',
    // A scripted stand-in confirms from the plan it is launched with. `--live`
    // hands the gate to the real binaries, which is the same code path.
    ...(live ? {} : { providers: createFakeProviderAdapters({ all: { confirmSkillsFromPlan: true } }) }),
    gateTimeoutMs: live ? 180_000 : 20_000,
  });
  process.stdout.write(
    `runtime on ${host.httpUrl} · providers: ${live ? 'REAL claude/codex/kimi' : 'scripted'}\n`
    + 'gate: required-two-turn (ENABLED)\n\n',
  );

  // The token the shipped CLIs read. Nothing is passed in from the host object.
  const token = readFileSync(path.join(root, 'server', 'ws-token'), 'utf8').trim();
  const chris = openSocket(host.port, token);
  clients.push(chris);
  await chris.ready;

  // ── Roles: auditor ← builder ← manager, every one of them governed ────────
  const auditorRole = await chris.call('b3.agent.createRole', governedRole('auditor', [], 'kimi'));
  check('a governed role profile is created through the public method', auditorRole.ok,
    auditorRole.ok ? auditorRole.value.id : auditorRole.error.message);
  if (!auditorRole.ok) throw new Error('cannot continue without roles');

  const builderRole = await chris.call('b3.agent.createRole',
    governedRole('builder', [auditorRole.value.id], 'codex'));
  const managerRole = await chris.call('b3.agent.createRole',
    governedRole('manager', [builderRole.ok ? builderRole.value.id : ''], 'claude'));
  check('three governed roles form a permitted spawn chain', builderRole.ok && managerRole.ok);
  if (!builderRole.ok || !managerRole.ok) throw new Error('cannot continue without roles');

  // ── Generation 1: Chris spawns the Claude Manager, through the gate ───────
  const manager = await chris.call('b3.agent.spawn',
    supervised(managerRole.value.id, 'Manager', 'Say the word BANANA once, then stop.'));
  check('generation 1 — a GOVERNED claude Manager reaches ready through the gate',
    manager.ok && manager.value.run.lifecycle === 'ready',
    manager.ok ? `${manager.value.run.id} (${manager.value.provider.provider})`
      : `${manager.error.code}: ${manager.error.message}`);
  if (!manager.ok) throw new Error('generation 1 failed');
  check('the Manager records the surface it was started from',
    manager.value.launch.surface === 'novakai-shell',
    `surface = ${manager.value.launch.surface}`);

  // The gate is not a claim: turn 1 was held, and the work turn was released
  // exactly once, by a confirmation this harness did not type.
  const managerText = await terminalText(chris, manager.value.run.terminalSessionId);
  check('turn 1 held the work back until the skills were confirmed',
    managerText.includes('do NOT begin it yet') && managerText.includes('SKILLS-CONFIRMED:'),
    managerText.includes('SKILLS-CONFIRMED:') ? '' : 'no confirmation appeared in the transcript');
  // Counted from the EVENTS, not the transcript: a PTY echoes, so the work
  // turn appears in the terminal once per echo and counting text would be
  // counting the tty rather than the Runtime.
  const gateEvents = await chris.call('b3.agent.subscribeEvents', { limit: 500 });
  const passed = gateEvents.ok
    ? gateEvents.value.events.filter((event) => event.kind === 'agent.run.skills-gate.passed'
      && event.payload.agentRunId === manager.value.run.id)
    : [];
  check('the gate passed exactly once for this Run', passed.length === 1,
    `${passed.length} confirmation(s)`);

  // The published read of what the gate demanded, for a consumer that did not
  // author the role (§12.1 `getLaunchPlan`).
  const plan = await chris.call('b3.agent.getLaunchPlan', { agentRunId: manager.value.run.id });
  const pinned = plan.ok
    ? plan.value.skills.map((skill) => `${skill.id}@v${skill.version}#${skill.digest}`).sort()
    : [];
  check('an outside consumer can read the skills the Run is pinned to',
    plan.ok && pinned.length === 2 && pinned.every((token) => managerText.includes(token)),
    pinned.join(' '));

  // ── The forbidden override, BEFORE anything else ──────────────────────────
  const forbidden = await chris.call('b3.agent.spawn', {
    ...supervised(managerRole.value.id, 'Impostor', 'never runs'),
    requestedProvider: 'kimi',
  });
  check('a forbidden provider override fails', !forbidden.ok,
    forbidden.ok ? 'it was allowed' : `${forbidden.error.code}: ${forbidden.error.message}`);
  const runsAfterRefusal = await chris.call('b3.agent.listRuns', { includeFinal: true, limit: 50 });
  check('the forbidden override spawned NOTHING',
    runsAfterRefusal.ok && runsAfterRefusal.value.items.length === 1,
    `runs = ${runsAfterRefusal.ok ? runsAfterRefusal.value.items.length : '?'}`);

  // ── Generation 2: the Manager spawns the Builder, as ITSELF ───────────────
  const managerCredential = await credentialOf(chris, manager.value);
  check('the Manager\'s own credential is observable from its terminal, not from the Runtime',
    managerCredential !== null,
    managerCredential === null ? 'no credential reached the managed PTY' : '');
  if (managerCredential === null) throw new Error('generation 2 needs the Manager credential');

  const asManager = openSocket(host.port, token, managerCredential);
  clients.push(asManager);
  await asManager.ready;
  const builder = await asManager.call('b3.agent.spawn',
    supervised(builderRole.value.id, 'Builder', 'Say the word CHERRY once, then stop.'));
  check('generation 2 — the Manager spawns a GOVERNED codex Builder as itself',
    builder.ok && builder.value.run.lifecycle === 'ready',
    builder.ok ? `${builder.value.run.id} (${builder.value.provider.provider})`
      : `${builder.error.code}: ${builder.error.message}`);
  if (!builder.ok) throw new Error('generation 2 failed');
  check('the Builder\'s parent is the Manager, from the CONNECTION not the payload',
    builder.value.family.parentAgentId === manager.value.agent.agentId);
  check('the Builder records the agent launch surface',
    builder.value.launch.surface === 'agent', `surface = ${builder.value.launch.surface}`);

  const overreach = await asManager.call('b3.agent.spawn',
    supervised(auditorRole.value.id, 'Overreach', 'never runs'));
  check('the Manager cannot spawn a role its own role forbids', !overreach.ok,
    overreach.ok ? 'it was allowed' : `${overreach.error.code}`);

  // ── Generation 3: the Builder spawns the Kimi Auditor ─────────────────────
  const builderCredential = await credentialOf(chris, builder.value);
  if (builderCredential === null) throw new Error('generation 3 needs the Builder credential');
  const asBuilder = openSocket(host.port, token, builderCredential);
  clients.push(asBuilder);
  await asBuilder.ready;
  const auditor = await asBuilder.call('b3.agent.spawn',
    supervised(auditorRole.value.id, 'Auditor', 'Say the word DAMSON once, then stop.'));
  check('generation 3 — the Builder spawns a GOVERNED kimi Auditor',
    auditor.ok && auditor.value.run.lifecycle === 'ready',
    auditor.ok ? `${auditor.value.run.id} (${auditor.value.provider.provider})`
      : `${auditor.error.code}: ${auditor.error.message}`);
  if (!auditor.ok) throw new Error('generation 3 failed');

  const providers = [
    manager.value.provider.provider,
    builder.value.provider.provider,
    auditor.value.provider.provider,
  ];
  check('three generations, three DIFFERENT providers',
    new Set(providers).size === 3, providers.join(' → '));

  // ── Proof that these are real processes, not three PASS lines ─────────────
  for (const [label, run] of [
    ['Manager', manager.value], ['Builder', builder.value], ['Auditor', auditor.value],
  ]) {
    const text = await terminalText(chris, run.run.terminalSessionId);
    check(`${label}'s ${run.provider.provider} PTY produced real output`,
      text.length > 0,
      text.length === 0
        ? 'the terminal produced nothing — nothing was launched'
        : `${String(text.length)} bytes`);
  }

  // ── The published tree, read the way §12.7 publishes it ───────────────────
  const tree = await chris.call('b3.agent.getTree', {
    rootAgentId: manager.value.agent.agentId, direction: 'descendants', maxDepth: 8,
  });
  check('the whole family is queryable from the root',
    tree.ok && tree.value.nodes.length === 3,
    tree.ok ? tree.value.nodes.map((node) => node.agent.displayName).join(' / ') : '');
  check('the tree carries the edges and depths the contract publishes',
    tree.ok && tree.value.edges.length === 2
      && tree.value.nodes.every((node) => typeof node.depth === 'number'),
    tree.ok ? `${tree.value.edges.length} edge(s)` : '');
  const ancestors = await chris.call('b3.agent.getTree', {
    rootAgentId: auditor.value.agent.agentId, direction: 'ancestors', maxDepth: 8,
  });
  check('direction is honoured: the Auditor\'s ancestors are its family, upward',
    ancestors.ok && ancestors.value.nodes.length === 3
      && ancestors.value.nodes.some((node) => node.agent.displayName === 'Manager'),
    ancestors.ok ? ancestors.value.nodes.map((node) => node.agent.displayName).join(' / ') : '');

  // ── The event stream, from a cursor, as a second host would follow it ─────
  const stream = await chris.call('b3.agent.subscribeEvents', { limit: 500 });
  check('a second host can read the event stream this family produced',
    stream.ok && stream.value.events.some((event) => event.kind === 'agent.run.skills-gate.passed'),
    stream.ok ? `${stream.value.events.length} event(s)` : '');
  check('live events reached a connected consumer as v1 frames',
    chris.events.some((frame) => frame.name === 'b3.agent.event'),
    `${chris.events.length} frame(s)`);

  // ── The grants that made generations 2 and 3 possible ─────────────────────
  const grants = await chris.call('b3.agent.listGrants', {});
  check('the delegation grants behind the family are readable',
    grants.ok && grants.value.length >= 2,
    grants.ok ? `${grants.value.length} active grant(s)` : '');

  // ── Restart-fresh: same Agent, same family, NEW Run ───────────────────────
  const restarted = await chris.call('b3.agent.continue', {
    agentId: builder.value.agent.agentId,
    expectedOldRunId: builder.value.run.id,
    mode: 'fresh',
    configurationMode: 'inherit-plan',
  });
  check('restart-fresh produces a new Run', restarted.ok,
    restarted.ok ? `${builder.value.run.id} → ${restarted.value.run.id}`
      : `${restarted.error.code}: ${restarted.error.message}`);
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
      stopped.ok
        ? stopped.value.perAgentOutcomes
          .map((item) => `${item.agentId.slice(0, 12)}=${item.outcome}`).join(' ')
        : `${stopped.error.code}: ${stopped.error.message}`);
    const fence = await chris.call('b3.agent.getTreeFence', {
      agentId: manager.value.agent.agentId,
    });
    check('a completed stop leaves no fence behind',
      fence.ok && fence.value === null,
      fence.ok ? String(fence.value) : fence.error.code);
  }
} catch (cause) {
  check('the harness ran to completion', false, String(cause));
} finally {
  for (const client of clients) client.close();
  await host?.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${steps.length - failures}/${steps.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
