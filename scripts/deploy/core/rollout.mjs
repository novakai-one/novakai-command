// deploy/core/rollout.mjs — the deploy sequence itself, and what happens when
// it fails: production rolls BACK to the last release that passed health,
// never sits dark behind a broken candidate.
import fs from 'node:fs';
import path from 'node:path';
import { DeployError } from '../contract/types.mjs';
import { PATHS, PORT, describeCheckout, resolveProdDataRoot, say } from './context.mjs';
import { HEALTH_TIMEOUT_MS, waitBootstrapHealthy, waitHealthy } from './health.mjs';
import {
  assertCutoverSafe,
  captureLoadedJobPlist,
  jobLoaded,
  killPreviousServers,
  launchdLogFor,
  restoreCapturedJob,
  startJob,
  stopJob,
} from './launchd.mjs';
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

function rollbackTarget(currentProd) {
  const previous = readLastGood();
  if (previous !== null) return { kind: 'release', previous };
  const legacyPlist = captureLoadedJobPlist();
  if (legacyPlist !== null) return { kind: 'legacy-job', legacyPlist };
  if (jobLoaded() || currentProd.pids.length > 0) {
    throw new DeployError(
      'cannot preserve the running production server for first-deploy rollback — its launchd plist is unavailable',
    );
  }
  return { kind: 'none' };
}

async function rollback(dataRoot, target) {
  stopJob(); // the broken candidate must not KeepAlive-respawn forever
  if (target.kind === 'none') {
    say('ROLLBACK: no server was running before cutover — previous (down) state preserved');
    return true;
  }
  try {
    if (target.kind === 'legacy-job') {
      say('ROLLBACK: restoring the pre-deploy launchd job…');
      restoreCapturedJob(target.legacyPlist);
      const healthy = await waitBootstrapHealthy(PORT);
      if (healthy) say('ROLLBACK OK — pre-deploy server live again');
      else say(`ROLLBACK FAILED — pre-deploy server did not become healthy; see ${launchdLogFor(dataRoot)}`);
      return healthy !== null;
    }
    const { previous } = target;
    say(`ROLLBACK: restoring ${previous.commit} (${path.basename(previous.releaseDir)})…`);
    startJob(previous.releaseDir, dataRoot);
    const healthy = await waitHealthy(PORT, previous.commit);
    if (healthy) say(`ROLLBACK OK — ${previous.commit} live again on :${PORT}, pid ${healthy.pid}`);
    else say(`ROLLBACK FAILED — ${previous.commit} did not become healthy; see ${launchdLogFor(dataRoot)}`);
    return healthy !== null;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    say(`ROLLBACK FAILED — ${reason}; see ${launchdLogFor(dataRoot)}`);
    return false;
  }
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

  const currentProd = assertCutoverSafe();
  const target = rollbackTarget(currentProd);
  let healthy;
  try {
    await killPreviousServers();
    startJob(releaseDir, dataRoot);
    say(`launchd job started — waiting for /version to report ${release.commit}…`);
    healthy = await waitHealthy(PORT, release.commit);
    if (!healthy) {
      throw new DeployError(
        `candidate did not become healthy in ${HEALTH_TIMEOUT_MS / 1000}s; see ${launchdLogFor(dataRoot)}`,
      );
    }
    recordLastGood(releaseDir, release.commit);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const restored = await rollback(dataRoot, target);
    throw new DeployError(
      `deploy of ${release.commit} failed during cutover: ${reason}; `
      + (restored ? 'previous production restored' : 'ROLLBACK FAILED'),
    );
  }
  prune(options.keep, releaseDir, releaseDir);
  say(`DEPLOYED ${release.commit} (${release.branch}) — live on :${PORT}, pid ${healthy.pid}`);
}
