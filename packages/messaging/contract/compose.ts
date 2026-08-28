/** The only composition facade exported through the Messaging contract. */
export { createMessagingRuntime } from "../core/ingestion/watch.js";
export type { MessagingRuntimeOptions } from "../core/ingestion/watch.js";
export { createDefaultMessagingRuntime } from "./compose/ingestion.js";
export type {
  ComposedMessagingRuntime,
  DefaultMessagingRuntimeOptions,
  ExternalAdoptionOptions,
} from "./compose/ingestion.js";
