// packages/foundation/contract — the ONLY legal import surface for consumers
// (red gate 6: private core/ is never imported by consumers).
export * from './brands.js';
export * from './errors.js';
export * from './schemas.js';
export * from './types.js';
export * from './compose.js';
export {
  createObject, updateObject, getObject, listObjects, resolveRef,
  queryTrace, queryTraceBound, listQuarantine, listQuarantineBound,
  resolveQuarantine, recordSystemAction, defaultEngine, __resetDefaultEngine,
} from './api.js';
// Token ops (mint/authenticate) are foundation-internal but part of the legal
// import surface so the CLI never reaches into core/ (red gate 6).
export { mintToken, authenticate, loadTokens } from '../core/token.js';
// NOTE: no trace update/delete API exists anywhere in this surface (red gate 5).
