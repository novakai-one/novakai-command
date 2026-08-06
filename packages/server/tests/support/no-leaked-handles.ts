/**
 * The suite's own law: **a test file may not outlive its tests.**
 *
 * Preloaded into every test worker (`tsx --import ./tests/support/
 * no-leaked-handles.ts --test …`, see `package.json`), so there is no rule for
 * anyone to remember and no call site to change.
 *
 * WHY (P-01). Cleanup in this suite lives on the happy path — 129 in-body
 * `close()` calls against 13 registered `t.after` hooks across 93 files. A test
 * that fails BEFORE its close line leaks a listening server; the worker then
 * holds a live handle and cannot exit; `node --test` runs with
 * `--test-timeout=0` and waits on that worker for as long as the machine is up.
 * Parallelism does not cause that — it only pulls the trigger, because a
 * saturated machine is where load-sensitive assertions fail. Measured here: an
 * orphaned worker from an earlier SERIAL run, 4h51m old, PPID 1, still
 * LISTENing.
 *
 * WHY NOT `--test-force-exit`. It stops the RUNNER waiting and leaves the
 * leaking worker behind as an orphan still holding its port (6 leaks → 6
 * orphans, measured). That trades a visible hang for a silent process leak, and
 * it is how this machine grew workers days old parented to init.
 *
 * So: close what the file left open, then FAIL THAT FILE by name. The run ends,
 * nothing is orphaned, and the report points at the offender rather than at the
 * run.
 *
 * `process._getActiveHandles()` is undocumented; the documented
 * `process.getActiveResourcesInfo()` returns type NAMES only, and a name cannot
 * be closed. This is harness code, never product code, and the call is written
 * so that a runtime without it degrades to "no guard" rather than to a crash.
 *
 * Scope, stated rather than assumed: a listening server is the one handle a
 * worker can hold that is unambiguously the file's own and always safe to
 * close. Other live handles (client sockets, child processes, PTYs) are NAMED
 * in the message but not touched — the worker's own plumbing lives among them,
 * and a guard that closed the reporting channel would be worse than the hang.
 */
import { after } from 'node:test';
import { Server as NetServer } from 'node:net';

interface HandleProbe {
  _getActiveHandles?: () => readonly unknown[];
}

/**
 * The worker's entry file, which is the file under test. The guard must say it
 * itself: node attributes a root `after()` failure to the location of the HOOK,
 * so the report names this module — in a 93-file run, 93 identical lines with no
 * way to tell which file leaked. Naming the offender is the whole point.
 */
const fileUnderTest = process.argv[1] ?? '(unknown file)';

/**
 * A server that has been closed can still appear in `_getActiveHandles()` for a
 * tick or two. `listening` is the state that decides whether the file walked
 * away from a socket, and it is what keeps this guard off honest files — the
 * first draft failed a file that closed correctly.
 */
function isStillListening(handle: unknown): handle is NetServer {
  return handle instanceof NetServer && handle.listening;
}

/** stdin/stdout/stderr are the worker's, not the file's. */
function isStdio(handle: unknown): boolean {
  const descriptor = (handle as { fd?: unknown }).fd;
  return typeof descriptor === 'number' && descriptor >= 0 && descriptor <= 2;
}

function describeOthers(handles: readonly unknown[]): string {
  const names = handles
    .filter((handle) => !isStillListening(handle) && !isStdio(handle))
    .map((handle) => (handle as object).constructor.name);
  return names.length === 0 ? '' : ` Also still live (not closed by the guard): ${names.join(', ')}.`;
}

after(async () => {
  const probe = process as unknown as HandleProbe;
  const live = probe._getActiveHandles?.() ?? [];
  const servers = live.filter(isStillListening);
  if (servers.length === 0) return;

  await Promise.all(servers.map(async (server) => {
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
  }));

  throw new Error(
    `${fileUnderTest}: ${String(servers.length)} listening server(s)`
    + " outlived this file's tests."
    + ' Register the close AT THE BOOT — `t.after(() => { server.close(); })` —'
    + ' rather than sequencing it at the end of the happy path: a test that'
    + ' fails before that line leaks the server, the worker can then never'
    + ' exit, and the whole run waits on it forever.'
    + describeOthers(live),
  );
});
