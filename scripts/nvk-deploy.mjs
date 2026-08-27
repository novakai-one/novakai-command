#!/usr/bin/env node
// nvk deploy — the ONE way code reaches the live Novakai Command server.
//
//   nvk deploy              build, snapshot this checkout, swap the live server to it
//   nvk deploy status       what is running vs what the checkout has
//   nvk deploy --scratch    prove the pipeline on a throwaway port; live server untouched
//   nvk deploy --dry-run    print the plan, change nothing
//   nvk deploy --keep <n>   how many old releases to retain (default 5)
//
// The live server (launchd job com.novakai.prod, port 5180) never runs the
// working checkout. It runs a frozen APFS clone of the checkout at deploy time,
// stamped with the commit hash (release.json → served at /version). Agents can
// merge all day; the running app moves only when this script says so.
//
// Rule 3: before starting the new release, every previous prod server process
// is killed — launchd job first, then a sweep for orphans (any nvk-server on
// port 5180 or running out of a release dir). No ghosts writing to the stores.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = path.join(CHECKOUT, '.novakai');
const RELEASES_DIR = path.join(os.homedir(), '.novakai-releases');
const LABEL = 'com.novakai.prod';
const PORT = 5180;
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LAUNCHD_LOG = path.join(DATA_ROOT, 'server', 'launchd.log');
// Never cloned into a release: repo plumbing, live data, and scratch output.
const SNAPSHOT_EXCLUDE = new Set([
  '.git', '.novakai', '.claude', '.playwright-cli', 'output', 'scratchpad', 'release',
]);
const DEFAULT_KEEP = 5;
const HEALTH_TIMEOUT_MS = 90_000;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

function sh(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...options });
}

function fail(message) {
  process.stderr.write(`\n[nvk deploy] FAILED: ${message}\n`);
  process.exit(1);
}

function say(message) {
  process.stdout.write(`[nvk deploy] ${message}\n`);
}

// ---------------------------------------------------------------- checkout
function describeCheckout() {
  const commit = sh('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: CHECKOUT }).trim();
  const branch = sh('git', ['branch', '--show-current'], { cwd: CHECKOUT }).trim() || '(detached)';
  const dirty = sh('git', ['status', '--porcelain'], { cwd: CHECKOUT }).trim().length > 0;
  return { commit, branch, dirty };
}

function guardNotASnapshot() {
  if (fs.existsSync(path.join(CHECKOUT, 'release.json'))) {
    fail(`${CHECKOUT} is a deployed snapshot, not the checkout — run deploy from the checkout`);
  }
}

// ------------------------------------------------------------------- build
function build() {
  say('building @novakai/foundation (tsc)…');
  sh('npm', ['--prefix', 'packages/foundation', 'run', 'build'], { cwd: CHECKOUT, stdio: 'inherit' });
  say('building shell UI (vite)…');
  sh('npm', ['--prefix', 'packages/shell', 'run', 'build'], { cwd: CHECKOUT, stdio: 'inherit' });
}

// ---------------------------------------------------------------- snapshot
let cloneSupported = null;
function copyEntry(source, destination) {
  if (cloneSupported !== false) {
    const cloned = spawnSync('cp', ['-c', '-R', source, destination]);
    if (cloned.status === 0) { cloneSupported = true; return; }
    cloneSupported = false; // non-APFS volume — plain copy from here on
  }
  sh('cp', ['-R', source, destination]);
}

function snapshot(checkout, releaseDir) {
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const entry of fs.readdirSync(checkout)) {
    if (SNAPSHOT_EXCLUDE.has(entry)) continue;
    copyEntry(path.join(checkout, entry), path.join(releaseDir, entry));
  }
}

