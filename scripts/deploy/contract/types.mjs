// deploy/contract/types.mjs — the shapes every deploy module speaks in.
// Declaration-only: no logic, no I/O. Core and cli import shapes from here;
// behavior lives behind contract/api.mjs.

/**
 * A deploy refusal with a reason meant for the operator. Core throws it;
 * cli/nvk-deploy.mjs catches it and prints `FAILED: <message>` (exit 1).
 * Anything else escaping is a bug, not a refusal.
 */
export class DeployError extends Error {
  /** @param {string} message operator-facing reason, one sentence */
  constructor(message) {
    super(message);
    this.name = 'DeployError';
  }
}

/**
 * @typedef {object} CheckoutFacts
 * What the source checkout is at one instant — re-read after snapshotting to
 * prove nothing moved underneath the copy.
 * @property {string} commit  10-char abbreviated HEAD hash
 * @property {string} branch  current branch, or "(detached)"
 * @property {boolean} dirty  any uncommitted tracked/untracked change
 */

/**
 * @typedef {object} ReleaseStampFile
 * Contents of release.json at a snapshot root; served by /version.
 * @property {string} commit
 * @property {string} branch
 * @property {boolean} dirty
 * @property {string} builtAt   ISO timestamp of the deploy
 * @property {string} source    absolute path of the checkout deployed from
 * @property {string} distDigest sha256 of the built shell bundle — identifies
 *                               the artifact even when two deploys share a commit
 */

/**
 * @typedef {object} DeployOptions
 * @property {number} keep        releases to retain after a successful deploy
 * @property {boolean} allowDirty deploy uncommitted changes (refused by default)
 */

/**
 * @typedef {object} ScratchOptions
 * @property {boolean} hold keep the scratch server running for hands-on
 *                          inspection instead of tearing it down after the checks
 */

/**
 * @typedef {object} LastGood
 * The rollback target: the newest release that passed its health check.
 * @property {string} releaseDir
 * @property {string} commit
 */

/**
 * @typedef {object} ProdServerScan
 * The processes observed in the production lane before a cutover begins.
 * @property {number[]} pids       nvk-server processes owned by the prod lane
 * @property {number[]} strangers :5180 holders that are not nvk-server
 */
