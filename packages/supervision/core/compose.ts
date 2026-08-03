// The Supervision composition seam.
//
// What this composes is deliberately a SLICE of the frozen contract, typed
// BY the frozen contract: `SupervisionWireSlice` is a `Pick`, so a signature
// that drifts from the freeze stops compiling here rather than passing a test
// that agreed with itself. Lanes A/B/C fill in the members this tracer leaves
// out; none of them has to change what is already wired.
import {
  b3err, b3fail, b3ok, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import type {
  Notification, NotificationEventPage, NotificationEventPageInput, NotificationId,
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
  acknowledgeNotification, claimNotificationDelivery,
  getNotificationDeliveryAuthority, notificationEventPage,
  recordNotificationDeliveryOutcome,
  recordNotificationTranscriptNonObservation,
  recordNotificationTranscriptObservation, subscribeNotifications,
} from './notifications/index.js';
import {
  createUsageProjection, type UsageProjection, type UsageProjectionOptions,
} from './usage/index.js';
import {
  recordDriftStatusSubmission,
  type DriftSubmissionAuthority,
} from './watchers/drift-submission.js';

/** The frozen members the tracer's live wire actually carries current through. */
export type SupervisionWireSlice = Pick<
  SupervisionContract,
  'installRunWatchers' | 'evaluateEvent' | 'listNotifications' | 'listWatchRules'
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

export type SupervisionCore = SupervisionWireSlice
  & SupervisionWatcherReads
  & SupervisionNotificationReads;

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
  /** B3d usage authorities; absent hosts return typed unavailability. */
  readonly usage?: UsageProjectionOptions;
  /** Q2: resolves the Terminal-owned reservation/attempt before drift writes. */
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

const DRIFT_SUBMISSION_NOT_COMPOSED: DriftSubmissionAuthority = {
  verify: async () => b3fail(b3err(
    'RuntimeUnavailable',
    'Terminal drift-submission authority is not composed in this host',
    { reason: 'drift-submission-authority-not-composed' },
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
  const usage = options.usage === undefined
    ? USAGE_NOT_COMPOSED
    : createUsageProjection(options.usage);

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
    claimNotificationDelivery: (context, input) =>
      claimNotificationDelivery({ store }, context, input),
    recordNotificationDeliveryOutcome: (context, input) =>
      recordNotificationDeliveryOutcome({ store }, context, input),
    recordDriftStatusSubmission: (context, input) =>
      recordDriftStatusSubmission({
        store,
        authority: options.driftSubmissionAuthority ?? DRIFT_SUBMISSION_NOT_COMPOSED,
      }, context, input),
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
    listWatchDeadlines: () => store.list<WatchDeadline>('watchDeadline'),
  };
}
