// B3 shared kernel (B3V4-P2 §§4, 11 + AMD-001).
//
// Every Build 3 capability needs the same identifiers, the same trusted command
// context, and the same typed failure vocabulary. They live here — inside the
// capability that already owns envelope, trace and identity law — because the
// ratified import law (§3.1) admits no shared "b3-core" package.
//
// Nothing in this file persists anything by itself. Durability still goes
// through Foundation's one engine, one lock, one CAS counter and one trace.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientOpId } from './brands.js';
import { fail, ok, type FoundationMutationProvenance, type Result } from './types.js';

// ── Branded scalars (§4.2) ──────────────────────────────────────────────────
// Brands are compile-time assistance only; every boundary still runs the
// matching runtime validator below.
declare const b3brand: unique symbol;
export type B3Brand<T, Name extends string> = T & { readonly [b3brand]: Name };

export type IsoUtc = B3Brand<string, 'IsoUtc'>;
export type CommandReceiptId = B3Brand<string, 'CommandReceiptId'>;
export type RuntimeEpochId = B3Brand<string, 'RuntimeEpochId'>;
export type AgentRunId = B3Brand<string, 'AgentRunId'>;
// B3b (§4.2). Agents mints the first five; Agent Runtime the next five.
export type AgentRoleProfileId = B3Brand<string, 'AgentRoleProfileId'>;
export type ResolvedLaunchPlanId = B3Brand<string, 'ResolvedLaunchPlanId'>;
export type AgentRelationshipId = B3Brand<string, 'AgentRelationshipId'>;
export type DelegationGrantId = B3Brand<string, 'DelegationGrantId'>;
export type ControlReplacementPlanId = B3Brand<string, 'ControlReplacementPlanId'>;
export type RunContinuationId = B3Brand<string, 'RunContinuationId'>;
export type SupervisionAssignmentId = B3Brand<string, 'SupervisionAssignmentId'>;
export type TreeMutationFenceId = B3Brand<string, 'TreeMutationFenceId'>;
export type RunOperationId = B3Brand<string, 'RunOperationId'>;
/** Inherited from Agents unchanged (§4.1, AMD-001 §4): existing `sess_<uuidv4>`. */
export type ProviderSessionId = B3Brand<string, 'ProviderSessionId'>;
/** The stable individual, distinct from every one of its Runs (DEC-B3V4-02). */
export type B3AgentId = B3Brand<string, 'AgentId'>;
export type PolicyVersion = B3Brand<number, 'PolicyVersion'>;
export type ProviderTurnId = B3Brand<string, 'ProviderTurnId'>;
export type TerminalSessionId = B3Brand<string, 'TerminalSessionId'>;
export type ControllerAttachmentId = B3Brand<string, 'ControllerAttachmentId'>;
export type TerminalInputLeaseId = B3Brand<string, 'TerminalInputLeaseId'>;
export type TerminalInputAttemptId = B3Brand<string, 'TerminalInputAttemptId'>;
/** Inherited from Foundation unchanged (§4.1): existing `op_<uuidv4>`. */
export type B3ClientOpId = ClientOpId;
export type TraceCorrelationId = B3Brand<string, 'TraceId'>;
export type HumanPrincipalId = B3Brand<string, 'HumanPrincipalId'>;
export type AgentRunPrincipalId = B3Brand<string, 'AgentRunPrincipalId'>;
export type ScriptPrincipalId = B3Brand<string, 'ScriptPrincipalId'>;
export type OperationsPrincipalId = B3Brand<string, 'OperationsPrincipalId'>;
export type RecordVersion = B3Brand<number, 'RecordVersion'>;
export type ActivityGeneration = B3Brand<number, 'ActivityGeneration'>;
export type LeaseGeneration = B3Brand<number, 'LeaseGeneration'>;
export type AuthorityScope = B3Brand<string, 'AuthorityScope'>;
export type PublicOperationName = B3Brand<string, 'PublicOperationName'>;
export type EventCursor = B3Brand<string, 'EventCursor'>;

