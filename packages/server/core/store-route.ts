// §18.1's store-route cutover, at the one moment the spec allows it: before a
// single handle opens under the root.
//
// This lives above `b3/` because it is not a B3 concern. It is a property of
// the ROOT, and every process that opens a Foundation handle under a root has
// to observe it — the Runtime, and the offline `nvk token mint` that has to run
// before the Runtime is reachable at all (§13 disposition 4). Leaving it inside
// the Runtime's composition meant the mint wrote `stores/config.jsonl` beside a
// legacy `config.jsonl`, and the gate the Runtime ran next turned the
// operator's only path to a token into a permanently blocked boot.
import path from 'node:path';
import { surveyStoreRoute } from '@novakai/foundation/contract';
import {
  checkMessagingStoreRoute, readMessagingCutoverReceipt, runMessagingCutover,
} from '../../messaging/contract/index.js';
import { LEGACY_MESSAGING_STORE } from './b3/cutover-report.js';

/** Roots already gated in this process — the cutover is once per root, not once per handle. */
const gated = new Map<string, Promise<void>>();

/**
 * The blocked-boot refusal, as a type rather than a message a caller has to
 * pattern-match. It still throws (see `gateStoreRoute`); a composition root
 * catches it and renders the operator's version.
 */
export class StoreRouteConflictError extends Error {
  readonly kinds: readonly string[];

  constructor(kinds: readonly string[]) {
    super(`StoreRouteConflict: ${kinds.join(', ')} exist on both the canonical and the legacy `
      + 'route with no cutover receipt');
    this.name = 'StoreRouteConflictError';
    this.kinds = kinds;
  }
}

/**
 * §18.1's canonical JSONL directory for a root. Spelled once: a composition
 * that computes it differently opens a second route under the same root, which
 * is the conflict this module exists to refuse.
 */
export function canonicalDataRoot(root: string): string {
  return path.join(root, 'stores');
}

/**
 * §18.1 steps 1–7, before a single canonical handle opens.
 *
 * "Deployment first stops every old Server process... no old handle may remain
 * reachable", then the fenced copy, then dispatch. The helper shipped tested
 * and unreachable: nothing in the boot path called it, so canonical dispatch
 * could open and write beside a legacy journal — the two-writers-one-invisible
 * case the conflict rule exists to prevent.
 *
 * It throws rather than returning a result: a process that came up after a
 * route conflict would be a process writing to a route nobody proved is
 * current, and every caller is a composition root with nowhere to put a typed
 * failure that early.
 *
 * Memoised per root. Two handles opened by the same process must not race two
 * cutovers against each other — the second would find the receipt the first had
 * not finished writing.
 */
export async function gateStoreRoute(root: string, dataRoot: string): Promise<void> {
  const routeKey = `${path.resolve(root)}\0${path.resolve(dataRoot)}`;
  const running = gated.get(routeKey);
  if (running) return running;
  const started = runGate(root, dataRoot);
  gated.set(routeKey, started);
  try {
    await started;
  } catch (failure) {
    // A failed gate is not a decision. Clearing it lets a caller that fixed the
    // root try again in the same process instead of inheriting the refusal.
    gated.delete(routeKey);
    throw failure;
  }
}

async function runGate(root: string, dataRoot: string): Promise<void> {
  const legacyStorePath = path.join(root, LEGACY_MESSAGING_STORE);

  // §18.1 step 3: the legacy root for THIS cutover is `.novakai` itself — the
  // B1 Foundation files sitting flat beside the new `stores/` directory —
  // stated explicitly rather than left to Foundation's sibling
  // `.novakai-command` default. That default is a different migration; relying
  // on it here migrated nothing, because a B1 root has no sibling.
  const survey = surveyStoreRoute({ dataRoot, legacyRoot: root });

  // §18.1's last paragraph, before anything is read or written: canonical and
  // legacy both present with no receipt is a blocked boot, not a preference.
  // Foundation's new-root-first fallback would otherwise serve the canonical
  // file and never mention that the legacy one may hold newer truth.
  const sealed = await readMessagingCutoverReceipt({ root, dataRoot, legacyStorePath });
  if (sealed === null && survey.conflicting.length > 0) {
    throw new StoreRouteConflictError(survey.conflicting);
  }

  const cutoverInput = {
    root,
    dataRoot,
    legacyStorePath,
    copy: { legacyRoot: root, kinds: survey.migratable },
  };

  const route = await checkMessagingStoreRoute(cutoverInput);
  if (!route.ok) {
    throw new Error(`${route.error.code}: ${route.error.message}`);
  }
  if (route.value === 'clear' && survey.migratable.length === 0) return;

  const migrated = await runMessagingCutover(cutoverInput);
  if (!migrated.ok) {
    throw new Error(`${migrated.error.code}: ${migrated.error.message}`);
  }
}
