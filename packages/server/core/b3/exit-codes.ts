// AMD-005 A5-11 / NVK-KIMI-085 OQ-05 — the CLI's exit code, as published.
//
// The exit code is a TOTAL function of `CliOutput.error.code`, identical for
// every command, with exactly one code that also reads `error.retryable`.
// `ok:true` is always 0, including every honestly returned unsupported or
// unknown data state (§17.2:3559) — where the contract publishes a
// data-carrying unsupported/unknown variant the CLI returns that value with
// exit 0 and does not synthesise an error.
//
// The assignment law, so a reviewer can reproduce the table rather than
// memorise it:
//
//   2  the request is malformed, names a thing that does not exist, or asks
//      for something this target can never do
//   3  an authority or policy refusal
//   4  the identical request can never succeed until the caller makes a
//      DIFFERENT explicit decision (new expected version, target, confirmation)
//   5  the identical request with the SAME ClientOpId may succeed later with
//      no change
//   6  the effect is uncertain, or repair/attention is required — the caller
//      MUST inspect, not blindly retry
//
// Where a code's meaning and its `retryable` flag disagree, meaning wins:
// `retryable` answers "may I resend this byte-identical request", the exit code
// answers "what must the operator do next". Both are published; neither is
// derived from the other.
//
// `Record<B3ErrorCode, ExitCode>` is deliberate. It is what makes the function
// total, and it is also the canary for a stale `@novakai/foundation` build: a
// dist whose union is behind its source fails to compile here rather than
// silently losing rows.
import type { B3ContractError, B3ErrorCode } from '@novakai/foundation/contract';

/** §17.2. The code says what a script should DO about it, not just that it failed. */
export const EXIT = {
  success: 0,
  validation: 2,
  permission: 3,
  conflict: 4,
  retryable: 5,
  recovery: 6,
} as const;

type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The one code whose exit depends on more than its name. */
const READS_RETRYABLE = 'ProviderTurnBoundaryUnavailable';

export const EXIT_BY_CODE: Readonly<Record<B3ErrorCode, ExitCode>> = {
  ValidationFailed: EXIT.validation,
  UnsupportedContractVersion: EXIT.validation,
  PermissionDenied: EXIT.permission,
  IdempotencyConflict: EXIT.conflict,
  StoreUnavailable: EXIT.retryable,
  StoreRouteConflict: EXIT.recovery,
  VersionConflict: EXIT.conflict,
  StaleRuntimeEpoch: EXIT.conflict,
  RuntimeUnavailable: EXIT.retryable,
  RecoveryRequired: EXIT.recovery,
  UnknownAgent: EXIT.validation,
  AgentArchived: EXIT.conflict,
  UnknownAgentRun: EXIT.validation,
  LiveRunConflict: EXIT.conflict,
  ProviderSessionReservationConflict: EXIT.conflict,
  ProviderSessionCutoverInProgress: EXIT.conflict,
  ProviderSessionCutoverComplete: EXIT.conflict,
  RunFinal: EXIT.conflict,
  NotWorking: EXIT.conflict,
  TargetChanged: EXIT.conflict,
  InterruptUnsupported: EXIT.validation,
  InterruptRacedWithCompletion: EXIT.recovery,
  RoleNotAllowed: EXIT.permission,
  RoleVersionConflict: EXIT.conflict,
  LaunchPlanInvalid: EXIT.validation,
  SkillsConfirmationFailed: EXIT.permission,
  NativeSubagentSkillsUnverified: EXIT.recovery,
  ExecutionRestrictionUnavailable: EXIT.permission,
  AuthorityEscalation: EXIT.permission,
  RelationshipCycle: EXIT.validation,
  TreeClosing: EXIT.retryable,
  SupervisorIneligible: EXIT.permission,
  UnknownTerminalSession: EXIT.validation,
  TerminalNotLive: EXIT.conflict,
  InputLeaseBusy: EXIT.retryable,
  InputLeaseGenerationChanged: EXIT.conflict,
  TargetTurnNotActive: EXIT.conflict,
  InputSubmittedUnconfirmed: EXIT.recovery,
  Backpressure: EXIT.retryable,
  CursorExpired: EXIT.conflict,
  EndpointClaimConflict: EXIT.conflict,
  ExactRunEndpointClosed: EXIT.conflict,
  TranscriptSourceUnavailable: EXIT.retryable,
  TranscriptCorrupt: EXIT.recovery,
  UsageUnavailable: EXIT.recovery,
  WatchRuleInvalid: EXIT.validation,
  WatcherConflict: EXIT.conflict,
  NotificationDeliveryUnsafe: EXIT.retryable,
  UnsupportedOperation: EXIT.validation,

  // AMD-002 §9's five additions.
  SemanticSubmitRequired: EXIT.validation,
  UnknownProviderTurnSubmission: EXIT.validation,
  ProviderTurnSubmissionConflict: EXIT.conflict,
  ProviderTurnOperationInProgress: EXIT.retryable,
  // Overridden per-error by `retryable` — the row is the `false` answer.
  [READS_RETRYABLE]: EXIT.recovery,

  // ── NOT ratified published text (B3E-ENTRY-LIST T-04) ───────────────────
  // Two codes the product publishes that pass2 §11 does not, so the A5-11
  // table has no row for them. Assigned here by the ruling's own five-line
  // law, and named as residuals in the lane report rather than blended in:
  //   * `ProviderInputNotReady` states in its own message that the same
  //     request with the same ClientOpId may be re-issued against an intact
  //     reservation and that nothing was typed → 5.
  //   * `ProviderTurnNeverStarted` ends the Run it was raised against, so the
  //     identical request can never succeed; a new Run is a different explicit
  //     decision → 4.
  // A spec-author reading either publishes them or renames the uses. Until
  // then a total function beats a silent fall-through.
  ProviderInputNotReady: EXIT.retryable,
  ProviderTurnNeverStarted: EXIT.conflict,
};

export function exitCodeFor(error: B3ContractError): number {
  if (error.code === READS_RETRYABLE) return error.retryable ? EXIT.retryable : EXIT.recovery;
  return EXIT_BY_CODE[error.code];
}
