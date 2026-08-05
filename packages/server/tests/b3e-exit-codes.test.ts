// B3e lane A slice A1 — AMD-005 A5-11: the exit code is a TOTAL function of
// `CliOutput.error.code`.
//
// The table is asserted here row by row, verbatim from the ruling
// (NVK-KIMI-085 §1 OQ-05), because a script or exam row that branches on exit
// status is unfalsifiable unless every code has one published answer. Before
// this, 26 of the 56 codes had a row and everything else fell through to 2 —
// so `RecoveryRequired`-shaped failures told a caller "you sent it wrong".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b3err, type B3ErrorCode } from '@novakai/foundation/contract';
import { EXIT_BY_CODE, exitCodeFor } from '../core/b3/exit-codes.js';

/** The ruled assignment, exactly as published. Nothing here is derived. */
const RULED: Readonly<Record<string, number>> = {
  ValidationFailed: 2, UnsupportedContractVersion: 2, PermissionDenied: 3,
  IdempotencyConflict: 4, StoreUnavailable: 5, StoreRouteConflict: 6,
  VersionConflict: 4, StaleRuntimeEpoch: 4, RuntimeUnavailable: 5,
  RecoveryRequired: 6, UnknownAgent: 2, AgentArchived: 4, UnknownAgentRun: 2,
  LiveRunConflict: 4, ProviderSessionReservationConflict: 4,
  ProviderSessionCutoverInProgress: 4, ProviderSessionCutoverComplete: 4,
  RunFinal: 4, NotWorking: 4, TargetChanged: 4, InterruptUnsupported: 2,
  InterruptRacedWithCompletion: 6, RoleNotAllowed: 3, RoleVersionConflict: 4,
  LaunchPlanInvalid: 2, SkillsConfirmationFailed: 3,
  NativeSubagentSkillsUnverified: 6, ExecutionRestrictionUnavailable: 3,
  AuthorityEscalation: 3, RelationshipCycle: 2, TreeClosing: 5,
  SupervisorIneligible: 3, UnknownTerminalSession: 2, TerminalNotLive: 4,
  InputLeaseBusy: 5, InputLeaseGenerationChanged: 4, TargetTurnNotActive: 4,
  InputSubmittedUnconfirmed: 6, Backpressure: 5, CursorExpired: 4,
  EndpointClaimConflict: 4, ExactRunEndpointClosed: 4,
  TranscriptSourceUnavailable: 5, TranscriptCorrupt: 6, UsageUnavailable: 6,
  WatchRuleInvalid: 2, WatcherConflict: 4, NotificationDeliveryUnsafe: 5,
  UnsupportedOperation: 2,
  // AMD-002 §9's five additions.
  SemanticSubmitRequired: 2, UnknownProviderTurnSubmission: 2,
  ProviderTurnSubmissionConflict: 4, ProviderTurnOperationInProgress: 5,
  // ProviderTurnBoundaryUnavailable is the one code that also reads
  // `retryable`, so it is asserted separately rather than as a single row.
};

/**
 * The two codes the product publishes that the ratified §11 union does not.
 * Named here rather than blended into the ruled table so that nothing pretends
 * they carry the same authority. Both are stop-and-report items (T-04).
 */
const UNRATIFIED: Readonly<Record<string, number>> = {
  ProviderInputNotReady: 5,
  ProviderTurnNeverStarted: 4,
};

test('every ruled code exits exactly as ruled', () => {
  for (const [code, expected] of Object.entries(RULED)) {
    const actual = exitCodeFor(b3err(code as B3ErrorCode, 'x', {}, false));
    assert.equal(actual, expected, `${code} must exit ${expected}, got ${actual}`);
  }
});

test('ProviderTurnBoundaryUnavailable is the one code that reads retryable', () => {
  assert.equal(exitCodeFor(b3err('ProviderTurnBoundaryUnavailable', 'x', {}, true)), 5);
  assert.equal(exitCodeFor(b3err('ProviderTurnBoundaryUnavailable', 'x', {}, false)), 6);
});

test('retryable never moves any other code', () => {
  // "Meaning wins": `retryable` answers "may I resend this byte-identical
  // request", the exit code answers "what must the operator do next". A code
  // whose exit moved with the flag would be answering the wrong question.
  for (const code of Object.keys(RULED)) {
    const asRetryable = exitCodeFor(b3err(code as B3ErrorCode, 'x', {}, true));
    const asFinal = exitCodeFor(b3err(code as B3ErrorCode, 'x', {}, false));
    assert.equal(asRetryable, asFinal, `${code} must not read retryable`);
  }
});

test('the function is total over the published union', () => {
  // The compile-time guarantee is `Record<B3ErrorCode, ExitCode>`; this is its
  // runtime half. A code with no row used to fall through to 2, which told a
  // caller facing a recovery state that its request was malformed.
  const rows = Object.keys(EXIT_BY_CODE);
  const named = new Set([...Object.keys(RULED), 'ProviderTurnBoundaryUnavailable',
    ...Object.keys(UNRATIFIED)]);
  assert.deepEqual(rows.filter((code) => !named.has(code)), [],
    'the table carries a code neither the ruling nor the named residuals cover');
  assert.deepEqual([...named].filter((code) => !rows.includes(code)), [],
    'a named code has no row');
});

test('every exit code is one of the six published meanings', () => {
  for (const code of Object.values(EXIT_BY_CODE)) {
    assert.ok([2, 3, 4, 5, 6].includes(code), `${code} is not a published failure exit`);
  }
});

test('the two unratified product codes are assigned by the ruling own law', () => {
  // Not published text — recorded so the CLI is total rather than silently
  // defaulting, and so the spec-author reading has something concrete to rule
  // on. `ProviderInputNotReady` says in its own message that the same request
  // with the same ClientOpId is safe to re-issue → 5. `ProviderTurnNeverStarted`
  // ends the Run, so the identical request can never succeed → 4.
  for (const [code, expected] of Object.entries(UNRATIFIED)) {
    assert.equal(exitCodeFor(b3err(code as B3ErrorCode, 'x', {}, false)), expected);
  }
});
