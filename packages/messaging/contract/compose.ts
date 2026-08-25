/** The only composition facade exported through the Messaging contract. */
export {
  createEmbeddedMessaging,
  EMBEDDED_PROTOCOL_VERSION,
} from "./compose/embedded.js";
export type {
  EmbeddedMessaging,
  EmbeddedMessagingOptions,
} from "./compose/embedded.js";
export {
  createStandaloneMessaging,
  DEFAULT_STANDALONE_HOST,
  DEFAULT_STANDALONE_PORT,
  STANDALONE_PROTOCOL_VERSION,
} from "./compose/standalone.js";
export { createMessagingRuntime } from "../core/ingestion/watch.js";
export type { MessagingRuntimeOptions } from "../core/ingestion/watch.js";
export { createDefaultMessagingRuntime } from "./compose/ingestion.js";
export type {
  ComposedMessagingRuntime,
  DefaultMessagingRuntimeOptions,
  ExternalAdoptionOptions,
} from "./compose/ingestion.js";
export type {
  StandaloneMessaging,
  StandaloneMessagingOptions,
} from "./compose/standalone.js";
