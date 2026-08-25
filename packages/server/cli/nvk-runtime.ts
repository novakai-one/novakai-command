#!/usr/bin/env -S npx tsx
// nvk-runtime — reach, inspect, or stop the background Novakai Runtime (§17.1).
//
//   nvk-runtime serve  [--root .novakai] [--port 5190] [--static <dir>]
//   nvk-runtime ensure [--start]
//   nvk-runtime status
//   nvk-runtime doctor
//   nvk-runtime cutover-report [--root <path>]   ← out-of-tree (freeze §5b)
//   nvk-runtime stop --live-runs refuse|stop-explicitly
//
// `ensure --start` is the point of the whole slice: it reaches the runtime, and
// starts it if nothing is there, WITHOUT the desktop app being open.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3err, b3fail, type B3ClientOpId, type B3Result } from '@novakai/foundation/contract';
import type { RuntimeStatus, RuntimeStopOutcome } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, confirmedRuns, emit, expectedEpoch, fail, parseFlags,
  type CliCommand, type Flags,
} from '../core/b3/cli-shared.js';
import {
  buildCutoverReport, describeCutover, LEGACY_MESSAGING_STORE,
} from '../core/store-route-report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const [, , command = 'status', ...rest] = process.argv;
const flags = parseFlags(rest);
const root = flags.value('root') ?? process.env['NOVAKAI_ROOT'] ?? path.join(repoRoot, '.novakai');
const port = Number(flags.value('port') ?? process.env['NOVAKAI_RUNTIME_PORT'] ?? 5190);

/** §17.2: one caller-minted operation id per invocation, generated if omitted. */
const mintedOperationId = clientOpIdFrom(flags);
const operationId = (): B3ClientOpId =>
  (mintedOperationId.ok ? mintedOperationId.value : ('' as B3ClientOpId));