export type CapabilityOwner =
  | 'foundation' | 'agents' | 'agent-runtime' | 'terminal' | 'messaging'
  | 'transcript' | 'supervision' | 'shell' | 'server'
  | 'projects' | 'artifacts' | 'spine';

// ── Identity minting and validation (§4.1) ─────────────────────────────────

/**
 * Lowercase UUIDv7 — new Build 3 random identities only. Inherited Foundation
 * and Agents identifiers keep their existing v4 format, so a v4 id already
 * accepted by the store never becomes invalid.
 */
export function uuidv7(): string {
  const epochMs = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((epochMs >> 40n) & 0xffn);
  bytes[1] = Number((epochMs >> 32n) & 0xffn);
  bytes[2] = Number((epochMs >> 24n) & 0xffn);
  bytes[3] = Number((epochMs >> 16n) & 0xffn);
  bytes[4] = Number((epochMs >> 8n) & 0xffn);
  bytes[5] = Number(epochMs & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC 4648 base32 without padding — the deterministic-id encoding. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
}

const HASH_FIELD_SEPARATOR = '\u001F';

/**
 * Deterministic identity from a field tuple (§4.1): `b3v4` + U+001F-joined UTF-8.
 *
 * A field may not contain the separator itself. If it could, `["a<SEP>b","c"]`
 * and `["a","b","c"]` would hash identically — one record able to claim
 * another's deterministic identity. Every field a B3 caller passes is an
 * already-validated identifier, so this is unreachable through a public door;
 * it throws rather than hashes because a broken invariant here is a programming
 * error, not a caller outcome to be returned.
 */
export function deterministicId(prefix: string, fields: readonly string[]): string {
  for (const field of fields) {
    if (field.includes(HASH_FIELD_SEPARATOR)) {
      throw new Error(`deterministic id field contains the tuple separator: ${prefix}`);
    }
  }
  const digest = createHash('sha256')
    .update(['b3v4', ...fields].join(HASH_FIELD_SEPARATOR), 'utf8')
    .digest();
  return `${prefix}_${base32(digest)}`;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUIDV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE32SHA256 = /^[a-z2-7]{52}$/;

export type IdFormat = 'uuidv7' | 'uuidv4' | 'base32sha256';

/**
 * Prefix-strict validation. A well-formed body under the WRONG prefix is
 * rejected — red gate 3 says the identity types are not interchangeable, and
 * that is only true if the validator says so.
 */
export function isValidId(value: unknown, prefix: string, format: IdFormat): boolean {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(`${prefix}_`)) return false;
  const body = value.slice(prefix.length + 1);
  if (format === 'uuidv7') return UUIDV7.test(body);
  if (format === 'uuidv4') return UUIDV4.test(body);
  return BASE32SHA256.test(body);
}

export const mintRuntimeEpochId = (): RuntimeEpochId => `runtimeEpoch_${uuidv7()}` as RuntimeEpochId;
export const mintTerminalSessionId = (): TerminalSessionId => `terminal_${uuidv7()}` as TerminalSessionId;
export const mintControllerAttachmentId = (): ControllerAttachmentId => `controller_${uuidv7()}` as ControllerAttachmentId;
export const mintTerminalInputLeaseId = (): TerminalInputLeaseId => `terminalInputLease_${uuidv7()}` as TerminalInputLeaseId;
export const mintTerminalInputAttemptId = (): TerminalInputAttemptId => `terminalInput_${uuidv7()}` as TerminalInputAttemptId;
export const mintAgentRunId = (): AgentRunId => `agentRun_${uuidv7()}` as AgentRunId;
export const mintProviderTurnId = (): ProviderTurnId => `providerTurn_${uuidv7()}` as ProviderTurnId;
export const mintAgentRoleProfileId = (): AgentRoleProfileId => `agentRole_${uuidv7()}` as AgentRoleProfileId;
export const mintResolvedLaunchPlanId = (): ResolvedLaunchPlanId => `launchPlan_${uuidv7()}` as ResolvedLaunchPlanId;
export const mintDelegationGrantId = (): DelegationGrantId => `delegationGrant_${uuidv7()}` as DelegationGrantId;
export const mintControlReplacementPlanId = (): ControlReplacementPlanId => `controlReplacement_${uuidv7()}` as ControlReplacementPlanId;
export const mintRunContinuationId = (): RunContinuationId => `runContinuation_${uuidv7()}` as RunContinuationId;
export const mintSupervisionAssignmentId = (): SupervisionAssignmentId => `supervisionAssignment_${uuidv7()}` as SupervisionAssignmentId;
export const mintTreeMutationFenceId = (): TreeMutationFenceId => `treeFence_${uuidv7()}` as TreeMutationFenceId;
/** §4.1 + AMD-001 §4: keeps the existing Agents UUIDv4 shape, not a new v7. */
export const mintProviderSessionId = (): ProviderSessionId => `sess_${randomUUID()}` as ProviderSessionId;
export const mintB3AgentId = (): B3AgentId => `agent_${randomUUID()}` as B3AgentId;

/**
 * One edge per ordered pair, so recording the same parent→child twice is
 * idempotent rather than a second edge (§13.5's "deterministic edge ID").
 * Direction is part of the tuple: an edge is not symmetric.
 */
export const mintAgentRelationshipId = (
  parentAgentId: string, childAgentId: string,
): AgentRelationshipId =>
  deterministicId('agentRelationship', [parentAgentId, childAgentId]) as AgentRelationshipId;

/**
 * One journal per command receipt (DEC-B3V4-26/30). Derived rather than random
 * so a crash before the first append still finds the same operation on retry.
 */
export const mintRunOperationId = (commandReceiptId: string): RunOperationId =>
  deterministicId('runOperation', [commandReceiptId]) as RunOperationId;
export const mintTraceCorrelationId = (): TraceCorrelationId => `trace_${randomUUID()}` as TraceCorrelationId;
export const nowIsoUtc = (): IsoUtc => new Date().toISOString() as IsoUtc;

// ── Trusted command context (§4.4) ─────────────────────────────────────────

export type B3SystemPrincipalId =
  | 'sys_foundation' | 'sys_agents' | 'sys_agent_runtime' | 'sys_terminal'
  | 'sys_messaging' | 'sys_transcript' | 'sys_supervision' | 'sys_shell';

export type B3PrincipalId =
  | HumanPrincipalId | AgentRunPrincipalId | ScriptPrincipalId
  | OperationsPrincipalId | B3SystemPrincipalId;

export interface AuthenticatedPrincipal {
  readonly id: B3PrincipalId;
  readonly kind: 'human' | 'agent-run' | 'script' | 'operations' | 'system';
  readonly agentRunId?: AgentRunId;
  readonly verifiedScopes: readonly AuthorityScope[];
}

/**
 * Everything a mutation is allowed to trust. The request body never carries a
 * principal, `createdBy`, parent identity or grant expansion (red gate 5) —
 * those come from the authenticated transport session and land here.
 */
export interface CommandContext {
  readonly principal: AuthenticatedPrincipal;
  readonly clientOpId: B3ClientOpId;
  readonly traceId: TraceCorrelationId;
  readonly contractVersion: 1;
  readonly runtimeEpochId?: RuntimeEpochId;
}

export type SystemCommandContext<Id extends B3SystemPrincipalId> =
  Omit<CommandContext, 'principal'> & {
    readonly principal: AuthenticatedPrincipal & { readonly id: Id; readonly kind: 'system' };
  };

export function isSystemPrincipal<Id extends B3SystemPrincipalId>(
  context: CommandContext, id: Id,
): context is SystemCommandContext<Id> {
  return context.principal.kind === 'system' && context.principal.id === id;
}

// ── Public record view (§4.3) ──────────────────────────────────────────────

export type B3PermissionLevel = 'private' | 'team' | 'external';

/**
 * Reuses Foundation's provenance union verbatim — one definition, so a B3
 * reader and a Foundation reader can never drift apart.
 */
export type MutationProvenance = FoundationMutationProvenance;

/**
 * The public capability view of a durable record. NOT a second persisted
 * envelope: identity/creation fields come from Foundation's `Envelope`,
 * `recordVersion` from `RecordLine.meta.version`. Nothing here is serialized
 * as a competing envelope field.
 */
export interface RecordEnvelope<
  Id extends string, Kind extends string, SchemaVersion extends number = 1,
> {
  readonly id: Id;
  readonly kind: Kind;
  readonly schemaVersion: SchemaVersion;
  readonly recordVersion: RecordVersion;
  readonly createdAt: IsoUtc;
  readonly permissionLevel: B3PermissionLevel;
  readonly createdBy: B3PrincipalId;
  readonly lastMutation: MutationProvenance;
}

export interface VisibilityOmission {
  readonly reason: 'permission' | 'unsupported-version';
  readonly count: number;
}

export interface B3Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: EventCursor;
  readonly omissions: readonly VisibilityOmission[];
}

