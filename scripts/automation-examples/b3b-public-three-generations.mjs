#!/usr/bin/env node
// B3b's second-host proof (§24.4, §25-B3b). THE public one.
//
//   A governed Claude Manager — real two-turn skills gate, real binary — spawns
//   a governed Codex Builder, which spawns a governed Kimi Auditor. Forbidden
//   role and provider overrides fail WITHOUT spawning. Restart-fresh keeps the
//   Agent and its family and mints a new Run. The tree stops with a
//   confirmation the caller had to be shown first.
//
// What makes it a SECOND HOST and not a demo: this file imports nothing from
// Novakai. Not the runtime host, not a provider factory, not a contract type.
// It starts the Runtime the way an operator does — `nvk runtime ensure --start`
// as a subprocess — reads the connection token off disk the way the shipped
// CLIs do, and speaks the nvk-ws v1 frame with the platform's own WebSocket,
// written from §16.1 rather than borrowed from the implementation. Each
// generation's credential is taken from that RUN'S OWN TERMINAL, which is the
// route a real agent takes when it uses the credential it was handed.
//
//   node scripts/automation-examples/b3b-public-three-generations.mjs
//
// There is no scripted mode and no `--live` flag. The previous harness took
// `--live` as an option and defaulted to a fake whose shell script printed the
// right answer straight out of the launch plan, so the thing it proved by
// default was that a fake can pass a gate (NVK-KIMI-031 finding 4). This runs
// the real claude, codex and kimi binaries, every time, and costs real tokens.
// The in-process harness is still here as a dev tool — see
// `b3b-three-generations-inprocess.mjs` — and is not a second-host proof.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

let failures = 0;
const steps = [];

