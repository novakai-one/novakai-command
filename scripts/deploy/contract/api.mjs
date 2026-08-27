// deploy/contract/api.mjs — the callable surface of the deploy package. Three
// verbs, guarded the same way every time: never from a snapshot, one deploy at
// a time. cli/nvk-deploy.mjs calls these and nothing deeper.
import {
  PATHS, PORT, acquireDeployLock, describeCheckout, guardNotASnapshot, resolveProdDataRoot, say,
} from '../core/context.mjs';
import { deployRelease } from '../core/rollout.mjs';
import { scratchVerify } from '../core/scratch.mjs';
import { reportStatus } from '../core/status.mjs';
import { build } from '../core/snapshot.mjs';

/**
 * Deploy the current checkout to production: build, snapshot, stamp, replace
 * the live server, health-check, prune. Rolls back to the last-known-good
 * release when the candidate fails health. Throws DeployError on any refusal.
 * @param {import('./types.mjs').DeployOptions} options
 */
export async function deploy(options) {
  guardNotASnapshot();
  const releaseLock = acquireDeployLock();
  try {
    await deployRelease(options);
  } finally {
    releaseLock();
  }
}

/**
 * Print what is running vs what the checkout has: release stamp and drift,
 * launchd state, ghost processes, foreign :5180 holders. Read-only.
 */
export async function status() {
  guardNotASnapshot();
  await reportStatus();
}

/**
 * Prove the pipeline on a throwaway port and data root in ~/.novakai-scratch;
 * the live server is untouched. `hold` keeps the scratch server running for
 * inspection. Takes the deploy lock: a scratch snapshot must not race a real
 * deploy's snapshot of the same moving checkout.
 * @param {import('./types.mjs').ScratchOptions} options
 */
export async function scratch(options) {
  guardNotASnapshot();
  const releaseLock = acquireDeployLock();
  try {
    const checkout = describeCheckout();
    build();
    await scratchVerify(checkout, options);
  } finally {
    releaseLock();
  }
}

/**
 * Print the plan a real `deploy(options)` would execute, changing nothing —
 * including which prod data root it would bind (resolving it may itself
 * refuse, which is the dry run doing its job).
 * @param {import('./types.mjs').DeployOptions} options
 */
export function dryRun(options) {
  guardNotASnapshot();
  const checkout = describeCheckout();
  const dataRoot = resolveProdDataRoot();
  say(`would build foundation + shell, snapshot ${checkout.commit} (${checkout.branch}${checkout.dirty ? ', DIRTY' : ''}) → ${PATHS.releasesDir},`);
  say(`rewrite ${PATHS.plist}, kill previous prod servers, start on :${PORT} with --root ${dataRoot}, prune to ${options.keep}`);
}
