// deploy/core/launchd.mjs — the process side of production: the launchd job
// definition, starting/stopping it, and finding every process that counts as
// "the previous prod server" before a new one may bind :5180.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DeployError } from '../contract/types.mjs';
import { LABEL, PATHS, PORT, say } from './context.mjs';

const domain = () => `gui/${process.getuid()}`;
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the launchd job's stdout/stderr land, inside the prod data root. */
export const launchdLogFor = (dataRoot) => path.join(dataRoot, 'server', 'launchd.log');

/**
 * The com.novakai.prod job definition for one release directory: tsx runs the
 * server CLI out of the frozen snapshot, serving the snapshot's own shell
 * bundle, against the ONE prod data root. KeepAlive restarts crashes;
 * AbandonProcessGroup=false means bootout takes the whole tree down.
 */
export function plistFor(releaseDir, dataRoot) {
  const node = process.execPath;
  const programArguments = [
    node,
    path.join(releaseDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(releaseDir, 'packages', 'server', 'cli', 'nvk-server.ts'),
    '--port', String(PORT),
    '--static', path.join(releaseDir, 'packages', 'shell', 'dist'),
    '--root', dataRoot,
  ];
  const argStrings = programArguments.map((argument) => `    <string>${xml(argument)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(`${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(releaseDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><false/>
  <key>StandardOutPath</key><string>${xml(launchdLogFor(dataRoot))}</string>
  <key>StandardErrorPath</key><string>${xml(launchdLogFor(dataRoot))}</string>
</dict>
</plist>
`;
}

/** Raw launchctl call; callers inspect `.status`. */
export function launchctl(verb, ...rest) {
  return spawnSync('launchctl', [verb, ...rest], { encoding: 'utf8' });
}

/** Write the plist and bootstrap the job; throws when launchd refuses. */
export function startJob(releaseDir, dataRoot) {
  fs.mkdirSync(path.dirname(launchdLogFor(dataRoot)), { recursive: true });
  fs.writeFileSync(PATHS.plist, plistFor(releaseDir, dataRoot));
  bootstrapPlist();
}

function bootstrapPlist() {
  const bootstrap = launchctl('bootstrap', domain(), PATHS.plist);
  if (bootstrap.status !== 0) {
    throw new DeployError(`launchctl bootstrap: ${bootstrap.stderr || bootstrap.stdout}`);
  }
}

/** Unload the job (stops KeepAlive respawn); fine when it is not loaded. */
export function stopJob() {
  launchctl('bootout', `${domain()}/${LABEL}`);
}

/** True when launchd currently has the job loaded. */
export function jobLoaded() {
  return launchctl('print', `${domain()}/${LABEL}`).status === 0;
}

/**
 * Capture the exact plist of the currently loaded production job. The first
 * `nvk deploy` uses this as its rollback target because no frozen last-good
 * release exists yet. Returns null when no job is loaded or its definition
 * cannot be read; callers must refuse to stop a live server in that state.
 * @returns {string|null} the complete launchd plist text
 */
export function captureLoadedJobPlist() {
  if (!jobLoaded()) return null;
  try {
    const plist = fs.readFileSync(PATHS.plist, 'utf8');
    return plist.trim().length > 0 ? plist : null;
  } catch {
    return null;
  }
}

/**
 * Restore and bootstrap a launchd definition captured before the cutover.
 * This compatibility path is used only to recover a failed first deployment;
 * successful deployments always run a frozen release through `startJob`.
 * @param {string} plist complete plist text returned by captureLoadedJobPlist
 * @returns {void}
 */
export function restoreCapturedJob(plist) {
  fs.mkdirSync(path.dirname(PATHS.plist), { recursive: true });
  fs.writeFileSync(PATHS.plist, plist);
  bootstrapPlist();
}

const commandOf = (pid) =>
  spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();

const parentOf = (pid) =>
  Number(spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim());

/** Pids currently LISTENing on :5180, whoever they are. */
export function portHolderPids() {
  return spawnSync('lsof', ['-tnP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean).map(Number);
}

/**
 * Prod-lane server pids from BOTH directions, so no supported invocation can
 * hide: (a) any nvk-server command line naming --port 5180 or a release dir;
 * (b) whoever actually holds :5180, when it or its parent is an nvk-server —
 * this catches NOVAKAI_PORT=5180 env boots whose argv never says the port.
 * Scratch rigs (--port 0, ~/.novakai-scratch) match neither test.
 * @returns {{pids: number[], strangers: number[]}} strangers = :5180 holders
 *          that are provably NOT nvk-server; callers fail closed on them
 */
export function prodServerPids() {
  const listing = spawnSync('pgrep', ['-fl', 'nvk-server.ts'], { encoding: 'utf8' });
  const byCmdline = listing.status !== 0 ? [] : listing.stdout.split('\n').filter(Boolean)
    .filter((line) => line.includes(`--port ${PORT}`) || line.includes(PATHS.releasesDir))
    .map((line) => Number(line.split(' ')[0]));
  const pids = new Set(byCmdline);
  const strangers = [];
  for (const holder of portHolderPids()) {
    const own = commandOf(holder);
    const parent = parentOf(holder);
    const viaParent = Number.isInteger(parent) && parent > 1 && commandOf(parent).includes('nvk-server.ts');
    if (own.includes('nvk-server.ts') || viaParent) {
      pids.add(holder);
      if (viaParent) pids.add(parent); // tsx parent+child pair: take both
    } else {
      strangers.push(holder);
    }
  }
  return {
    pids: [...pids].filter((pid) => Number.isInteger(pid) && pid !== process.pid),
    strangers,
  };
}

/**
 * Refuse a cutover while :5180 belongs to a non-nvk-server process. This runs
 * before rollout enters its failure/rollback region, so a refusal cannot
 * unload the healthy job it was meant to protect.
 * @returns {import('../contract/types.mjs').ProdServerScan} observed prod lane
 * @throws {DeployError} when a foreign process owns :5180
 */
export function assertCutoverSafe() {
  const found = prodServerPids();
  if (found.strangers.length > 0) {
    throw new DeployError(`:${PORT} is held by non-nvk-server pid(s) ${found.strangers.join(', ')} — resolve manually`);
  }
  return found;
}

/**
 * Rule 3: before a new release starts, every previous prod server process is
 * gone — launchd job first, then SIGTERM→SIGKILL for the rest. Fails closed
 * when :5180 is held by something that is not an nvk-server: an unknown
 * process is never killed and never deployed over.
 */
export async function killPreviousServers() {
  assertCutoverSafe();
  stopJob();
  let found = prodServerPids();
  if (found.pids.length === 0) { say('no previous prod server processes'); return; }
  say(`stopping previous prod server processes: ${found.pids.join(', ')}`);
  for (const pid of found.pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && prodServerPids().pids.length > 0) await sleep(250);
  for (const pid of prodServerPids().pids) {
    say(`SIGKILL ${pid} (did not exit on SIGTERM)`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await sleep(250);
  const holdouts = prodServerPids().pids;
  if (holdouts.length > 0) throw new DeployError(`could not kill previous server pid(s) ${holdouts.join(', ')}`);
}
