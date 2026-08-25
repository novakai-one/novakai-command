import type {
  B3ContractError,
  B3Page,
  B3PrincipalId,
  B3Result,
  TraceCorrelationId,
} from '@novakai/foundation/contract';
import type { PersonId } from '../../messaging/contract/index.js';

/** Existing Messaging person identity; Build 3 does not mint a second human brand. */
export type HumanPrincipalId = PersonId;

/** Pass2's shared `TraceId` name over Foundation's existing correlation brand. */
export type TraceId = TraceCorrelationId;

/** Pass2's shared principal union. */
export type PrincipalId = B3PrincipalId;

/** Pass2's generic success/failure union, backed by the shared Foundation shape. */
export type Result<
  Value,
  Error extends B3ContractError = B3ContractError,
> = B3Result<Value, Error>;

/** Pass2's visibility-aware page shape. */
export type Page<Value> = B3Page<Value>;

/** Shared brands and envelopes required to consume Supervision without private imports. */
export type {
  ActivityGeneration,
  AgentId,
  AgentRunId,
  AuthenticatedPrincipal,
  AuthorityScope,
  B3Brand as Brand,
  B3ClientOpId as ClientOpId,
  B3PermissionLevel as PermissionLevel,
  B3SystemPrincipalId as SystemPrincipalId,
  CapabilityOwner,
  CommandContext,
  EventCursor,
  IsoUtc,
  ProviderSessionId,
  ProviderTurnId,
  RecordEnvelope,
  RecordVersion,
  ResolvedLaunchPlanId,
  RuntimeEpochId,
  ServerOpId,
  SystemCommandContext,
  TerminalInputAttemptId,
} from '@novakai/foundation/contract';
