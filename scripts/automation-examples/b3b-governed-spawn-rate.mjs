#!/usr/bin/env node
// How often does a governed spawn actually reach `ready`? (§25-B3b.)
//
// NOT part of any suite — it drives the real claude binary and spends real
// tokens. It exists because "the gate is fixed" is a rate, not a boolean, and
// NVK-KIMI-030 measured the previous rate at 4 of 13 spawns and 0 of 3
// continuations. The briefs below are that probe's own sweep, unchanged, because
// the defect it found was decided by the brief's LENGTH — the wrap boundary fell
// on the confirmation marker for three of the four.
//
//   node scripts/automation-examples/b3b-governed-spawn-rate.mjs [repeats]
//
// Zero Novakai imports, same as the public proof: the Runtime is started through
// `nvk runtime ensure --start` and everything else goes over nvk-ws v1.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');
const repeats = Number(process.argv[2] ?? 3);

/** NVK-KIMI-030's sweep. 36 chars passed 4/4; the other three failed 0/9. */
const BRIEFS = [
  'Reply OK.',
  'Say IDEM once, then stop.',
  'Say the word BANANA once, then stop.',
  'Say ZULU once, then stop and do nothing else at all.',
];

const clientOpId = () => `op_${crypto.randomUUID()}`;

async function freePort() {
  const server = createServer();
  await new Promise((ready) => { server.listen(0, '127.0.0.1', ready); });
  const { port } = server.address();
  await new Promise((closed) => { server.close(closed); });
  return port;
}

function openSocket(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'event') return;
    const settle = pending.get(frame.id);
    if (settle) { pending.delete(frame.id); settle(frame); }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
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
      return frame.error === undefined
        ? frame.result
        : { ok: false, error: { code: 'TransportError', message: String(frame.error) } };
    },
    close() { socket.close(); },
  };
}

function governedRole(name) {
  return {
    name,
    description: 'governed spawn rate measurement',
    status: 'active',
    providerPolicy: { allowed: ['claude'], defaultProvider: 'claude' },
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
    spawnPolicy: { allowedChildRoleIds: [], requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['fresh', 'resume'],
    },
    supervisionPolicy: { requiredWatcherTemplates: [], parentNotificationMode: 'queue-only' },
    budgetPolicy: { hardStopEnabled: false },
  };
}

const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-rate-'));
const port = await freePort();
const env = { ...process.env, NOVAKAI_ROOT: root, NOVAKAI_RUNTIME_PORT: String(port) };
const run = (args) => spawnSync(process.execPath, [nvk, ...args, '--root', root, '--port', String(port)],
  { encoding: 'utf8', cwd: repoRoot, env });

const started = run(['runtime', 'ensure', '--start']);
if (started.status !== 0) {
  process.stdout.write(`could not start a Runtime: ${started.stderr || started.stdout}\n`);
  process.exit(1);
}

const results = [];
const continuations = [];
try {
  const token = readFileSync(path.join(root, 'server', 'ws-token'), 'utf8').trim();
  const chris = openSocket(port, token);
  await chris.ready;
  const role = await chris.call('b3.agent.createRole', governedRole('rate'));
  if (!role.ok) throw new Error(`createRole: ${role.error.message}`);

  for (let round = 0; round < repeats; round += 1) {
    for (const brief of BRIEFS) {
      const spawned = await chris.call('b3.agent.spawn', {
        roleProfileId: role.value.id,
        displayName: `Rate${String(results.length + 1)}`,
        workingDirectory: repoRoot,
        task: { kind: 'supervised', brief },
      });
      const ready = spawned.ok && spawned.value.run.lifecycle === 'ready';
      results.push({ brief, ready, why: spawned.ok ? '' : spawned.error.message });
      process.stdout.write(
        `${ready ? 'READY ' : 'FAIL  '} len=${String(brief.length).padStart(3)}  ${brief}`
        + `${ready ? '' : `\n        ${spawned.ok ? '' : spawned.error.message}`}\n`,
      );
      // Every third success is continued, so the 0-of-3 continuation number the
      // re-probe measured is answered with real continuations too.
      if (ready && continuations.length < 3) {
        const continued = await chris.call('b3.agent.continue', {
          agentId: spawned.value.agent.agentId,
          expectedOldRunId: spawned.value.run.id,
          mode: 'fresh',
          configurationMode: 'inherit-plan',
        });
        const alive = continued.ok && continued.value.run.lifecycle === 'ready';
        continuations.push(alive);
        process.stdout.write(
          `        continue --mode fresh: ${alive ? 'READY' : `FAIL ${continued.ok ? '' : continued.error.message}`}\n`,
        );
      }
    }
  }
  chris.close();
} catch (cause) {
  process.stdout.write(`harness error: ${String(cause)}\n`);
} finally {
  run(['runtime', 'stop', '--live-runs', 'stop-explicitly']);
  rmSync(root, { recursive: true, force: true });
}

const ready = results.filter((item) => item.ready).length;
process.stdout.write('\nby brief:\n');
for (const brief of BRIEFS) {
  const mine = results.filter((item) => item.brief === brief);
  process.stdout.write(
    `  ${String(mine.filter((item) => item.ready).length)}/${String(mine.length)}`
    + `  len=${String(brief.length).padStart(3)}  ${brief}\n`,
  );
}
process.stdout.write(
  `\ngoverned spawns reaching ready: ${String(ready)}/${String(results.length)}\n`
  + `governed continuations reaching ready: ${String(continuations.filter(Boolean).length)}`
  + `/${String(continuations.length)}\n`,
);
process.exit(0);