// ── Error contract (§11) ───────────────────────────────────────────────────

export type B3ErrorCode =
  | 'ValidationFailed' | 'UnsupportedContractVersion' | 'PermissionDenied'
  | 'IdempotencyConflict' | 'StoreUnavailable' | 'StoreRouteConflict'
  | 'VersionConflict' | 'StaleRuntimeEpoch' | 'RuntimeUnavailable'
  | 'RecoveryRequired' | 'UnknownAgent' | 'AgentArchived' | 'UnknownAgentRun'
  | 'LiveRunConflict' | 'ProviderSessionReservationConflict'
  | 'ProviderSessionCutoverInProgress' | 'ProviderSessionCutoverComplete'
  | 'RunFinal' | 'NotWorking' | 'TargetChanged' | 'InterruptUnsupported'
  | 'InterruptRacedWithCompletion' | 'RoleNotAllowed' | 'RoleVersionConflict'
  | 'LaunchPlanInvalid' | 'SkillsConfirmationFailed'
  | 'NativeSubagentSkillsUnverified' | 'ExecutionRestrictionUnavailable'
  | 'AuthorityEscalation' | 'RelationshipCycle' | 'TreeClosing'
  | 'SupervisorIneligible' | 'UnknownTerminalSession' | 'TerminalNotLive'
  | 'InputLeaseBusy' | 'InputLeaseGenerationChanged' | 'TargetTurnNotActive'
  | 'InputSubmittedUnconfirmed' | 'Backpressure' | 'CursorExpired'
  | 'EndpointClaimConflict' | 'ExactRunEndpointClosed'
  | 'TranscriptSourceUnavailable' | 'TranscriptCorrupt' | 'UsageUnavailable'
  | 'WatchRuleInvalid' | 'WatcherConflict' | 'NotificationDeliveryUnsafe'
  | 'UnsupportedOperation';

