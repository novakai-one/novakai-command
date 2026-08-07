// Runtime's half of the §13.5 ready gate.
//
// Supervision owns watcher creation; Runtime owns whether a spawn may advance.
// The adapter therefore returns identities plus pinned-template evidence, and
// Runtime compares the complete set with the immutable launch plan.
import {
  b3err, b3fail, b3ok, type B3Result,
} from '@novakai/foundation/contract';
import type { InstalledWatcherFacts } from '../contract/custody-ports.js';
import type { LaunchPlanFacts } from '../contract/launch-facts.js';

export function verifyInstalledWatchers(
  plan: LaunchPlanFacts,
  installed: readonly InstalledWatcherFacts[],
): B3Result<null> {
  const policy = plan.supervisionPolicy;
  const expectedExplicit = policy?.requiredWatcherTemplates ?? [];
  const expectedImplicit = policy?.activityDrift === 'required' ? 1 : 0;
  const expectedCount = expectedExplicit.length + expectedImplicit;
  const installedIds = new Set(installed.map((item) => item.templateRef.id));
  const exactExplicit = expectedExplicit.every((expected) => installed.some((item) =>
    item.source === 'explicit'
      && item.templateRef.id === expected.id
      && item.templateRef.version === expected.version
      && item.templateRef.digest === expected.digest));
  const implicitCount = installed.filter(
    (item) => item.source === 'implicit-activity-drift',
  ).length;
  const expectedDriftRef = policy?.activityDriftTemplateRef;
  const exactImplicit = expectedImplicit === 0
    ? implicitCount === 0
    : expectedDriftRef !== undefined && installed.some((item) =>
      item.source === 'implicit-activity-drift'
        && item.templateRef.id === expectedDriftRef.id
        && item.templateRef.version === expectedDriftRef.version
        && item.templateRef.digest === expectedDriftRef.digest);
  if (installed.length === expectedCount
    && installedIds.size === installed.length
    && exactExplicit
    && implicitCount === expectedImplicit
    && exactImplicit) {
    return b3ok(null);
  }
  return b3fail(b3err(
    'WatchRuleInvalid',
    'Supervision did not confirm the exact watcher set pinned by the launch plan',
    { expectedCount, installedCount: installed.length },
    false,
  ));
}
