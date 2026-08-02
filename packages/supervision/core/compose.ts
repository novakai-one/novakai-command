// The Supervision composition seam.
//
// What this composes is deliberately a SLICE of the frozen contract, typed
// BY the frozen contract: `SupervisionWireSlice` is a `Pick`, so a signature
// that drifts from the freeze stops compiling here rather than passing a test
// that agreed with itself. Lanes A/B/C fill in the members this tracer leaves
// out; none of them has to change what is already wired.
import type { AuthenticatedPrincipal, B3Result } from '@novakai/foundation/contract';
import type {
  SupervisionContract, WatchDeadline, WatcherTemplate, WatcherTemplateCatalogue,
  WatcherInstallAuthority,
} from '../contract/index.js';
import {
  createSupervisionStore, type SupervisionStore, type SupervisionStoreOptions,
} from './store.js';
import { createTemplateCatalogue } from './templates.js';
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
  /** Required: installs are refused unless Agents + Runtime facts can be re-read. */
  readonly installAuthority: WatcherInstallAuthority;
  /**
   * @internal failure injection. §24.3 wants a crash before AND after every
   * durable step, and the honest way to produce one is a store that stops
   * accepting a write, exactly as a dying process would.
   */
  readonly store?: SupervisionStore;
  readonly templates?: WatcherTemplateCatalogue;
  readonly extraTemplates?: readonly WatcherTemplate[];
  readonly clock?: () => Date;
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

  return {
    installRunWatchers: (context, input) => installRunWatchers(install, context, input),
    evaluateEvent: (context, input) => evaluateEvent({ store }, context, input),
    listNotifications: (_principal, filter) => listNotifications({ store }, filter),
    listWatchRules: (principal, filter) => listWatchRules(store, principal, filter),
    listWatchDeadlines: () => store.list<WatchDeadline>('watchDeadline'),
  };
}