const unreachable = (cause: unknown): B3Result<never> => b3fail(
  b3err('RuntimeUnavailable',
    `no Novakai Runtime is reachable on port ${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { reason: 'not-reachable' }, true),
);

async function withClient<Value>(
  work: (client: RuntimeClient) => Promise<B3Result<Value>>,
): Promise<B3Result<Value>> {
  let client: RuntimeClient;
  try {
    client = await connectRuntime({ root, port });
  } catch (cause) {
    return unreachable(cause);
  }
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

/** Start the runtime detached, so it outlives the shell that asked for it. */
function startDetached(): void {
  const entry = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-runtime.ts');
  const child = spawn(process.execPath, [
    path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    entry, 'serve', '--root', root, '--port', String(port),
  ], { cwd: repoRoot, detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitForRuntime(attempts = 60): Promise<B3Result<RuntimeStatus>> {
  let last: B3Result<RuntimeStatus> = unreachable(new Error('not started'));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await withClient<RuntimeStatus>((client) =>
      client.call<RuntimeStatus>('b3.runtime.getStatus', {}));
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

function describeStatus(status: RuntimeStatus): string {
  const owner = status.ownedByThisProcess ? 'this process' : 'another process';
  return [
    `Novakai Runtime is ${status.state} (epoch ${status.activeEpochId}), owned by ${owner}.`,
    `${status.liveTerminalSessionCount} terminal session(s) running; `
      + `${status.attachedControllerCount} controller(s) currently attached.`,
    status.recoveryRequiredCount > 0
      ? `${status.recoveryRequiredCount} session(s) need recovery — run: nvk-runtime doctor`
      : 'Nothing needs recovery.',
  ].join('\n');
}

/**
 * OQ-01's human clause, on top of FZ-CLI-SCHEMA-007's truth law. Built FROM
 * `describeStatus` rather than beside it, so the two human readings of one
 * query cannot drift into disagreeing about the same machine.
 *
 * Everything here is a field of the one query. `doctor` is a read-only
 * composition of `getRuntimeStatus` and nothing else (OQ-01) — anything it
 * could only say by asking a second question is new surface, and needs an
 * amendment before a lane ships it.
 */
function describeDoctor(status: RuntimeStatus): string {
  return [
    describeStatus(status),
    `Runtime ${status.version} has been up since ${status.startedAt}; `
      + `${status.liveAgentRunCount} Agent Run(s) are still running in Novakai Runtime, `
      + `with ${status.attachedControllerCount} controller(s) attached.`,
    ...(status.recoveryRequiredCount > 0
      ? [`recoveryRequiredCount is ${status.recoveryRequiredCount} — that many session(s) `
        + 'are waiting to be recovered, and are not lost.']
      : []),
  ].join('\n');
}

function describeStop(outcome: RuntimeStopOutcome): string {
  if (!outcome.stopped) {
    return [
      'Refused to stop: sessions are still running.',
      ...outcome.refusedTerminalSessionIds.map((id) => `  still running: ${id}`),
      'Re-run with --live-runs stop-explicitly to stop them deliberately.',
    ].join('\n');
  }
  return [
    `Runtime stopped (epoch ${outcome.stoppedEpochId}).`,
    ...outcome.stoppedTerminalSessionIds.map((id) => `  stopped: ${id}`),
  ].join('\n');
}

/** Long enough for the reply that ordered the stop to reach the caller. */
const GOODBYE_MS = 250;

async function serveForever(argFlags: Flags): Promise<never> {
  {
    let running: Awaited<ReturnType<typeof startRuntimeHost>> | null = null;
    const shutdown = (): void => { void running?.close().then(() => process.exit(0)); };
    const host = await startRuntimeHost({
      root, port,
      ...(argFlags.value('static') === undefined ? {} : { staticDir: argFlags.value('static')! }),
      // `nvk-runtime stop` means STOP. A daemon that kept its port after
      // reporting itself stopped 401s every later request, and `doctor` — the
      // tool for exactly that situation — cannot reach it to say so (probe S-6).
      //
      // Deferred by one beat, because the caller is still holding the socket
      // waiting to be told the runtime stopped: exiting inside the handler
      // takes the answer down with the server, and the operator's command hangs.
      onRuntimeStopped: () => { setTimeout(shutdown, GOODBYE_MS); },
    });
    running = host;
    process.stdout.write(`[nvk-runtime] background runtime ready on ${host.httpUrl}\n`);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => undefined); // serve forever
  }
  throw new Error('unreachable');
}

/** One handler per command — a table, not a branch chain. */
const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
  serve: serveForever,

  async ensure(argFlags) {
    let status = await withClient<RuntimeStatus>((client) =>
      client.call<RuntimeStatus>('b3.runtime.ensure', {}, operationId()));
    if (!status.ok && argFlags.value('start') !== undefined) {
      startDetached();
      status = await waitForRuntime();
    }
    emit('runtime.ensure', argFlags, status, describeStatus);
  },

  async status(argFlags) {
    emit('runtime.status', argFlags, await withClient<RuntimeStatus>((client) =>
      client.call<RuntimeStatus>('b3.runtime.getStatus', {})), describeStatus);
  },

  // OQ-01: a read-only composition of already-published queries — it calls
  // `getRuntimeStatus` and NOTHING else, and its ratified flag set is empty.
  // Exit is 0 whenever the query succeeds: an unhealthy runtime is honest data,
  // not an error, and a doctor that exits non-zero on one is the tool for the
  // situation refusing to answer in exactly that situation.
  async doctor(argFlags) {
    emit('runtime.doctor', argFlags, await withClient<RuntimeStatus>((client) =>
      client.call<RuntimeStatus>('b3.runtime.getStatus', {})), describeDoctor);
  },

  // Answers a different question from the runtime health one — "did the store
  // route actually move, and can I prove it?" — so it is its own verb rather
  // than a flag on a ratified one (NVK-KIMI-092 §4; CL-A: a flag on a §17.1
  // command needs an amendment, and none exists). Out-of-B3e extra under
  // freeze §5b: lawful operator surface, outside X-1's set, carrying no proof.
  //
  // A pure read of the local data root, so it answers with no Runtime running
  // — which is exactly the state someone reaches for it in.
  async ['cutover-report'](argFlags) {
    const report = await buildCutoverReport({
      root,
      dataRoot: path.join(root, 'stores'),
      // The file the product actually writes (packages/server/core/boot.ts:146).
      // It said `messaging-store.jsonl`, which nothing has ever written, so a
      // root with a real legacy journal beside it reported `clear`.
      legacySources: { messagingStoreOp: path.join(root, LEGACY_MESSAGING_STORE) },
    });
    emit('runtime.cutover-report', argFlags, report, describeCutover);
  },

  /**
   * A5-02: `--expect-epoch <RuntimeEpochId>` and `--confirmed-run <AgentRunId>`
   * (repeatable).
   *
   * The old comment claimed the `getStatus` made a stop "apply to the runtime
   * the caller actually saw". It did the opposite: it applied the stop to
   * whichever Runtime was active a millisecond before the write, which is the
   * one case the epoch fence exists to refuse. An operator who read `nvk
   * runtime status`, walked away, and came back to a Runtime that had since
   * restarted would have stopped the NEW one, believing they stopped the old.
   */
  async stop(argFlags) {
    const liveRuns = argFlags.value('live-runs') ?? 'refuse';
    if (liveRuns !== 'refuse' && liveRuns !== 'stop-explicitly') {
      emit('runtime.stop', argFlags, b3fail(
        b3err('ValidationFailed', '--live-runs must be refuse or stop-explicitly',
          { issues: [{ path: 'live-runs', message: 'unknown value' }] }, false),
      ), () => '');
    }
    const epoch = expectedEpoch(argFlags);
    if (!epoch.ok) return fail('runtime.stop', argFlags, epoch.error);
    const confirmed = confirmedRuns(argFlags);
    if (!confirmed.ok) return fail('runtime.stop', argFlags, confirmed.error);
    const outcome = await withClient<RuntimeStopOutcome>(
      (client) => client.call<RuntimeStopOutcome>('b3.runtime.stop', {
        expectedEpochId: epoch.value, liveRuns, ...confirmed.value,
      }, operationId()),
    );
    emit('runtime.stop', argFlags, outcome, describeStop);
  },
};

/** X-1's member for a verb. `serve` is not a command at all — it is the process
 * `ensure --start` spawns (NVK-KIMI-092 §3 row 11) — so it reports under its
 * group; `cutover-report` is an out-of-B3e extra, published outside X-1's set. */
const RUNTIME_COMMANDS: Readonly<Record<string, CliCommand>> = {
  ensure: 'runtime.ensure', status: 'runtime.status',
  doctor: 'runtime.doctor', stop: 'runtime.stop', serve: 'runtime',
  'cutover-report': 'runtime.cutover-report',
};

async function runCommand(name: string, argFlags: Flags): Promise<never> {
  const command = RUNTIME_COMMANDS[name];
  if (command !== undefined && !mintedOperationId.ok) {
    return fail(command, argFlags, mintedOperationId.error);
  }
  const handler = COMMANDS[name];
  if (!handler) {
    emit('runtime', argFlags, b3fail(
      b3err('ValidationFailed', `unknown command "${name}"`,
        { issues: [{ path: 'command',
          message: 'expected serve|ensure|status|doctor|cutover-report|stop' }] }, false),
    ), () => '');
  }
  return handler(argFlags);
}

await runCommand(command, flags);
