// The Supervision composition seam.
//
// What this composes is deliberately a SLICE of the frozen contract, typed
// BY the frozen contract: `SupervisionWireSlice` is a `Pick`, so a signature
// that drifts from the freeze stops compiling here rather than passing a test
// that agreed with itself. Lanes A/B/C fill in the members this tracer leaves
// out; none of them has to change what is already wired.
import {
  b3err, b3fail, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import type {
  SupervisionContract, WatchDeadline, WatcherTemplate, WatcherTemplateCatalogue,
  WatcherInstallAuthority,
  WatchRuleAccess,
} from '../contract/index.js';
import {
  createSupervisionStore, type SupervisionStore, type SupervisionStoreOptions,
} from './store.js';
import { createTemplateCatalogue } from './templates.js';
import { installRunWatchers } from './watchers.js';
import { parseInstallRunWatchersInput } from '../contract/input-validation.js';
import { listWatchRules } from './watch-rule-query.js';
import { evaluateEvent, listNotifications } from './notifications.js';
import {
  checkRunDrift, type DriftEvidencePort,
} from './watchers/drift.js';
import {
  recordDriftStatusSubmission, type DriftSubmissionAuthority,
} from './watchers/submission.js';
import { parseRecordDriftStatusSubmissionInput } from '../contract/input-validation.js';
import { claimDueDeadlines, resetDriftEpisode } from './watchers/deadlines.js';
import {
  parseClaimDueDeadlinesInput, parseResetDriftEpisodeInput,
} from '../contract/input-validation.js';
import {
  createWatchRule, updateWatchRule, type WatchRuleGenerationPort,
} from './watchers/rules.js';
import {
  parseCreateWatchRuleInput, parseUpdateWatchRuleInput,
} from '../contract/index.js';

/** The frozen members the tracer's live wire actually carries current through. */
export type SupervisionWireSlice = Pick<
  SupervisionContract,
  'installRunWatchers' | 'evaluateEvent' | 'listNotifications' | 'listWatchRules'
  | 'checkRunDrift'
  | 'recordDriftStatusSubmission'
  | 'claimDueDeadlines'
  | 'resetDriftEpisode'
  | 'createWatchRule' | 'updateWatchRule'
>;

/** Deadline detail remains a tracer host read; WatchRule listing is now frozen. */
export interface SupervisionWatcherReads {
  listWatchDeadlines(
    principal: AuthenticatedPrincipal,
  ): Promise<B3Result<readonly WatchDeadline[]>>;
}

export type SupervisionCore = SupervisionWireSlice & SupervisionWatcherReads;

export interface SupervisionCoreOptions extends SupervisionStoreOptions {
  /** Required: installs are refused unless Agents + Runtime facts can be re-read. */
  readonly installAuthority: WatcherInstallAuthority;
  readonly watchRuleAccess: WatchRuleAccess;
  /**
   * @internal failure injection. §24.3 wants a crash before AND after every
   * durable step, and the honest way to produce one is a store that stops
   * accepting a write, exactly as a dying process would.
   */
  readonly store?: SupervisionStore;
  readonly templates?: WatcherTemplateCatalogue;
  readonly extraTemplates?: readonly WatcherTemplate[];
  readonly clock?: () => Date;
  /** Required at check time; omitted hosts receive a typed RuntimeUnavailable. */
  readonly driftEvidence?: DriftEvidencePort;
  /** Runtime/Terminal truth used to authenticate one recorded status attempt. */
  readonly driftSubmissionAuthority?: DriftSubmissionAuthority;
  /** Required for manual timed rules; there is deliberately no default generation. */
  readonly watchRuleGeneration?: WatchRuleGenerationPort;
}

export function composeSupervision(options: SupervisionCoreOptions): SupervisionCore {
  const store = options.store ?? createSupervisionStore(options);
  const templates = options.templates ?? createTemplateCatalogue(options.extraTemplates ?? []);
  const install = {
    store,
    templates,
    authority: options.installAuthority,
    clock: options.clock ?? ((): Date => new Date()),
  };
  const clock = options.clock ?? ((): Date => new Date());

  return {
    installRunWatchers: (context, input) => {
      const parsed = parseInstallRunWatchersInput(input);
      return parsed.ok ? installRunWatchers(install, context, parsed.value) : Promise.resolve(parsed);
    },
    evaluateEvent: (context, input) => evaluateEvent({ store }, context, input),
    listNotifications: (_principal, filter) => listNotifications({ store }, filter),
    listWatchRules: (principal, filter) => listWatchRules(
      store, options.watchRuleAccess, principal, filter,
    ),
    checkRunDrift: (context, input) => options.driftEvidence === undefined
      ? Promise.resolve(b3fail(b3err(
        'RuntimeUnavailable', 'activity-drift evidence is not composed', {}, true,
      )))
      : checkRunDrift({ store, evidence: options.driftEvidence, clock }, context, input),
    recordDriftStatusSubmission: (context, input) => {
      const parsed = parseRecordDriftStatusSubmissionInput(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (options.driftSubmissionAuthority === undefined) {
        return Promise.resolve(b3fail(b3err(
          'RuntimeUnavailable', 'drift submission authority is not composed', {}, true,
        )));
      }
      return recordDriftStatusSubmission(
        { store, authority: options.driftSubmissionAuthority }, context, parsed.value,
      );
    },
    claimDueDeadlines: (context, input) => {
      const parsed = parseClaimDueDeadlinesInput(input);
      return parsed.ok
        ? claimDueDeadlines({ store, clock }, context, parsed.value)
        : Promise.resolve(parsed);
    },
    resetDriftEpisode: (context, input) => {
      const parsed = parseResetDriftEpisodeInput(input);
      return parsed.ok
        ? resetDriftEpisode({ store, clock }, context, parsed.value)
        : Promise.resolve(parsed);
    },
    createWatchRule: (context, input) => {
      const parsed = parseCreateWatchRuleInput(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (options.watchRuleGeneration === undefined) {
        return Promise.resolve(b3fail(b3err(
          'RuntimeUnavailable', 'watcher generationFor is not composed', {}, true,
        )));
      }
      return createWatchRule(
        { store, generation: options.watchRuleGeneration, clock }, context, parsed.value,
      );
    },
    updateWatchRule: (context, input) => {
      const parsed = parseUpdateWatchRuleInput(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (options.watchRuleGeneration === undefined) {
        return Promise.resolve(b3fail(b3err(
          'RuntimeUnavailable', 'watcher generationFor is not composed', {}, true,
        )));
      }
      return updateWatchRule(
        { store, generation: options.watchRuleGeneration, clock }, context, parsed.value,
      );
    },
    listWatchDeadlines: () => store.list<WatchDeadline>('watchDeadline'),
  };
}
