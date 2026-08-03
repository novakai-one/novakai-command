/**
 * The B3c Transcript public door.
 *
 * §3.1's public-import law: another package reaches this capability through
 * `contract/` and nothing else.
 */

export * from './api.js';
export * from './records.js';
export * from './validate.js';
export {
  composeB3Transcript, recordObservedSubagent,
  type B3TranscriptOptions, type CapabilityEventEmitter, type SubagentPromotionPort,
  type TranscriptTurnCompletionPort,
} from '../core/compose.js';
export { createTranscriptStore, TRANSCRIPT_KINDS, type TranscriptStore } from '../core/store.js';
export {
  mirrorLedgerId, type MessagingMirrorPort, type MirrorLedgerEntry,
} from '../core/mirror.js';
export { classifyTurn, stripTerminalControl, type TurnClassification } from '../core/noise.js';
export {
  createMirrorPump,
  type MirrorPump, type MirrorPumpOptions, type MirrorPumpPass, type MirrorPumpPorts,
} from '../core/pump.js';
export {
  createProviderFileSource, type ProviderFileSourceOptions,
} from '../adapters/source-provider-file.js';
export {
  createProviderFileLocator, defaultProviderHomes,
  type ProviderFileLocatorOptions, type ProviderHomes,
} from '../adapters/locate-provider-file.js';
