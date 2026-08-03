// B3d TRACER — one thin LIVE wire through the real composition (§25-B3d).
//
// Not a unit test and not a fake: a real Runtime host, a real governed spawn
// through the published wire, real durable records, and the real `nvk` CLI as
// a separate process. It proves current FLOWS, and deliberately nothing about
// depth — the §9.2 drift algorithm, the usage projection and the delivery
// state machine belong to lanes A, B and C.
//
//   boot → spawn a governed agent → role watchers installed AT SPAWN
//        → an idle deadline ARMS → the Runtime scheduler FIRES it when due
//        → a Notification QUEUES → `nvk watch list` / `nvk watch notifications`
//
// The one thing it asserts about depth is the §25-B3d exit condition every
// lane inherits: none of that starts a model turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId, type B3Result, type ClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePty, type FakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createIdleWatchTemplate } from '../../supervision/public/index.js';
import type { Notification, WatchDeadline, WatchRule } from '../../supervision/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  chatRole, fakeProvidersWithCompletionLimit, governedRole, governedTokens,
} from './governed-role.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * The same idle watcher the product ships, pinned at a window a test can
 * actually outlive. It resolves through the REAL catalogue seam by ref and
 * digest — a shorter window, not a different mechanism.
 */
const IDLE_MS = 1_000;
const FAST_IDLE = createIdleWatchTemplate({ version: 99, idleMs: IDLE_MS });

const opId = (): ClientOpId => mintClientOpId();

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

/** Answer as the provider would, but only for a turn that was actually sent. */
function answerWhenAsked(ptyHost: FakePtyHost, text: string): void {
  const known = new Set<FakePty>();
  const timer = setInterval(() => {
    for (const pty of ptyHost.started) {
      if (known.has(pty)) continue;
      known.add(pty);
      pty.onTurn((turn) => {
        if (turn.includes('do NOT begin it yet')) pty.emit(`${text}\n`);
      });
    }
  }, 5);
  timer.unref();
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly root: string;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-tracer-'));
  const ptyHost = createFakePtyHost({ echoInput: false, composer: true });
  const host = await startRuntimeHost({
    root, port: 0, ptyHost,
    providers: fakeProvidersWithCompletionLimit(1),
    watcherTemplates: [FAST_IDLE],
    gateTimeoutMs: 5_000,
    providerTurnReconciliationIntervalMs: 50,
  });
  answerWhenAsked(ptyHost, `SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}`);
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost, root,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Something ordinary happening elsewhere in the Runtime.
 *
 * The trigger is deliberately NOT the watched Run: a watcher that only wakes
 * when its own subject moves is a watcher that cannot notice silence. This is
 * an unrelated committed event, and it is the entire clock.
 */
async function anUnrelatedRuntimeEvent(rig: Rig): Promise<void> {
  const role = unwrap(await rig.chris.call<{ id: string }>(
    'b3.agent.createRole', chatRole('b3d-tracer-bystander'), opId(),
  ), 'createRole (bystander)');
  const spawned = await rig.chris.call('b3.agent.spawn', {
    roleProfileId: role.id, displayName: 'Bystander', workingDirectory: tmpdir(),
  }, opId());
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
}

/** A supervised Agent, launched exactly the way an operator launches one. */
async function spawnSupervised(
  rig: Rig,
): Promise<{ agentId: string; agentRunId: string; spawnClientOpId: string }> {
  const role = unwrap(await rig.chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole('b3d-tracer-role'),
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: [{ ...FAST_IDLE.templateRef }],
      parentNotificationMode: 'queue-only',
    },
  }, opId()), 'createRole');
  const spawnClientOpId = opId();
  const spawned = unwrap(await rig.chris.call<{
    agent: { agentId: string }; run: { id: string; lifecycle: string };
  }>('b3.agent.spawn', {
    roleProfileId: role.id,
    displayName: 'B3d Tracer',
    workingDirectory: tmpdir(),
    task: { kind: 'supervised', brief: 'Sit still.' },
  }, spawnClientOpId), 'spawn');
  assert.equal(spawned.run.lifecycle, 'ready');
  return { agentId: spawned.agent.agentId, agentRunId: spawned.run.id, spawnClientOpId };
}

