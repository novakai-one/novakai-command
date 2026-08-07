// A REAL OS process that wants this machine's runtime lease.
//
// Not a fake and not a thread: the split-brain rule is about two operating
// system processes, so the proof needs two operating system processes. This one
// waits at a barrier, races for the real file lease, reports what the OS gave
// it in one JSON line, and then does exactly what it was told to do next.
//
//   tsx lease-contender.ts --root <dir> [--hold]
//
// Stdin is the starting gun: nothing is attempted until a line arrives, so the
// parent can line several of these up and release them in the same instant.
import { createFileInstanceLease } from '../adapters/file-lease.js';

interface ContenderReport {
  readonly processId: number;
  readonly held: boolean;
  readonly holderPid?: number;
  /** What the lock file says after the attempt — the OS's answer, not ours. */
  readonly heldByThisProcess: boolean;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function waitForStartingGun(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const root = flag('root');
  if (root === undefined) throw new Error('lease-contender needs --root');
  const holding = process.argv.includes('--hold');

  const lease = createFileInstanceLease({ root });
  await waitForStartingGun();

  const outcome = lease.acquire();
  const report: ContenderReport = {
    processId: process.pid,
    held: outcome.held,
    ...(outcome.held ? {} : { holderPid: outcome.holderPid }),
    heldByThisProcess: lease.heldByThisProcess(),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);

  if (!holding) {
    // Leaving WITHOUT releasing, on purpose: a crashed holder is the case that
    // matters, and a tidy release would prove the easy half instead.
    process.exit(0);
  }
  // Stay alive and keep holding until the parent kills this process.
  setInterval(() => undefined, 1_000);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