function stamp(releaseDir, checkout) {
  const release = {
    ...checkout,
    builtAt: new Date().toISOString(),
    source: CHECKOUT,
  };
  fs.writeFileSync(path.join(releaseDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

// ------------------------------------------------------------------ launchd
function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plistFor(releaseDir) {
  const node = process.execPath;
  const programArguments = [
    node,
    path.join(releaseDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(releaseDir, 'packages', 'server', 'cli', 'nvk-server.ts'),
    '--port', String(PORT),
    '--static', path.join(releaseDir, 'packages', 'shell', 'dist'),
    '--root', DATA_ROOT,
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
  <key>StandardOutPath</key><string>${xml(LAUNCHD_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LAUNCHD_LOG)}</string>
</dict>
</plist>
`;
}

function launchctl(verb, ...rest) {
  return spawnSync('launchctl', [verb, ...rest], { encoding: 'utf8' });
}

const domain = () => `gui/${process.getuid()}`;

// --------------------------------------------------------------- kill sweep
/**
 * Every prod-lane server process: any nvk-server invocation naming port 5180
 * or running out of a release dir. Scratch rigs (--port 0, tmp roots, other
 * ports) are deliberately NOT matched — parallel agents keep their servers.
 */
function prodServerPids() {
  const listing = spawnSync('pgrep', ['-fl', 'nvk-server.ts'], { encoding: 'utf8' });
  if (listing.status !== 0) return [];
  return listing.stdout.split('\n').filter(Boolean)
    .filter((line) => line.includes(`--port ${PORT}`) || line.includes(RELEASES_DIR))
    .map((line) => Number(line.split(' ')[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function killPreviousServers() {
  launchctl('bootout', `${domain()}/${LABEL}`); // stops KeepAlive respawn; ok if not loaded
  let pids = prodServerPids();
  if (pids.length === 0) { say('no previous prod server processes'); return; }
  say(`stopping previous prod server processes: ${pids.join(', ')}`);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && prodServerPids().length > 0) await sleep(250);
  pids = prodServerPids();
  for (const pid of pids) {
    say(`SIGKILL ${pid} (did not exit on SIGTERM)`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await sleep(250);
  const holdouts = prodServerPids();
  if (holdouts.length > 0) fail(`could not kill previous server pid(s) ${holdouts.join(', ')}`);
}

// ------------------------------------------------------------------ health
function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

async function waitHealthy(port, commit) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const version = await getJson(`http://127.0.0.1:${port}/version`);
    if (version?.release?.commit === commit) return version;
    await sleep(500);
  }
  return null;
}

// ------------------------------------------------------------------- prune
function prune(keep, activeDir) {
  if (!fs.existsSync(RELEASES_DIR)) return;
  const releases = fs.readdirSync(RELEASES_DIR)
    .filter((entry) => fs.statSync(path.join(RELEASES_DIR, entry)).isDirectory())
    .sort() // timestamp-prefixed names: oldest first
    .map((entry) => path.join(RELEASES_DIR, entry))
    .filter((dir) => dir !== activeDir);
  for (const dir of releases.slice(0, Math.max(0, releases.length - (keep - 1)))) {
    say(`pruning old release ${path.basename(dir)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ status
async function status() {
  const checkout = describeCheckout();
  say(`checkout: ${checkout.commit} (${checkout.branch})${checkout.dirty ? ' DIRTY' : ''}`);
  const version = await getJson(`http://127.0.0.1:${PORT}/version`);
  if (version?.release) {
    const drift = version.release.commit === checkout.commit ? 'in sync with checkout' : 'BEHIND checkout';
    say(`running:  ${version.release.commit} built ${version.release.builtAt} pid ${version.pid} — ${drift}`);
  } else if (version?.pid !== undefined) {
    say(`running:  UNSTAMPED server on :${PORT} pid ${version.pid} — a dev boot, not a deploy`);
  } else if ((await getJson(`http://127.0.0.1:${PORT}/bootstrap.json`))?.wsUrl !== undefined) {
    // Old code: an nvk-server from before /version existed — i.e. the tsx-on-
    // live-checkout serve this deploy pipeline replaces.
    say(`running:  PRE-DEPLOY server on :${PORT} (no /version) — run \`nvk deploy\` to replace it`);
  } else {
    say(`running:  nothing answering on :${PORT}`);
  }
  const job = launchctl('print', `${domain()}/${LABEL}`);
  say(`launchd:  ${LABEL} ${job.status === 0 ? 'loaded' : 'NOT loaded'}`);
  const pids = prodServerPids();
  const holder = spawnSync('lsof', ['-tnP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean).map(Number);
  // tsx runs as a parent+child pair: the child binds the port. Neither is a ghost.
  const parents = holder.map((pid) => Number(
    spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim(),
  )).filter(Number.isInteger);
  for (const pid of pids) {
    if (!holder.includes(pid) && !parents.includes(pid)) {
      say(`GHOST:    pid ${pid} is a prod server process NOT holding :${PORT} — kill it or redeploy`);
    }
  }
  if (pids.length === 0 && holder.length > 0) say(`WARNING:  :${PORT} held by non-nvk-server pid(s) ${holder.join(', ')}`);
}

// ----------------------------------------------------------------- scratch
async function scratch(checkout) {
  const releaseDir = path.join(RELEASES_DIR, `${timestampName()}-${checkout.commit}-scratch`);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvk-deploy-scratch-'));
  say(`scratch release → ${releaseDir}`);
  snapshot(CHECKOUT, releaseDir);
  stamp(releaseDir, checkout);
  const tsx = path.join(releaseDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  say('minting scratch principal…');
  sh(process.execPath, [tsx, path.join(releaseDir, 'packages/server/cli/nvk-token.ts'),
    'mint', 'person_chris', '--grants', 'layout,settings,conversationView', '--roles', 'Human',
  ], { cwd: releaseDir, env: { ...process.env, NOVAKAI_ROOT: scratchRoot } });
  say('booting the snapshot on a scratch port…');
  const server = spawn(process.execPath, [tsx, path.join(releaseDir, 'packages/server/cli/nvk-server.ts'),
    '--port', '0', '--root', scratchRoot, '--static', path.join(releaseDir, 'packages/shell/dist'),
  ], { cwd: releaseDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let port = null;
  while (Date.now() < deadline && port === null && server.exitCode === null) {
    const ready = /ready — open http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (ready) { port = Number(ready[1]); break; }
    await sleep(300);
  }
  let verdict = null;
  if (port !== null) verdict = await waitHealthy(port, checkout.commit);
  const html = port === null ? null : await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/`, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', () => resolve(null));
  });
  if (verdict && html?.includes('<div id="root">') && has('--hold')) {
    // Leave the scratch serve up for hands-on inspection (e.g. a browser drive).
    server.unref(); server.stdout.destroy(); server.stderr.destroy();
    say(`SCRATCH PASS — holding: http://127.0.0.1:${port} pid ${server.pid}`);
    say(`release ${releaseDir}`);
    say(`data root ${scratchRoot} — kill ${server.pid} and remove both when done`);
    return;
  }
  server.kill('SIGTERM');
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  if (!verdict) fail(`scratch boot did not become healthy.\n--- server output ---\n${output}`);
  if (!html || !html.includes('<div id="root">')) fail('scratch server did not serve the shell bundle');
  say(`SCRATCH PASS — snapshot boots standalone, /version reports ${verdict.release.commit}, shell served`);
}

const timestampName = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// -------------------------------------------------------------------- main
guardNotASnapshot();
if (args[0] === 'status') { await status(); process.exit(0); }

const checkout = describeCheckout();
if (checkout.dirty) say('WARNING: checkout is dirty — deploying uncommitted changes, stamped dirty:true');

if (has('--dry-run')) {
  say(`would build foundation + shell, snapshot ${checkout.commit} (${checkout.branch}) → ${RELEASES_DIR},`);
  say(`rewrite ${PLIST}, kill previous prod servers, start on :${PORT}, prune to ${valueOf('--keep') ?? DEFAULT_KEEP}`);
  process.exit(0);
}

build();
if (has('--scratch')) { await scratch(checkout); process.exit(0); }

const releaseDir = path.join(RELEASES_DIR, `${timestampName()}-${checkout.commit}`);
say(`snapshotting checkout → ${releaseDir}`);
snapshot(CHECKOUT, releaseDir);
const release = stamp(releaseDir, checkout);
fs.mkdirSync(path.dirname(LAUNCHD_LOG), { recursive: true });
fs.writeFileSync(PLIST, plistFor(releaseDir));
say(`wrote ${PLIST}`);
await killPreviousServers();
const bootstrap = launchctl('bootstrap', domain(), PLIST);
if (bootstrap.status !== 0) fail(`launchctl bootstrap: ${bootstrap.stderr || bootstrap.stdout}`);
say(`launchd job ${LABEL} started — waiting for /version to report ${release.commit}…`);
const healthy = await waitHealthy(PORT, release.commit);
if (!healthy) {
  fail(`server did not become healthy in ${HEALTH_TIMEOUT_MS / 1000}s — see ${LAUNCHD_LOG}`);
}
prune(Number(valueOf('--keep') ?? DEFAULT_KEEP), releaseDir);
say(`DEPLOYED ${release.commit} (${release.branch}) — live on :${PORT}, pid ${healthy.pid}`);
