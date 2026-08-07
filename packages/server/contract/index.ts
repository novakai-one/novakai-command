// packages/server/contract — the ONLY legal import surface for consumers.
// Nothing outside packages/server imports packages/server/core (red gate A-6).
export * from './config.js';
export {
  openConfigStore,
  type ConfigStore, type OpenConfigStoreOptions, type MintPrincipalTokenInput,
} from '../core/config/store.js';