/** Wait for an event-driven fact to arrive, rather than assuming it already has. */
async function until<Value>(
  what: string, read: () => Promise<Value | null>, timeoutMs = 4_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resume) => { setTimeout(resume, 25); });
  }
}

function runNvk(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'nvk.mjs'), ...args], {
    cwd: repoRoot,
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    child.on('close', (code) => { resolve({ code, out }); });
  });
}

function deadlineStates(root: string, deadlineId: string): readonly string[] {
  const lines = readFileSync(path.join(root, 'stores', 'watchDeadlines.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as {
      readonly envelope: { readonly id: string };
      readonly payload: { readonly state: string };
    });
  const states = lines
    .filter((line) => line.envelope.id === deadlineId)
    .map((line) => line.payload.state);
  return states.filter((state, index) => index === 0 || state !== states[index - 1]);
}

test('the B3d wire carries current from spawn to a queued Notification', async () => {
  const rig = await createRig();
  try {
    const agent = await spawnSupervised(rig);

    // 1. The spawn ladder's watcher rung is OWNED, not deferred. B3c's failure
    //    mode was a stage recorded `not-needed` naming a slice for ever.
    const operations = unwrap(await rig.chris.call<readonly {
      operation: {
        kindOfOperation: string;
        completedStages: readonly {
          stage: string; owner: string; outcome?: string; ownerObjectId?: string;
        }[];
      };
    }[]>('b3.agent.listOperations', {}, opId()), 'listOperations');
    const spawnOperation = operations
      .map((view) => view.operation)
      .find((item) => item.kindOfOperation === 'spawn');
    assert.notEqual(spawnOperation, undefined, 'the spawn wrote no operation journal');
    const watcherStage = spawnOperation?.completedStages.find(
      (stage) => stage.stage === 'watchers-installed',
    );
    assert.notEqual(watcherStage, undefined, 'the spawn never reached the watcher rung');
    assert.equal(watcherStage?.owner, 'supervision');
    assert.notEqual(watcherStage?.outcome, 'not-needed',
      'the watcher rung is still deferred: nothing was installed at spawn');
    assert.notEqual(watcherStage?.ownerObjectId, undefined,
      'the watcher rung completed without naming the rule it installed');

    // 2. The role's pinned watcher exists, aimed at THIS Run, with a deadline
    //    already armed — installed at spawn, not on first use.
    const watchers = await until('the completed work turn to arm its idle deadline', async () => {
      const listed = await rig.chris.call<{
        rules: readonly WatchRule[]; deadlines: readonly WatchDeadline[];
      }>('b3.supervision.listWatchers', {}, opId());
      if (!listed.ok || listed.value.deadlines.length === 0) return null;
      return listed.value;
    }, 12_000);
    assert.equal(watchers.rules.length, 1, 'the role pinned one watcher and got none');
    assert.deepEqual(watchers.rules[0]?.subject, {
      kind: 'agent-run', agentRunId: agent.agentRunId,
    });
    assert.equal(watchers.deadlines.length, 1);
    assert.equal(
      deadlineStates(rig.root, watchers.deadlines[0]!.id)[0],
      'armed',
      'the installed watcher never persisted its initial armed state',
    );
    assert.equal(watchers.deadlines[0]?.watchRuleId, watchers.rules[0]?.id);
    assert.equal(watchers.rules[0]?.installation?.requestClientOpId, agent.spawnClientOpId,
      'watcher provenance was detached from the initiating spawn command');
    assert.equal(watchers.rules[0]?.installation?.requestedBy, 'person_chris');

    // 3. Let the idle window pass without manufacturing activity. A silent Run
    //    must still wake the durable scheduler; requiring another event here
    //    would make a truly idle Runtime impossible to supervise.
    const turnsBeforeFiring = rig.ptyHost.started[0]?.turns.length ?? 0;
    assert.equal(turnsBeforeFiring, 2,
      'a governed launch is exactly two submitted turns: the question and the work');
    // 4. The deadline fires and queues one Notification, durably.
    const queued = await until('the queued Notification', async () => {
      const page = await rig.chris.call<{ items: readonly Notification[] }>(
        'b3.supervision.listNotifications', { limit: 50 }, opId(),
      );
      if (!page.ok || page.value.items.length === 0) return null;
      return page.value.items[0]!;
    });
    assert.equal(queued.state, 'queued');
    assert.equal(queued.phase, 'condition');
    assert.equal(queued.deliveryAttempt.state, 'queued',
      'a Notification reached delivery before it was durably queued');
    assert.equal(queued.watchRuleId, watchers.rules[0]?.id);

    await new Promise((resume) => { setTimeout(resume, IDLE_MS + 200); });
    const once = unwrap(await rig.chris.call<{ items: readonly Notification[] }>(
      'b3.supervision.listNotifications', { limit: 50 }, opId(),
    ), 'listNotifications after another idle window');
    assert.equal(once.items.length, 1, 'one idle deadline queued more than one Notification');

    const fired = unwrap(await rig.chris.call<{
      deadlines: readonly WatchDeadline[];
    }>('b3.supervision.listWatchers', {}, opId()), 'listWatchers after firing');
    assert.equal(fired.deadlines[0]?.state, 'fired');
    assert.deepEqual(
      deadlineStates(rig.root, fired.deadlines[0]!.id),
      ['armed', 'claimed', 'fired'],
      'the durable scheduler skipped a published deadline state',
    );

    // 5. §25-B3d's binding exit, measured rather than asserted: the watched
    //    Run's PTY received not one turn between arming and queueing. A
    //    watcher that asked the model whether it was idle would show a third.
    assert.equal(rig.ptyHost.started[0]?.turns.length, turnsBeforeFiring,
      'the watcher started a model turn to find out whether the Run was idle');
  } finally {
    await rig.close();
  }
});

