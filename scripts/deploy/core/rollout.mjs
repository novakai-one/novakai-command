// deploy/core/rollout.mjs — the deploy sequence itself, and what happens when
// it fails: production rolls BACK to the last release that passed health,
// never sits dark behind a broken candidate.
import fs from 'node:fs';
import path from 'node:path';
import { DeployError } from '../contract/types.mjs';
import { PATHS, PORT, describeCheckout, resolveProdDataRoot, say } from './context.mjs';
import { HEALTH_TIMEOUT_MS, waitHealthy } from './health.mjs';
import { killPreviousServers, launchdLogFor, startJob, stopJob } from './launchd.mjs';
import { build, prune, releaseNameFor, snapshotChecked, stamp } from './snapshot.mjs';

/**
 * The rollback target on disk, or null when no release has ever passed health.
 * @returns {import('../contract/types.mjs').LastGood | null}
 */
export function readLastGood() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.lastGoodFile, 'utf8'));
    return typeof parsed?.releaseDir === 'string' && fs.existsSync(parsed.releaseDir) ? parsed : null;
  } catch {
    return null;
  }
}

function recordLastGood(releaseDir, commit) {
  fs.writeFileSync(PATHS.lastGoodFile, `${JSON.stringify({ releaseDir, commit }, null, 2)}\n`);
}

async function rollback(dataRoot) {
  const previous = readLastGood();
  stopJob(); // the broken candidate must not KeepAlive-respawn forever
  if (previous === null) {
    say('ROLLBACK: no last-known-good release exists — production is DOWN until a deploy succeeds');
    return;
  }
  say(`ROLLBACK: restoring ${previous.commit} (${path.basename(previous.releaseDir)})…`);
  startJob(previous.releaseDir, dataRoot);
  const healthy = await waitHealthy(PORT, previous.commit);
  if (healthy) say(`ROLLBACK OK — ${previous.commit} live again on :${PORT}, pid ${healthy.pid}`);
  else say(`ROLLBACK FAILED — ${previous.commit} did not become healthy; see ${launchdLogFor(dataRoot)}`);
}

/**
 * The whole deploy: build → snapshot (checked against a moving checkout) →
 * stamp → stop every previous prod server → start the candidate → health
 * check on its exact commit. Only a healthy candidate becomes last-known-good
 * and triggers pruning; an unhealthy one is rolled back automatically.
 * Caller (contract/api.mjs) holds the deploy lock around this.
 * @param {import('../contract/types.mjs').DeployOptions} options
 */
export async function deployRelease(options) {
  const dataRoot = resolveProdDataRoot();
  const checkout = describeCheckout();
  if (checkout.dirty && !options.allowDirty) {
    throw new DeployError('checkout is dirty — commit first, or pass --allow-dirty to stamp dirty:true');
  }
  if (checkout.dirty) say('WARNING: deploying uncommitted changes — stamped dirty:true, identified by distDigest');

  build();
  const releaseDir = path.join(PATHS.releasesDir, releaseNameFor(checkout.commit));
  say(`snapshotting checkout → ${releaseDir}`);
  snapshotChecked(releaseDir, checkout);
  const release = stamp(releaseDir, checkout);

  await killPreviousServers();
  startJob(releaseDir, dataRoot);
  say(`launchd job started — waiting for /version to report ${release.commit}…`);
  const healthy = await waitHealthy(PORT, release.commit);
  if (!healthy) {
    say(`candidate did not become healthy in ${HEALTH_TIMEOUT_MS / 1000}s — see ${launchdLogFor(dataRoot)}`);
    await rollback(dataRoot);
    throw new DeployError(`deploy of ${release.commit} failed health check (previous release restored if possible)`);
  }
  recordLastGood(releaseDir, release.commit);
  prune(options.keep, releaseDir, releaseDir);
  say(`DEPLOYED ${release.commit} (${release.branch}) — live on :${PORT}, pid ${healthy.pid}`);
}
