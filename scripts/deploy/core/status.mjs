// deploy/core/status.mjs — one honest report: what the checkout is, what is
// actually running on :5180, whether launchd owns it, and any ghosts.
import { spawnSync } from 'node:child_process';
import { LABEL, PORT, describeCheckout, say } from './context.mjs';
import { getJson } from './health.mjs';
import { jobLoaded, portHolderPids, prodServerPids } from './launchd.mjs';

function syncLine(release, checkout) {
  if (release.dirty || checkout.dirty) {
    // A dirty stamp shares its commit with unknown edits — commit equality
    // proves nothing, so say so instead of claiming sync.
    return `sync UNKNOWN (${release.dirty ? 'deployed dirty' : 'checkout dirty'} — commits not comparable)`;
  }
  return release.commit === checkout.commit ? 'in sync with checkout' : 'BEHIND checkout';
}

/**
 * Print the running-vs-checkout report. Distinguishes: a stamped release
 * (with drift verdict), a corrupt stamp, an unstamped dev boot, a pre-deploy
 * server (old code, no /version), and nothing listening. Then launchd state
 * and a ghost sweep — prod-lane server processes that do NOT hold the port.
 */
export async function reportStatus() {
  const checkout = describeCheckout();
  say(`checkout: ${checkout.commit} (${checkout.branch})${checkout.dirty ? ' DIRTY' : ''}`);
  const version = await getJson(`http://127.0.0.1:${PORT}/version`);
  if (version?.release) {
    say(`running:  ${version.release.commit} built ${version.release.builtAt} pid ${version.pid} — ${syncLine(version.release, checkout)}`);
  } else if (version?.stamp === 'corrupt') {
    say(`running:  pid ${version.pid} with a CORRUPT release stamp (${version.reason ?? 'unreadable'}) — redeploy`);
  } else if (version?.pid !== undefined) {
    say(`running:  UNSTAMPED server on :${PORT} pid ${version.pid} — a dev boot, not a deploy`);
  } else if ((await getJson(`http://127.0.0.1:${PORT}/bootstrap.json`))?.wsUrl !== undefined) {
    // Old code: an nvk-server from before /version existed — i.e. the tsx-on-
    // live-checkout serve this deploy pipeline replaces.
    say(`running:  PRE-DEPLOY server on :${PORT} (no /version) — run \`nvk deploy\` to replace it`);
  } else {
    say(`running:  nothing answering on :${PORT}`);
  }
  say(`launchd:  ${LABEL} ${jobLoaded() ? 'loaded' : 'NOT loaded'}`);
  const holders = portHolderPids();
  // tsx runs as a parent+child pair: the child binds the port. Neither is a ghost.
  const parents = holders.map((pid) => Number(
    spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim(),
  )).filter(Number.isInteger);
  const found = prodServerPids();
  for (const pid of found.pids) {
    if (!holders.includes(pid) && !parents.includes(pid)) {
      say(`GHOST:    pid ${pid} is a prod server process NOT holding :${PORT} — kill it or redeploy`);
    }
  }
  if (found.strangers.length > 0) {
    say(`WARNING:  :${PORT} held by non-nvk-server pid(s) ${found.strangers.join(', ')}`);
  }
}
