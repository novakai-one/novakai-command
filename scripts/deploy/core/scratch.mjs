// deploy/core/scratch.mjs — the builder lane: prove the exact deploy artifact
// boots and serves, on a throwaway port with a throwaway data root, in
// ~/.novakai-scratch — a directory the prod kill sweep and prune NEVER look
// at, so a held scratch server survives any later production deploy.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeployError } from '../contract/types.mjs';
import { PATHS, say, sh } from './context.mjs';
import { HEALTH_TIMEOUT_MS, getText, waitHealthy } from './health.mjs';
import { releaseNameFor, snapshotChecked, stamp } from './snapshot.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Snapshot the (already built) checkout into the scratch directory, boot it on
 * an OS-assigned port against a fresh temp data root with a minted
 * person_chris, and verify /version reports this commit and the shell bundle
 * is served. `hold` leaves the server running for hands-on/browser
 * inspection; otherwise everything is torn down, pass or fail.
 * @param {import('../contract/types.mjs').CheckoutFacts} checkout
 * @param {import('../contract/types.mjs').ScratchOptions} options
 */
export async function scratchVerify(checkout, options) {
  const releaseDir = path.join(PATHS.scratchDir, `${releaseNameFor(checkout.commit)}-scratch`);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvk-deploy-scratch-'));
  say(`scratch release → ${releaseDir}`);
  snapshotChecked(releaseDir, checkout);
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
  const verdict = port === null ? null : await waitHealthy(port, checkout.commit);
  const html = port === null ? null : await getText(`http://127.0.0.1:${port}/`);
  if (verdict && html?.includes('<div id="root">') && options.hold) {
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
  if (!verdict) throw new DeployError(`scratch boot did not become healthy.\n--- server output ---\n${output}`);
  if (!html || !html.includes('<div id="root">')) throw new DeployError('scratch server did not serve the shell bundle');
  say(`SCRATCH PASS — snapshot boots standalone, /version reports ${verdict.release.commit}, shell served`);
}
