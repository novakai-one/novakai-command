// The Supervision composition seam.
//
// What this composes is deliberately a SLICE of the frozen contract, typed
// BY the frozen contract: `SupervisionWireSlice` is a `Pick`, so a signature
// that drifts from the freeze stops compiling here rather than passing a test
// that agreed with itself. Lanes A/B/C fill in the members this tracer leaves
// out; none of them has to change what is already wired.
import type { ActivityGeneration, AuthenticatedPrincipal, B3Result } from '@novakai/foundation/contract';
import type {
  HumanPrincipalId, InstallRunWatchersInput, NotificationRecipient,
  SupervisionContract, WatchDeadline,
} from '../contract/index.js';
import {
  createSupervisionStore, type SupervisionStore, type SupervisionStoreOptions,
} from './store.js';
import {
  createTemplateCatalogue, type WatcherTemplate, type WatcherTemplatePort,
} from './templates.js';
import { installRunWatchers, listWatchRules } from './watchers.js';
import { evaluateEvent, listNotifications } from './notifications.js';

/** The frozen members the tracer's live wire actually carries current through. */
export type SupervisionWireSlice = Pick<
  SupervisionContract,
  'installRunWatchers' | 'evaluateEvent' | 'listNotifications' | 'listWatchRules'
>;

/** Deadline detail remains a tracer host read; WatchRule listing is now frozen. */
export interface SupervisionWatcherReads {
  listWatchDeadlines(
    principal: AuthenticatedPrincipal,
  ): Promise<B3Result<readonly WatchDeadline[]>>;
}

export type SupervisionCore = SupervisionWireSlice & SupervisionWatcherReads;

export interface SupervisionCoreOptions extends SupervisionStoreOptions {
  /** Who a fired watcher tells when the host has no supervisor lookup wired. */
  readonly supervisorPrincipalId: HumanPrincipalId;
  /**
   * @internal failure injection. §24.3 wants a crash before AND after every
   * durable step, and the honest way to produce one is a store that stops
   * accepting a write, exactly as a dying process would.
   */
  readonly store?: SupervisionStore;
  readonly templates?: WatcherTemplatePort;
  readonly extraTemplates?: readonly WatcherTemplate[];
  readonly clock?: () => Date;
  readonly recipientFor?: (input: InstallRunWatchersInput) => Promise<NotificationRecipient>;
  readonly generationFor?: (input: InstallRunWatchersInput) => Promise<ActivityGeneration>;
}

export function composeSupervision(options: SupervisionCoreOptions): SupervisionCore {
  const store = options.store ?? createSupervisionStore(options);
  const templates = options.templates ?? createTemplateCatalogue(options.extraTemplates ?? []);
  const escalateTo: NotificationRecipient = {
    kind: 'human', principalId: options.supervisorPrincipalId,
  };
  const install = {
    store,
    templates,
    clock: options.clock ?? ((): Date => new Date()),
    recipientFor: options.recipientFor ?? (async (): Promise<NotificationRecipient> => escalateTo),
    generationFor: options.generationFor
      ?? (async (): Promise<ActivityGeneration> => 1 as ActivityGeneration),
  };

  return {
    installRunWatchers: (context, input) => installRunWatchers(install, context, input),
    evaluateEvent: (context, input) => evaluateEvent({ store }, context, input),
    listNotifications: (_principal, filter) => listNotifications({ store }, filter),
    listWatchRules: (_principal, filter) => listWatchRules(store, filter),
    listWatchDeadlines: () => store.list<WatchDeadline>('watchDeadline'),
  };
}