export interface B3ContractError<
  Code extends B3ErrorCode = B3ErrorCode,
  Details extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly code: Code;
  readonly message: string;
  readonly details: Details;
  readonly retryable: boolean;
}

/**
 * `retryable: true` means the SAME request and the SAME ClientOpId may be
 * retried safely. It never authorises changing the request.
 */
export function b3err<Code extends B3ErrorCode, Details extends Readonly<Record<string, unknown>>>(
  code: Code, message: string, details: Details, retryable: boolean,
): B3ContractError<Code, Details> {
  return { code, message, details, retryable };
}

/** Foundation's Result shape, narrowed to the B3 error vocabulary. */
export type B3Result<T, E extends B3ContractError = B3ContractError> = Result<T, E>;

export const b3ok = ok;
export const b3fail = fail;

/** One place that turns a Foundation store failure into a B3 contract failure. */
export function storeFailure(
  owner: CapabilityOwner, cause: { code: string; message: string },
): B3ContractError {
  if (cause.code === 'CasConflict') {
    return b3err('VersionConflict', cause.message, { owner, cause: cause.code }, true);
  }
  return b3err('StoreUnavailable', cause.message, { owner, cause: cause.code }, true);
}

export function validationFailed(
  issues: ReadonlyArray<{ path: string; message: string }>,
): B3ContractError<'ValidationFailed'> {
  return b3err(
    'ValidationFailed',
    `invalid input: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    { issues }, false,
  );
}
