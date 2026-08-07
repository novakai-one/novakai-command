// Split-brain, proved across REAL processes (NVK-KIMI-025 repair 2).
//
// `split-brain.test.ts` composes runtime hosts over `fake-lease.ts`, and that
// fake implements "one holder at a time, steal only from the dead" INSIDE
// itself. So it proves the fake excludes two hosts. §25-B3a's exit criterion is
// about the machine: two operating system processes, one lock file, one winner.
//
// Everything here spawns real `node` processes against the real
// `createFileInstanceLease`, with the real `process.kill(pid, 0)` liveness
// check. Nothing is simulated except the crash — and that is a real SIGKILL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const contender = path.join(here, 'lease-contender.ts');

interface ContenderReport {
  readonly processId: number;
  readonly held: boolean;
  readonly holderPid?: number;
  readonly heldByThisProcess: boolean;
}

interface Contender {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the process's one JSON line. */
  readonly report: Promise<ContenderReport>;
  start(): void;
  kill(signal: NodeJS.Signals): void;
}

/**
 * Start a contender and hold it at the barrier. It has paid every startup cost
 * — module loading, tsx, the import graph — BEFORE the race, so the race is
 * about the lock and not about who booted faster.
 */
function readyContender(root: string, options: { hold?: boolean } = {}): Contender {
  // Detached, because `tsx` runs the contender in a CHILD of the process this
  // spawn returns. Killing the wrapper would leave the actual lease holder
  // alive — a "crash" that crashes nothing, which would make the steal test
  // pass for the wrong reason. The whole group is killed instead.
  const child = spawn(
    process.execPath,
    [tsx, contender, '--root', root, ...(options.hold === true ? ['--hold'] : [])],
    { cwd: repoRoot, detached: true },
  );
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const report = new Promise<ContenderReport>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const line = stdout.split('\n').find((candidate) => candidate.trim() !== '');
      if (line !== undefined) resolve(JSON.parse(line) as ContenderReport);
    });
    child.on('close', () => {
      if (stdout.trim() === '') reject(new Error(`contender said nothing: ${stderr.trim()}`));
    });
  });
  return {
    child, report,
    start() { child.stdin.write('go\n'); },
    kill(signal) {
      try {
        process.kill(-(child.pid ?? 0), signal); // the group: wrapper AND contender
      } catch {
        child.kill(signal); // already gone
      }
    },
  };
}

const isRunning = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wait until the OS agrees this process no longer exists. */
async function awaitDeathOf(processId: number, within = 10_000): Promise<void> {
  const deadline = Date.now() + within;
  while (isRunning(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isRunning(processId), false,
    `pid ${String(processId)} survived SIGKILL — the "crash" crashed nothing`);
}

/** Every contender has booted and is waiting on stdin. */
async function allWaiting(children: readonly Contender[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  for (const one of children) {
    assert.equal(one.child.exitCode, null, 'a contender died before the race started');
  }
}

function lockHolderPid(root: string): number | null {
  const lockPath = path.join(root, 'runtime', 'runtime.lock');
  if (!existsSync(lockPath)) return null;
  return (JSON.parse(readFileSync(lockPath, 'utf8')) as { hostPid: number }).hostPid;
}

/** A lock left behind by a process that no longer exists. */
function writeOrphanedLock(root: string, deadPid: number): void {
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(
    path.join(root, 'runtime', 'runtime.lock'),
    JSON.stringify({ hostPid: deadPid, startedAt: new Date().toISOString() }),
  );
}

/**
 * A pid that is provably not running: claimed, then reaped. Inventing a large
 * number would be a guess, and a guess that happened to be alive would make the
 * "steal only from the dead" test silently prove nothing.
 */
async function recentlyDeadPid(): Promise<number> {
  const corpse = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = corpse.pid ?? 0;
  await new Promise((resolve) => corpse.on('close', resolve));
  return pid;
}

const CONTENDERS = 8;

test('eight real processes race for one lease and exactly ONE wins', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-xproc-lease-'));
  // They HOLD. A racer that won and exited would be a dead holder a millisecond
  // later, and the next racer stealing from it would be correct behaviour
  // wearing the costume of a second winner.
  const racers = Array.from({ length: CONTENDERS }, () => readyContender(root, { hold: true }));
  try {
    await allWaiting(racers);
    for (const racer of racers) racer.start(); // the same instant, for all of them

    const reports = await Promise.all(racers.map((racer) => racer.report));
    const winners = reports.filter((report) => report.held);
    assert.equal(winners.length, 1,
      `${winners.length} processes believed they owned the runtime: ${JSON.stringify(reports)}`);

    const winner = winners[0]!;
    assert.equal(winner.heldByThisProcess, true, 'the winner cannot confirm its own lock');
    assert.equal(lockHolderPid(root), winner.processId, 'the lock file names someone else');

    for (const loser of reports.filter((report) => !report.held)) {
      assert.equal(loser.heldByThisProcess, false, 'a loser still believed it held the lease');
      assert.equal(loser.holderPid, winner.processId,
        'a loser was told the wrong pid owns the runtime');
    }
  } finally {
    for (const racer of racers) racer.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lease is never taken from a LIVE holder, and always from a dead one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-xproc-steal-'));
  const holder = readyContender(root, { hold: true });
  const whileAlive = readyContender(root);
  const afterDeath = readyContender(root);
  try {
    await allWaiting([holder, whileAlive, afterDeath]);

    holder.start();
    const owner = await holder.report;
    assert.equal(owner.held, true, 'the first process could not take a free lease');

    // A second REAL process, with the holder still running.
    whileAlive.start();
    const refused = await whileAlive.report;
    assert.equal(refused.held, false, 'a live holder was robbed of the runtime');
    assert.equal(refused.holderPid, owner.processId);
    assert.equal(lockHolderPid(root), owner.processId, 'the lock file changed hands');

    // Power loss. No release, no goodbye, no chance to clean up.
    holder.kill('SIGKILL');
    await awaitDeathOf(owner.processId);

    afterDeath.start();
    const successor = await afterDeath.report;
    assert.equal(successor.held, true, 'a dead holder kept the machine hostage');
    assert.equal(successor.heldByThisProcess, true);
    assert.equal(lockHolderPid(root), successor.processId);
  } finally {
    for (const one of [holder, whileAlive, afterDeath]) one.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash leaves a lock behind, and the stampede that follows still has ONE winner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-xproc-orphan-'));
  writeOrphanedLock(root, await recentlyDeadPid());
  // They HOLD. A racer that won and exited would be a dead holder a millisecond
  // later, and the next racer stealing from it would be correct behaviour
  // wearing the costume of a second winner.
  const racers = Array.from({ length: CONTENDERS }, () => readyContender(root, { hold: true }));
  try {
    await allWaiting(racers);
    // Every one of them sees the same orphaned lock and decides to steal it.
    for (const racer of racers) racer.start();

    const reports = await Promise.all(racers.map((racer) => racer.report));
    const winners = reports.filter((report) => report.held);
    assert.equal(winners.length, 1,
      `${winners.length} processes stole the same orphaned lease: ${JSON.stringify(reports)}`);
    assert.equal(lockHolderPid(root), winners[0]!.processId);
    for (const winner of winners) {
      assert.equal(winner.heldByThisProcess, true,
        'the winner of the stampede does not own the lock it claimed');
    }
  } finally {
    for (const racer of racers) racer.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
