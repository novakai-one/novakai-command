// The Supervision composition seam.
//
// What this composes is deliberately a SLICE of the frozen contract, typed
// BY the frozen contract: `SupervisionWireSlice` is a `Pick`, so a signature
// that drifts from the freeze stops compiling here rather than passing a test
// that agreed with itself. Lanes A/B/C fill in the members this tracer leaves
// out; none of them has to change what is already wired.
import {
  b3err, b3fail, b3ok, composeReceiptStore,
  type AuthenticatedPrincipal, type B3Result, type IsoUtc, type PublicOperationName,
} from '@novakai/foundation/contract';
import type {
  Notification, NotificationEventPage, NotificationEventPageInput, NotificationId,
  SupervisionContract, WatchDeadline, WatcherTemplate, WatcherTemplateCatalogue,
  WatcherInstallAuthority,
  WatchRuleAccess,
  WatchOccurrenceRelationshipAuthority,
} from '../contract/index.js';
import {
  createSupervisionStore, type SupervisionStore, type SupervisionStoreOptions,
} from './store.js';
import { createTemplateCatalogue } from './templates.js';
import { installRunWatchers } from './watchers.js';
import { parseInstallRunWatchersInput } from '../contract/input-validation.js';
import { listWatchRules } from './watch-rule-query.js';
import {
  evaluateDueDeadlines, evaluateEvent, listNotifications,
} from './notifications.js';
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
import {
  acknowledgeNotification, claimNotificationDelivery,
  getNotificationDeliveryAuthority, notificationEventPage,
  recordNotificationDeliveryOutcome,
  recordNotificationTranscriptNonObservation,
  recordNotificationTranscriptObservation, subscribeNotifications,
} from './notifications/index.js';
import {
  createUsageProjection, type UsageProjection, type UsageProjectionOptions,
} from './usage/index.js';
import { createSupervisionOwnerLinearizer } from './owner-linearizer.js';
import {
  getWatchEvaluationProgress, listWatchEvaluationProgress,
} from './watch-evaluation-progress.js';

/** The frozen members the tracer's live wire actually carries current through. */
export type SupervisionWireSlice = Pick<
  SupervisionContract,
  'installRunWatchers' | 'evaluateEvent' | 'listNotifications' | 'listWatchRules'
  | 'checkRunDrift'
  | 'recordDriftStatusSubmission'
  | 'claimDueDeadlines'
  | 'resetDriftEpisode'
  | 'createWatchRule' | 'updateWatchRule'
  // Lane C: the delivery half of the Notification seam.
  | 'claimNotificationDelivery' | 'recordNotificationDeliveryOutcome'
  | 'recordDriftStatusSubmission'
  | 'acknowledgeNotification' | 'getNotificationDeliveryAuthority'
  | 'subscribeNotifications'
  // Lane C, Q11: the transcript half — the only path past `offered-to-endpoint`.
  | 'recordNotificationTranscriptObservation'
  | 'recordNotificationTranscriptNonObservation'
  // Lane A: the usage half — every Run gets an honest row.
  | 'getAgentUsage'
  | 'getRunUsage'
  | 'getWatchEvaluationProgress' | 'listWatchEvaluationProgress'
>;

/** Deadline detail remains a tracer host read; WatchRule listing is now frozen. */
export interface SupervisionWatcherReads {
  listWatchDeadlines(
    principal: AuthenticatedPrincipal,
  ): Promise<B3Result<readonly WatchDeadline[]>>;
}

/** Q8's bounded page, which the transport uses in place of a held stream. */
export interface SupervisionNotificationReads {
  notificationEventPage(
    principal: AuthenticatedPrincipal,
    input: NotificationEventPageInput,
  ): Promise<B3Result<NotificationEventPage>>;
  getNotificationDeliveryState(
    principal: AuthenticatedPrincipal,
    notificationId: NotificationId,
  ): Promise<B3Result<Notification['deliveryAttempt']>>;
}

/** Embedded Runtime clock seam; deliberately absent from the human wire. */
export interface SupervisionDeadlineScheduler {
  evaluateDueDeadlines(observedAt: IsoUtc): Promise<B3Result<readonly Notification[]>>;
}

export type SupervisionCore = SupervisionWireSlice
  & SupervisionWatcherReads
  & SupervisionNotificationReads
  & SupervisionDeadlineScheduler;

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
  /** Runtime generation authority for manual timed and generation-fenced rules. */
  readonly watchRuleGeneration?: WatchRuleGenerationPort;
  /** B3d usage authorities; absent hosts return typed unavailability. */
  readonly usage?: UsageProjectionOptions;
  /** Agents-owned immutable spawn relationships for child occurrence validation. */
  readonly occurrenceRelationships?: WatchOccurrenceRelationshipAuthority;
  /** Runtime/Terminal truth used to authenticate one recorded status attempt.
   *  Q2: resolves the Terminal-owned reservation/attempt before drift writes. */
  readonly driftSubmissionAuthority?: DriftSubmissionAuthority;
}

