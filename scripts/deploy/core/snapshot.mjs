// deploy/core/snapshot.mjs — turning the checkout into a frozen, stamped
// release directory: build, clone, digest, stamp, prune. Nothing here starts
// or stops servers.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeployError } from '../contract/types.mjs';
import { PATHS, describeCheckout, say, sh } from './context.mjs';

// Never cloned into a release: repo plumbing, live data, and scratch output.
const SNAPSHOT_EXCLUDE = new Set([
  '.git', '.novakai', '.claude', '.playwright-cli', 'output', 'scratchpad', 'release',
]);

/** Build the two artifacts a release serves: foundation dist and the shell bundle. */
export function build() {
  say('building @novakai/foundation (tsc)…');
  sh('npm', ['--prefix', 'packages/foundation', 'run', 'build'], { cwd: PATHS.checkout, stdio: 'inherit' });
  say('building shell UI (vite)…');
  sh('npm', ['--prefix', 'packages/shell', 'run', 'build'], { cwd: PATHS.checkout, stdio: 'inherit' });
}

let cloneSupported = null;
function copyEntry(source, destination) {
  if (cloneSupported !== false) {
    const cloned = spawnSync('cp', ['-c', '-R', source, destination]);
    if (cloned.status === 0) { cloneSupported = true; return; }
    cloneSupported = false; // non-APFS volume — plain copy from here on
  }
  sh('cp', ['-R', source, destination]);
}

/**
 * A collision-resistant name for one release directory: second-resolution
 * timestamp for ordering, commit for provenance, random suffix so two deploys
 * in the same second can never share a directory.
 */
export function releaseNameFor(commit) {
  const stampPart = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stampPart}-${commit}-${randomBytes(3).toString('hex')}`;
}

/**
 * Clone the checkout into `releaseDir` (APFS clonefile when the volume allows,
 * plain copy otherwise), then prove the checkout did not change underneath the
 * copy: agents merge in this tree all day, and a stamp naming commit A over
 * bytes of commit B is the skew this whole pipeline exists to kill.
 * @param {import('../contract/types.mjs').CheckoutFacts} before facts captured before the build
 */
export function snapshotChecked(releaseDir, before) {
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const entry of fs.readdirSync(PATHS.checkout)) {
    if (SNAPSHOT_EXCLUDE.has(entry)) continue;
    copyEntry(path.join(PATHS.checkout, entry), path.join(releaseDir, entry));
  }
  const after = describeCheckout();
  if (after.commit !== before.commit || after.dirty !== before.dirty) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    throw new DeployError(
      `checkout changed during the snapshot (${before.commit}${before.dirty ? '+dirty' : ''}`
      + ` → ${after.commit}${after.dirty ? '+dirty' : ''}) — rerun when the tree is quiet`,
    );
  }
}

/**
 * sha256 over the built shell bundle inside the release (paths + bytes,
 * sorted). Two deploys can share a commit (e.g. --allow-dirty); the digest
 * names the artifact itself.
 */
export function distDigest(releaseDir) {
  const distRoot = path.join(releaseDir, 'packages', 'shell', 'dist');
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(distRoot, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(distRoot);
  return hash.digest('hex');
}

/**
 * Write release.json at the snapshot root — the stamp /version serves.
 * @param {import('../contract/types.mjs').CheckoutFacts} checkout
 * @returns {import('../contract/types.mjs').ReleaseStampFile}
 */
export function stamp(releaseDir, checkout) {
  const release = {
    ...checkout,
    builtAt: new Date().toISOString(),
    source: PATHS.checkout,
    distDigest: distDigest(releaseDir),
  };
  fs.writeFileSync(path.join(releaseDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

/**
 * Delete old releases, keeping the newest `keep` plus — always — the active
 * release and the rollback target: pruning the release you would roll back to
 * is how a failed deploy becomes an outage.
 */
export function prune(keep, activeDir, lastGoodDir) {
  if (!fs.existsSync(PATHS.releasesDir)) return;
  const releases = fs.readdirSync(PATHS.releasesDir)
    .map((entry) => path.join(PATHS.releasesDir, entry))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .sort() // timestamp-prefixed names: oldest first
    .filter((dir) => dir !== activeDir && dir !== lastGoodDir);
  for (const dir of releases.slice(0, Math.max(0, releases.length - (keep - 1)))) {
    say(`pruning old release ${path.basename(dir)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