function check(name, passed, detail = '') {
  steps.push({ name, passed, detail });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `\n      ${detail}`}\n`);
}

// ── The published CLI, as a stranger runs it ────────────────────────────────

const cliSurfaces = new Set();

/** `nvk <group> <verb> …` in a subprocess. No module of ours is loaded here. */
function nvkRun(root, port, args) {
  cliSurfaces.add(args.slice(0, 2).join(' '));
  return spawnSync(process.execPath, [nvk, ...args, '--root', root, '--port', String(port)], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, NOVAKAI_ROOT: root, NOVAKAI_RUNTIME_PORT: String(port) },
  });
}

// ── A published-frame client, written from §16.1 rather than imported ───────

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

/** A port nobody is on, so a running dev Runtime is never disturbed. */
async function freePort() {
  const server = createServer();
  await new Promise((ready) => { server.listen(0, '127.0.0.1', ready); });
  const { port: free } = server.address();
  await new Promise((closed) => { server.close(closed); });
  return free;
}

/** A governed role: a REAL two-turn gate over real pinned skills (§6.3). */
function governedRole(name, allowedChildRoleIds, provider) {
  return {
    name,
    description: `${name} for the public three-generation proof`,
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

/**
 * The repo root, deliberately, and not a scratch directory.
 *
 * `codex` refuses to start in a directory it has not been trusted in — it
 * prints "Do you trust the contents of this directory?" and quits — so a fresh
 * mkdtemp working directory makes generation 2 impossible for reasons that have
 * nothing to do with Novakai. The briefs below say one word and stop; the
 * DATA root is still a scratch directory, which is the part that matters.
 */
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
 * How a stranger becomes an Agent.
 *
 * The Runtime puts the Run credential in the managed PTY's environment. A real
 * agent reads it out of its own environment and uses it; this harness is
 * outside that process, so it reads the same environment the way any process of
 * the same user can — `ps eww`. That is not a back door around the contract, it
 * IS the contract's trust boundary: the same-user process table is where a Run
 * token lives, and NVK-KIMI-030 obtained a real parent's credential exactly this
 * way to drive the authority probe.
 *
 * What matters for a second-host proof is what is NOT consulted: no Runtime
 * object, no store file, no private module. The Run id came off the published
 * socket; the token comes off the operating system.
 */
function credentialOf(view) {
  const runId = view.run.id;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listed = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
    for (const line of (listed.stdout ?? '').split('\n')) {
      const pid = line.trim().split(/\s+/u)[0];
      if (!/^\d+$/u.test(pid ?? '')) continue;
      if (!/bin\/(claude|codex|kimi)\b/u.test(line)) continue;
      const env = spawnSync('ps', ['eww', '-p', pid], { encoding: 'utf8' }).stdout ?? '';
      if (!env.includes(`NVK_AGENT_RUN_ID=${runId}`)) continue;
      const token = /NVK_AGENT_RUN_TOKEN=(\S+)/u.exec(env);
      if (token) return { agentRunId: runId, runToken: token[1] };
    }
    // Synchronous on purpose: nothing else is in flight, and a busy wait here
    // keeps the credential read a plain OS question with no scheduling in it.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  }
  return null;
}

const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-public-'));
const port = await freePort();
const clients = [];
let started = false;
try {
  // ── Boot, through the operator's own door ────────────────────────────────
  const ensure = nvkRun(root, port, ['runtime', 'ensure', '--start']);
  check('the Runtime starts from the published CLI, with no import of it',
    ensure.status === 0, (ensure.stdout || ensure.stderr).trim().split('\n')[0] ?? '');
  if (ensure.status !== 0) throw new Error('the runtime never started');
  started = true;

  process.stdout.write(
    `runtime on 127.0.0.1:${port} · providers: REAL claude/codex/kimi\n`
    + 'gate: required-two-turn (ENABLED)\n\n',
  );

  // The token the shipped CLIs read. Nothing is passed in from a host object.
  const token = readFileSync(path.join(root, 'server', 'ws-token'), 'utf8').trim();
  const chris = openSocket(port, token);
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

  const rolesFromCli = nvkRun(root, port, ['agent', 'roles', '--json']);
  check('the same roles are visible through the shipped CLI',
    rolesFromCli.status === 0 && rolesFromCli.stdout.includes('manager'),
    rolesFromCli.status === 0 ? '' : rolesFromCli.stderr.trim());

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

  const plan = await chris.call('b3.agent.getLaunchPlan', { agentRunId: manager.value.run.id });
  const pinned = plan.ok
    ? plan.value.skills.map((skill) => `${skill.id}@v${skill.version}#${skill.digest}`).sort()
    : [];
  check('an outside consumer can read the skills the Run is pinned to',
    plan.ok && pinned.length === 2 && pinned.every((token2) => managerText.includes(token2)),
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
  const managerCredential = credentialOf(manager.value);
  check('the Manager\'s own credential is observable from its terminal, not from the Runtime',
    managerCredential !== null,
    managerCredential === null ? 'no credential reached the managed PTY' : '');
  if (managerCredential === null) throw new Error('generation 2 needs the Manager credential');

  const asManager = openSocket(port, token, managerCredential);
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
  const builderCredential = credentialOf(builder.value);
  if (builderCredential === null) throw new Error('generation 3 needs the Builder credential');
  const asBuilder = openSocket(port, token, builderCredential);
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
    // "Non-empty" was the old bar, and a shell that printed one word cleared it.
    // A real provider TUI paints kilobytes before it has said anything.
    check(`${label}'s ${run.provider.provider} PTY is a real provider session`,
      text.length > 1_000 && text.includes('SKILLS-CONFIRMED:'),
      `${String(text.length)} bytes${text.includes('SKILLS-CONFIRMED:') ? '' : ', no confirmation'}`);
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
  const treeFromCli = nvkRun(root, port, ['agent', 'tree', manager.value.agent.agentId, '--json']);
  check('the same family is readable through the shipped CLI',
    treeFromCli.status === 0 && treeFromCli.stdout.includes('Auditor'),
    treeFromCli.status === 0 ? '' : treeFromCli.stderr.trim());

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
  check('restart-fresh produces a new Run, through the gate again', restarted.ok,
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

  check('this harness imported nothing from Novakai',
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => /^import .* from '/u.test(line))
      .every((line) => /from 'node:/u.test(line)),
    'every import is a node: builtin');
} catch (cause) {
  check('the harness ran to completion', false, String(cause));
} finally {
  for (const client of clients) client.close();
  if (started) {
    const stop = nvkRun(root, port, ['runtime', 'stop', '--live-runs', 'stop-explicitly']);
    process.stdout.write(`\nruntime stop: ${(stop.stdout || stop.stderr).trim().split('\n')[0] ?? ''}\n`);
  }
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\nCLI surfaces driven: ${[...cliSurfaces].join(', ')}\n`);
process.stdout.write(`${steps.length - failures}/${steps.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
