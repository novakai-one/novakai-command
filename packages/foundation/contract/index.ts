// packages/foundation/contract — the ONLY legal import surface for consumers
// (red gate 6: private core/ is never imported by consumers).
export * from './brands.js';
export * from './errors.js';
export * from './schemas.js';
export * from './types.js';
export type { StoreId, StoreIdentity } from './store-identity.js';
export { ensureStoreIdentity } from '../core/store-identity.js';
// B3 (B3V4-P2 §§4, 11): the shared identifier/context/error kernel every Build
// 3 capability speaks, and the one durable command-receipt writer (§3.3).
export * from './b3.js';
// §4.2's MUST, as machinery: the rules live with the capability that owns the
// shape, but every boundary reads its payload the same way.
export { readBoundary, type FieldIssue, type FieldReader } from './validate.js';
export { keysetPage } from './keyset.js';
export {
  composeReceiptStore, canonicalJson, canonicalRequestHash, commandReceiptId,
  type CommandDescriptor, type CommandReceiptRecord, type CommandReceiptState,
  type ComposeReceiptsOptions, type ReceiptStore, type StoredOperationOutcome,
} from './receipts.js';
// M11: composeHandle ONLY — composeEngine (the raw, scope-free engine factory)
// is foundation-internal. Consumers bind a SCOPED handle (R3-6); the contract
// layer enforces scope on every write. Tests/CLIs inside foundation may import
// contract/compose.js directly.
export { composeHandle, type ComposeOptions } from './compose.js';
export {
  createObject, updateObject, commitMutationBatch, getObject, getObjectWithReadFailure,
  getObjectByClientOpId, listObjects, visitObjects, resolveRef,
  queryTrace, queryTraceBound, listQuarantine, listQuarantineBound,
  requestQuarantine, resolveQuarantine, recordSystemAction,
  defaultEngine, __resetDefaultEngine,
  // §18.1's Foundation-bootstrap-only store-route cutover. Not a handle: a
  // capability that could hold `storeRouteCutover` could seal its own migration.
  bootstrapStoreRouteCutover, surveyStoreRoute,
  type BootstrapCutoverInput, type BootstrapCutoverRecord,
} from './api.js';
// Token ops (mint/authenticate) are foundation-internal but part of the legal
// import surface so the CLI never reaches into core/ (red gate 6).
export { mintToken, authenticate, loadTokens } from '../core/token.js';
// NOTE: no trace update/delete API exists anywhere in this surface (red gate 5).
