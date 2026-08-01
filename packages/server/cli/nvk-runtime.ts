#!/usr/bin/env -S npx tsx
// nvk-runtime — reach, inspect, or stop the background Novakai Runtime (§17.1).
//
//   nvk-runtime serve  [--root .novakai] [--port 5190] [--static <dir>]
//   nvk-runtime ensure [--start]
//   nvk-runtime status
//   nvk-runtime doctor
//   nvk-runtime stop --live-runs refuse|stop-explicitly
//
// `ensure --start` is the point of the whole slice: it reaches the runtime, and
// starts it if nothing is there, WITHOUT the desktop app being open.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3err, b3fail, type B3ClientOpId, type B3Result } from '@novakai/foundation/contract';
import type { RuntimeStatus, RuntimeDoctorReport, RuntimeStopOutcome } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { clientOpIdFrom, emit, fail, parseFlags, type Flags } from '../core/b3/cli-shared.js';

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

function describeDoctor(report: RuntimeDoctorReport): string {
  const lines = [
    report.ownedByThisProcess
      ? 'This process owns the local runtime.'
      : `This process does NOT own the local runtime (holder pid ${String(report.leaseHolderPid)}).`,
    report.activeEpoch
      ? `Active epoch ${report.activeEpoch.id}, started ${report.activeEpoch.startedAt}.`
      : 'No active epoch is recorded.',
    `${report.supersededEpochs} superseded epoch(s) on record.`,
  ];
  return [...lines, ...report.findings.map((line) => `- ${line}`)].join('\n');
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

async function serveForever(argFlags: Flags): Promise<never> {
  {
    const host = await startRuntimeHost({
      root, port,
      ...(argFlags.value('static') === undefined ? {} : { staticDir: argFlags.value('static')! }),
    });
    process.stdout.write(`[nvk-runtime] background runtime ready on ${host.httpUrl}\n`);
    const shutdown = (): void => { void host.close().then(() => process.exit(0)); };
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
    emit('runtime ensure', argFlags, status, describeStatus);
  },

  async status(argFlags) {
    emit('runtime status', argFlags, await withClient<RuntimeStatus>((client) =>
      client.call<RuntimeStatus>('b3.runtime.getStatus', {})), describeStatus);
  },

  async doctor(argFlags) {
    emit('runtime doctor', argFlags, await withClient<RuntimeDoctorReport>((client) =>
      client.call<RuntimeDoctorReport>('b3.runtime.doctor', {})), describeDoctor);
  },

  async stop(argFlags) {
    const liveRuns = argFlags.value('live-runs') ?? 'refuse';
    if (liveRuns !== 'refuse' && liveRuns !== 'stop-explicitly') {
      emit('runtime stop', argFlags, b3fail(
        b3err('ValidationFailed', '--live-runs must be refuse or stop-explicitly',
          { issues: [{ path: 'live-runs', message: 'unknown value' }] }, false),
      ), () => '');
    }
    // The epoch is read first so a stop can only ever apply to the runtime the
    // caller actually saw — never to one that took over in between.
    const outcome = await withClient<RuntimeStopOutcome>(async (client) => {
      const status = await client.call<RuntimeStatus>('b3.runtime.getStatus', {});
      if (!status.ok) return status;
      return client.call<RuntimeStopOutcome>('b3.runtime.stop', {
        expectedEpochId: status.value.activeEpochId, liveRuns,
      }, operationId());
    });
    emit('runtime stop', argFlags, outcome, describeStop);
  },
};

async function runCommand(name: string, argFlags: Flags): Promise<never> {
  if (!mintedOperationId.ok) {
    return fail(`runtime ${name}`, argFlags, mintedOperationId.error);
  }
  const handler = COMMANDS[name];
  if (!handler) {
    emit('runtime', argFlags, b3fail(
      b3err('ValidationFailed', `unknown command "${name}"`,
        { issues: [{ path: 'command', message: 'expected serve|ensure|status|doctor|stop' }] }, false),
    ), () => '');
  }
  return handler(argFlags);
}

await runCommand(command, flags);
