// deploy/core/context.mjs — the facts a deploy runs against: where everything
// lives, what the checkout is, which data root is production's, and the lock
// that makes deploys one-at-a-time. No launchd, no copying — facts only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployError } from '../contract/types.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every path the pipeline touches, resolved once. `checkout` is the tree this
 * script ships in; `releasesDir` and `scratchDir` are DISJOINT on purpose —
 * the prod kill sweep and prune only ever look under `releasesDir`, so held
 * scratch servers can never be collateral.
 */
export const PATHS = Object.freeze({
  checkout: path.resolve(here, '..', '..', '..'),
  releasesDir: path.join(os.homedir(), '.novakai-releases'),
  scratchDir: path.join(os.homedir(), '.novakai-scratch'),
  prodConfig: path.join(os.homedir(), '.novakai-releases', 'prod.json'),
  lockFile: path.join(os.homedir(), '.novakai-releases', 'deploy.lock'),
  lastGoodFile: path.join(os.homedir(), '.novakai-releases', 'last-good.json'),
  plist: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.novakai.prod.plist'),
});

/** The launchd job label and port of the ONE live server. */
export const LABEL = 'com.novakai.prod';
export const PORT = 5180;

/** One-line progress note to the operator's terminal. */
export function say(message) {
  process.stdout.write(`[nvk deploy] ${message}\n`);
}

/** Run a command, capture stdout, throw on failure. */
export function sh(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...options });
}

/**
 * Commit, branch and dirtiness of the checkout RIGHT NOW. Called twice per
 * deploy — before the build and after the snapshot — because agents share this
 * checkout and a stamp must describe the bytes actually copied.
 * @returns {import('../contract/types.mjs').CheckoutFacts}
 */
export function describeCheckout() {
  const commit = sh('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: PATHS.checkout }).trim();
  const branch = sh('git', ['branch', '--show-current'], { cwd: PATHS.checkout }).trim() || '(detached)';
  const dirty = sh('git', ['status', '--porcelain'], { cwd: PATHS.checkout }).trim().length > 0;
  return { commit, branch, dirty };
}

/** Refuse to deploy FROM a deployed snapshot — deploys come from checkouts. */
export function guardNotASnapshot() {
  if (fs.existsSync(path.join(PATHS.checkout, 'release.json'))) {
    throw new DeployError(`${PATHS.checkout} is a deployed snapshot, not the checkout — run deploy from the checkout`);
  }
}

/**
 * The ONE production data root, independent of whichever checkout or worktree
 * invokes the deploy. Persisted in prod.json so a worktree with no `.novakai`
 * can never silently create a second data universe. First deploy from a
 * checkout that HAS `.novakai` writes the config; after that the file is the
 * only authority and deploys from anywhere else still hit the same root.
 * @returns {string} absolute path of the live server's `--root`
 */
export function resolveProdDataRoot() {
  if (fs.existsSync(PATHS.prodConfig)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(PATHS.prodConfig, 'utf8'));
    } catch {
      throw new DeployError(`${PATHS.prodConfig} is not valid JSON — fix or delete it`);
    }
    if (typeof parsed?.dataRoot !== 'string' || !fs.existsSync(parsed.dataRoot)) {
      throw new DeployError(`prod data root ${parsed?.dataRoot} (from ${PATHS.prodConfig}) does not exist`);
    }
    return parsed.dataRoot;
  }
  const local = path.join(PATHS.checkout, '.novakai');
  if (!fs.existsSync(local)) {
    throw new DeployError(
      `no production data root: ${PATHS.prodConfig} is absent and this checkout has no .novakai. `
      + `Deploy once from the canonical checkout, or write {"dataRoot": "<path>"} to that file.`,
    );
  }
  fs.mkdirSync(PATHS.releasesDir, { recursive: true });
  fs.writeFileSync(PATHS.prodConfig, `${JSON.stringify({ dataRoot: local }, null, 2)}\n`);
  say(`initialized prod data root → ${local} (recorded in ${PATHS.prodConfig})`);
  return local;
}

/**
 * Exclusive deploy lock. Two concurrent deploys share one plist, label, port
 * and kill sweep — serializing them is correctness, not politeness. A lock
 * whose owner pid is dead is stale and reclaimed.
 * @returns {() => void} release function — call in a finally
 */
export function acquireDeployLock() {
  fs.mkdirSync(PATHS.releasesDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(PATHS.lockFile, String(process.pid), { flag: 'wx' });
      return () => { try { fs.rmSync(PATHS.lockFile); } catch { /* already gone */ } };
    } catch {
      const owner = Number(fs.readFileSync(PATHS.lockFile, 'utf8').trim());
      try {
        process.kill(owner, 0);
        throw new DeployError(`another deploy is running (pid ${owner}) — wait for it or remove ${PATHS.lockFile}`);
      } catch (probe) {
        if (probe instanceof DeployError) throw probe;
        fs.rmSync(PATHS.lockFile, { force: true }); // stale: owner is dead
      }
    }
  }
  throw new DeployError(`could not acquire ${PATHS.lockFile}`);
}
