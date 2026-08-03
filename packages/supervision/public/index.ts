// Supervision's composition door.
//
// Two doors, two jobs. `contract/` is the FROZEN one: types, identities,
// validators and seam suites, and the only thing a consumer reasons about.
// This one hands a host the composed capability — the thing a composition root
// needs and nothing else can have.
//
// It exists because the server's architecture law is right: a host may consume
// another package through its public seam only, never through `core/`. The
// Composition stays outside the contract even when an orchestrator-sanctioned
// amendment adds contract vocabulary; hosts still receive no private core path.
export {
  ACTIVITY_DRIFT_WATCH_TEMPLATE,
  IDLE_WATCH_TEMPLATE,
  IDLE_WATCH_TEMPLATE_REF,
  composeSupervision,
  createIdleWatchTemplate,
  createTemplateCatalogue,
  templateDigest,
  type SupervisionCore,
  type SupervisionCoreOptions,
  type SupervisionWatcherReads,
  type SupervisionWireSlice,
  type UsageEvidenceReader,
  type UsageProjection,
  type UsageProjectionOptions,
  type UsageRunFacts,
  type UsageRunReader,
  type WatcherTemplate,
  type WatcherTemplatePort,
} from '../core/index.js';