test('an operator sees the same watcher and Notification through the nvk CLI', async () => {
  const rig = await createRig();
  try {
    await spawnSupervised(rig);
    await new Promise((resume) => { setTimeout(resume, IDLE_MS + 200); });
    await anUnrelatedRuntimeEvent(rig);
    await until('the queued Notification', async () => {
      const page = await rig.chris.call<{ items: readonly Notification[] }>(
        'b3.supervision.listNotifications', { limit: 50 }, opId(),
      );
      return !page.ok || page.value.items.length === 0 ? null : page.value.items[0]!;
    });

    const listed = await runNvk([
      'watch', 'list', '--json', '--root', rig.root, '--port', String(rig.host.port),
    ]);
    assert.equal(listed.code, 0, `nvk watch list exited ${String(listed.code)}: ${listed.out}`);
    const rules = JSON.parse(listed.out) as {
      ok: boolean; command: string; value: { rules: readonly WatchRule[] };
    };
    assert.equal(rules.ok, true, listed.out);
    assert.equal(rules.command, 'watch list');
    assert.equal(rules.value.rules.length, 1, 'the CLI cannot see the installed watcher');

    const alerts = await runNvk([
      'watch', 'notifications', '--json', '--root', rig.root, '--port', String(rig.host.port),
    ]);
    assert.equal(alerts.code, 0, `nvk watch notifications exited ${String(alerts.code)}: ${alerts.out}`);
    const page = JSON.parse(alerts.out) as {
      ok: boolean; value: { items: readonly Notification[] };
    };
    assert.equal(page.ok, true, alerts.out);
    assert.equal(page.value.items.length, 1, 'the CLI cannot see the queued Notification');
    assert.equal(page.value.items[0]?.state, 'queued');
  } finally {
    await rig.close();
  }
});