const USAGE_NOT_COMPOSED: UsageProjection = {
  getRunUsage: async () => b3fail(b3err(
    'RuntimeUnavailable',
    'usage projection authorities are not composed in this host',
    { reason: 'usage-not-composed' },
    true,
  )),
  getAgentUsage: async () => b3fail(b3err(
    'RuntimeUnavailable',
    'usage projection authorities are not composed in this host',
    { reason: 'usage-not-composed' },
    true,
  )),
};

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
  const usage = options.usage === undefined
    ? USAGE_NOT_COMPOSED
    : createUsageProjection(options.usage);
  const receipts = composeReceiptStore(options);
  const owner = createSupervisionOwnerLinearizer(options.dataRoot ?? options.root);
  const evaluation = {
    store,
    ...(options.usage === undefined ? {} : { runs: options.usage.runs }),
    ...(options.usage === undefined ? {} : { evidence: options.usage.evidence }),
    ...(options.occurrenceRelationships === undefined
      ? {}
      : { relationships: options.occurrenceRelationships }),
    ...(options.watchRuleGeneration === undefined
      ? {}
      : { generation: options.watchRuleGeneration }),
  };

  return {
    installRunWatchers: (context, input) => {
      const parsed = parseInstallRunWatchersInput(input);
      return parsed.ok
        ? owner.run(() => installRunWatchers(install, context, parsed.value))
        : Promise.resolve(parsed);
    },
    evaluateEvent: (context, input) => owner.run(() => receipts.runCommand(
      context,
      {
        operation: 'supervision.evaluateEvent' as PublicOperationName,
        request: input,
        replaySafe: true,
        retainRetryableProgress: true,
      },
      () => evaluateEvent(evaluation, context, input),
    )),
    evaluateDueDeadlines: (observedAt) => owner.run(
      () => evaluateDueDeadlines({ store }, observedAt),
    ),
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
      return owner.run(() => createWatchRule(
        {
          store,
          clock,
          ...(options.watchRuleGeneration === undefined
            ? {}
            : { generation: options.watchRuleGeneration }),
        },
        context,
        parsed.value,
      ));
    },
    updateWatchRule: (context, input) => {
      const parsed = parseUpdateWatchRuleInput(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      return owner.run(() => updateWatchRule(
        {
          store,
          clock,
          ...(options.watchRuleGeneration === undefined
            ? {}
            : { generation: options.watchRuleGeneration }),
        },
        context,
        parsed.value,
      ));
    },
    claimNotificationDelivery: (context, input) =>
      claimNotificationDelivery({ store }, context, input),
    recordNotificationDeliveryOutcome: (context, input) =>
      recordNotificationDeliveryOutcome({ store }, context, input),
    acknowledgeNotification: (context, notificationId) =>
      acknowledgeNotification({ store }, context, notificationId),
    getNotificationDeliveryAuthority: (principal, notificationId) =>
      getNotificationDeliveryAuthority({ store }, principal, notificationId),
    recordNotificationTranscriptObservation: (context, input) =>
      recordNotificationTranscriptObservation({ store }, context, input),
    recordNotificationTranscriptNonObservation: (context, input) =>
      recordNotificationTranscriptNonObservation({ store }, context, input),
    subscribeNotifications: (_principal, after) => subscribeNotifications({ store }, after),
    notificationEventPage: (_principal, input) => notificationEventPage({ store }, input),
    async getNotificationDeliveryState(_principal, notificationId) {
      const found = await store.read<Notification>('notification', notificationId);
      if (!found.ok) return found;
      if (found.value === null) {
        return b3fail(b3err(
          'ValidationFailed', 'unknown notification', { notificationId }, false,
        ));
      }
      return b3ok(found.value.deliveryAttempt);
    },
    getRunUsage: (principal, agentRunId) => usage.getRunUsage(principal, agentRunId),
    getAgentUsage: (principal, agentId) => usage.getAgentUsage(principal, agentId),
    getWatchEvaluationProgress: (principal, watchEvaluationId) =>
      getWatchEvaluationProgress(store, principal, watchEvaluationId),
    listWatchEvaluationProgress: (principal, filter) =>
      listWatchEvaluationProgress(store, principal, filter),
    listWatchDeadlines: () => store.list<WatchDeadline>('watchDeadline'),
  };
}
