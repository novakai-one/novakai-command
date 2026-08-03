/* eslint-disable max-lines -- Terminal authority commands remain one public capability contract. */

// The Terminal public contract (B3V4-P2 §12.3). This is the only door.
//
// Callers never learn a PID, a socket path, or how replay is buffered. What
// they get is: a session, who is attached, who may type, an ordered stream,
// and typed failure.
import type {
  ActivityGeneration, AgentRunId, AuthenticatedPrincipal, AuthorityScope,
  B3ContractError, B3Page, B3PrincipalId, B3Result, CommandContext,
  ControllerAttachmentId, EventCursor, LeaseGeneration,
  NotificationId, NotificationInputReservationId, ProviderSessionId,
  ProviderTurnId, ProviderTurnSubmissionId, ProviderTurnSubmissionSource,
  ProviderUsageEvidenceId, RecordVersion, RuntimeEpochId,
  SystemCommandContext, TerminalInputAttemptId, TerminalInputLeaseId, TerminalSessionId,
  TranscriptBindingId, TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';

/**
 * §13.4: "Takeover is an explicit command WITH AUTHORITY." Taking the keyboard
 * from a controller belonging to ANOTHER principal needs this verified scope.
 * Taking it from your own second window does not — that is one person deciding
 * where they are typing, which needs no permission from anyone.
 */
export const TERMINAL_TAKEOVER_SCOPE = 'terminal.takeover' as AuthorityScope;

/**
 * A controller the Runtime has not seen for this long is `stale` (§13.4). Long
 * enough that a slow reload or a sleeping laptop is not called a disappearance;
 * short enough that "3 windows attached" stops being true within a couple of
 * minutes of it not being true. A host that reports sightings must do so
 * comfortably more often than this.
 */
export const DEFAULT_STALE_AFTER_MS = 120_000;
import type {
  ControllerAttachment, ControllerKind, TerminalInputAttempt, TerminalInputKind,
  NotificationInputReservation, ProviderTurnTerminalInputAttempt,
  TerminalInputLease, TerminalSession, TerminalSessionOwner,
} from './records.js';

export interface OpenManagedTerminalInput {
  readonly owner: TerminalSessionOwner;
  /** Opaque Terminal-internal capability token; never a caller-built argv. */
  readonly launchAuthorityRef: string;
  readonly launchFingerprint: string;
  readonly workingDirectory: string;
  readonly columns: number;
  readonly rows: number;
}

export interface AttachControllerInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly controllerKind: ControllerKind;
  readonly columns: number;
  readonly rows: number;
  readonly afterOutputSequence?: number;
}

export interface DetachControllerInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
}

export interface AcquireInputLeaseInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly mode: 'acquire-if-free' | 'renew' | 'explicit-takeover';
  readonly expectedLeaseGeneration?: LeaseGeneration;
  readonly ttlMs: number;
}

export interface ReleaseInputLeaseInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly leaseId: TerminalInputLeaseId;
  readonly generation: LeaseGeneration;
}

export interface ReserveNotificationInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly notificationId: NotificationId;
  readonly effectKey: string;
  readonly expectedActivityGeneration: ActivityGeneration;
  readonly inputTextDigest: string;
  readonly providerTurnId: ProviderTurnId;
}

export interface CommitReservedNotificationInput {
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly effectKey: string;
  /** Provider-framed bytes; digest validation excludes the final submit CR. */
  readonly utf8Text: string;
}

export interface CancelReservedNotificationInput {
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly effectKey: string;
  readonly reason: 'supervision-claim-rejected' | 'runtime-compensation';
}

export interface NotificationInputCommitOutcome {
  readonly reservation: NotificationInputReservation & {
    readonly state: 'committed';
    readonly terminalInputAttemptId: TerminalInputAttemptId;
  };
  readonly attempt: Extract<TerminalInputAttempt, { readonly source: 'system-notification' }>;
}

export interface PrepareProviderTurnInputInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly providerTurnSubmissionId: ProviderTurnSubmissionId;
  readonly deliveryAttemptOrdinal: number;
  readonly providerSessionId: ProviderSessionId;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly startTranscriptWatermark: string | null;
  readonly expectedRunRecordVersion: RecordVersion;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly submissionEffectKey: string;
  readonly inputDigest: string;
  readonly utf8Text: string;
  readonly authority:
    | {
        readonly kind: 'controller';
        readonly attachmentId: ControllerAttachmentId;
        readonly inputLeaseId: TerminalInputLeaseId;
        readonly leaseGeneration: LeaseGeneration;
        readonly expectedNextInputSequence: number;
        readonly requestingPrincipalId: B3PrincipalId;
      }
    | {
        readonly kind: 'runtime-safe-boundary';
        readonly source: ProviderTurnSubmissionSource;
        readonly sourceEffectKey: string;
        readonly sourceObjectRef: string;
        readonly expectedNoActiveInputLease: true;
        readonly expectedNoControllerDraft: true;
      };
}

export type PrepareProviderTurnInputOutcome =
  | { readonly kind: 'prepared'; readonly attempt: ProviderTurnTerminalInputAttempt }
  | {
      readonly kind: 'not-yet-safe';
      readonly blocking:
        | { readonly kind: 'active-input-lease'; readonly leaseId: TerminalInputLeaseId }
        | { readonly kind: 'controller-draft' }
        | { readonly kind: 'active-provider-turn' };
      readonly retryable: true;
      readonly attemptCreated: false;
      readonly inputChanged: false;
    };

export interface ExecuteProviderTurnInputInput {
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly expectedAttemptRecordVersion: RecordVersion;
  readonly submissionEffectKey: string;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly utf8Text: string;
}

export interface CancelPreparedProviderTurnInput {
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly expectedAttemptRecordVersion: RecordVersion;
  readonly reason: 'run-target-changed' | 'runtime-preparation-rejected';
}

export interface SettleTerminalProviderTurnCompletionInput {
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
  readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
}

export type SettleTerminalProviderTurnCompletionOutcome =
  | {
      readonly kind: 'completion-barrier-committed';
      readonly attemptRecordVersion: RecordVersion;
      readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
    }
  | {
      readonly kind: 'already-settled-same-completion';
      readonly attemptRecordVersion: RecordVersion;
      readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
    }
  | {
      readonly kind: 'target-turn-not-active';
      readonly actualProviderTurnId?: ProviderTurnId;
      readonly actualActivityGeneration?: ActivityGeneration;
      readonly inputLeaseChanged: false;
    };

export interface CloseTerminalProviderTurnUnprovenInput {
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly terminalFinalEvidenceRefs: readonly [string, ...string[]];
}

export interface GetProviderTurnInputAttemptInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly submissionEffectKey: string;
}

export interface IncompleteProviderTurnInputAttemptFilter {
  readonly terminalSessionId?: TerminalSessionId;
  readonly agentRunId?: AgentRunId;
  readonly states?: readonly (
    | 'prepared'
    | 'executing'
    | 'submitted-confirmed'
    | 'submitted-unconfirmed'
  )[];
  readonly cursor?: EventCursor;
  readonly limit: number;
}

export interface SetControllerDraftStateInput {
  readonly attachmentId: ControllerAttachmentId;
  readonly expectedDraftGeneration: number;
  readonly state: 'empty' | 'present';
}

export interface WriteTerminalInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly inputLeaseId: TerminalInputLeaseId;
  readonly leaseGeneration: LeaseGeneration;
  /**
   * The input position this write claims — optional, because the published
   * contract publishes no way to learn it. Omitted means "append where the
   * stream is"; the input lease is what makes the writer exclusive. A caller
   * that IS tracking the position keeps the optimistic check by sending it.
   */
  readonly expectedNextInputSequence?: number;
  /** `provider-turn-submit` is accepted only so this generic route can reject it semantically. */
  readonly kindOfInput: TerminalInputKind | 'provider-turn-submit';
  readonly utf8Text?: string;
}

export interface ResizeTerminalInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly columns: number;
  readonly rows: number;
}

export interface InterruptTerminalTurnInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly expectedRuntimeEpochId: RuntimeEpochId;
}

export type InterruptTerminalTurnOutcome =
  | {
      readonly kind: 'barrier-committed';
      readonly providerTurnId: ProviderTurnId;
      readonly revokedLeaseGeneration?: LeaseGeneration;
      readonly newLeaseGeneration: LeaseGeneration;
    }
  | { readonly kind: 'target-turn-not-active'; readonly inputLeaseChanged: false }
  | {
      readonly kind: 'raced-with-completion';
      readonly providerTurnId: ProviderTurnId;
      readonly inputLeaseChanged: true;
    };

export interface TerminateTerminalInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId?: AgentRunId;
  readonly expectedRuntimeEpochId: RuntimeEpochId;
  readonly reason: 'stop-one' | 'stop-tree' | 'spawn-compensation' | 'plain-shell-close';
}

export interface ReadTerminalStreamInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly afterOutputSequence?: number;
  /** Stop after the buffered replay instead of following the live stream. */
  readonly replayOnly?: boolean;
}

export type TerminalOutputFrame =
  | {
      readonly kind: 'bytes';
      readonly terminalSessionId: TerminalSessionId;
      readonly sequence: number;
      readonly base64: string;
    }
  | {
      readonly kind: 'gap';
      readonly requestedAfter?: number;
      readonly earliestAvailable: number;
      readonly latestAvailable: number;
    }
  | { readonly kind: 'exit'; readonly exitCode?: number; readonly signal?: string };

export interface TerminalSessionView {
  readonly session: TerminalSession;
  readonly attachments: readonly ControllerAttachment[];
  readonly activeInputLease?: TerminalInputLease;
  readonly replay: { readonly earliestSequence: number; readonly latestSequence: number };
  /**
   * The sequence the next write must claim (`expectedNextInputSequence`).
   *
   * The input stream's position is Runtime-private state, so a controller that
   * has just attached cannot know it — and a controller that assumes the stream
   * restarts with it is refused forever (NVK-KIMI-025 repair 1). The view states
   * it instead: reattaching is asking, never guessing.
   */
  readonly nextInputSequence: number;
}

export interface ListTerminalSessionsFilter {
  readonly state?: 'live' | 'final' | 'all';
}

/**
 * Most recent first. Two controllers seen in the same millisecond are ordered
 * by attachment id, which is a UUIDv7 and therefore carries the time it was
 * minted — so "most recently focused" is a total order, not whatever the
 * sort happened to leave behind.
 */
function byMostRecent(
  left: ControllerAttachment, right: ControllerAttachment,
): number {
  const seen = right.lastSeenAt.localeCompare(left.lastSeenAt);
  return seen === 0 ? right.id.localeCompare(left.id) : seen;
}

/**
 * Which attachment's viewport the PTY actually follows (DEC-B3V4-29). Exposed
 * as one pure function so Shell, CLI and core cannot each invent their own
 * answer — and so "the chosen source is visible" is checkable, not folklore.
 */
export function resolveAuthoritativeViewport(view: TerminalSessionView): {
  readonly attachmentId: ControllerAttachmentId;
  readonly columns: number;
  readonly rows: number;
  readonly source: 'input-lease-holder' | 'most-recently-focused';
} | null {
  const attached = view.attachments.filter(
    (item) => item.state === 'attached' && item.viewport !== undefined,
  );
  const holder = view.activeInputLease
    ? attached.find((item) => item.id === view.activeInputLease!.attachmentId)
    : undefined;
  if (holder?.viewport) {
    return {
      attachmentId: holder.id,
      columns: holder.viewport.columns,
      rows: holder.viewport.rows,
      source: 'input-lease-holder',
    };
  }
  const focused = [...attached].filter((item) => item.focused).sort(byMostRecent)[0]
    ?? [...attached].sort(byMostRecent)[0];
  if (!focused?.viewport) return null;
  return {
    attachmentId: focused.id,
    columns: focused.viewport.columns,
    rows: focused.viewport.rows,
    source: 'most-recently-focused',
  };
}

export interface TerminalCommands {
  openManagedTerminal(
    context: CommandContext, input: OpenManagedTerminalInput,
  ): Promise<B3Result<TerminalSession>>;

  attachController(
    context: CommandContext, input: AttachControllerInput,
  ): Promise<B3Result<ControllerAttachment>>;

  detachController(
    context: CommandContext, input: DetachControllerInput,
  ): Promise<B3Result<ControllerAttachment>>;

  acquireInputLease(
    context: CommandContext, input: AcquireInputLeaseInput,
  ): Promise<B3Result<TerminalInputLease>>;

  releaseInputLease(
    context: CommandContext, input: ReleaseInputLeaseInput,
  ): Promise<B3Result<TerminalInputLease>>;

  reserveNotificationInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: ReserveNotificationInput,
  ): Promise<B3Result<NotificationInputReservation>>;

  commitReservedNotificationInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: CommitReservedNotificationInput,
  ): Promise<B3Result<NotificationInputCommitOutcome>>;

  cancelReservedNotificationInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: CancelReservedNotificationInput,
  ): Promise<B3Result<NotificationInputReservation>>;

  setControllerDraftState(
    context: CommandContext,
    input: SetControllerDraftStateInput,
  ): Promise<B3Result<ControllerAttachment>>;

  writeInput(
    context: CommandContext, input: WriteTerminalInput,
  ): Promise<B3Result<Extract<TerminalInputAttempt, { readonly source: 'controller' }>>>;

  prepareProviderTurnInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: PrepareProviderTurnInputInput,
  ): Promise<B3Result<PrepareProviderTurnInputOutcome>>;

  executeProviderTurnInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: ExecuteProviderTurnInputInput,
  ): Promise<B3Result<ProviderTurnTerminalInputAttempt>>;

  cancelPreparedProviderTurnInput(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: CancelPreparedProviderTurnInput,
  ): Promise<B3Result<ProviderTurnTerminalInputAttempt>>;

  settleProviderTurnCompletion(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: SettleTerminalProviderTurnCompletionInput,
  ): Promise<B3Result<SettleTerminalProviderTurnCompletionOutcome>>;

  closeProviderTurnBarrierUnproven(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: CloseTerminalProviderTurnUnprovenInput,
  ): Promise<B3Result<ProviderTurnTerminalInputAttempt>>;

  resizeTerminal(
    context: CommandContext, input: ResizeTerminalInput,
  ): Promise<B3Result<TerminalSessionView>>;

  interruptTerminalTurn(
    context: SystemCommandContext<'sys_agent_runtime'>, input: InterruptTerminalTurnInput,
  ): Promise<B3Result<InterruptTerminalTurnOutcome>>;

  terminateTerminal(
    context: SystemCommandContext<'sys_agent_runtime'>, input: TerminateTerminalInput,
  ): Promise<B3Result<TerminalSession>>;
}

/**
 * The Runtime↔Terminal system seam. §13.3 requires Terminal to refuse an
 * interrupt barrier whose target turn is no longer active — which is only
 * possible if Runtime tells Terminal what the active turn is. Not a public
 * caller surface: Shell, CLI and external controllers never see it.
 */
export interface TerminalSystemSeam {
  quarantineProviderTurnInputAttempt(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: {
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly evidenceRefs: readonly string[];
    },
  ): Promise<B3Result<null>>;

  beginProviderTurn(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly activityGeneration: ActivityGeneration;
    },
  ): Promise<B3Result<null>>;

  endProviderTurn(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly providerTurnId: ProviderTurnId;
    },
  ): Promise<B3Result<null>>;

  /**
   * Which controllers the Runtime host can still see (§13.4). Terminal owns
   * attachment truth, but whether a window's connection is still open is the
   * host's fact — it holds the sockets — so the host reports and Terminal
   * decides. Anything unseen for longer than the stale window becomes `stale`;
   * `detached` stays final.
   */
  observeControllers(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: { readonly attachmentIds: readonly ControllerAttachmentId[] },
  ): Promise<B3Result<{ readonly staleAttachmentIds: readonly ControllerAttachmentId[] }>>;

  /**
   * Reconcile records left behind by a dead Runtime epoch. Terminal owns its
   * own records (§3.3), so recovery is asked for here rather than done TO it.
   */
  reconcileAfterRestart(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: { readonly activeRuntimeEpochId: RuntimeEpochId },
  ): Promise<B3Result<{ readonly reconciledSessionIds: readonly TerminalSessionId[] }>>;
}

export interface TerminalQueries {
  getTerminalSession(
    principal: AuthenticatedPrincipal, terminalSessionId: TerminalSessionId,
  ): Promise<B3Result<TerminalSessionView>>;

  listTerminalSessions(
    principal: AuthenticatedPrincipal, filter?: ListTerminalSessionsFilter,
  ): Promise<B3Result<readonly TerminalSessionView[]>>;

  listControllerAttachments(
    principal: AuthenticatedPrincipal, terminalSessionId: TerminalSessionId,
  ): Promise<B3Result<readonly ControllerAttachment[]>>;

  getTerminalInputAttempt(
    principal: AuthenticatedPrincipal,
    terminalInputAttemptId: TerminalInputAttemptId,
  ): Promise<B3Result<TerminalInputAttempt>>;

  getProviderTurnInputAttempt(
    principal: AuthenticatedPrincipal,
    input: GetProviderTurnInputAttemptInput,
  ): Promise<B3Result<ProviderTurnTerminalInputAttempt>>;

  listIncompleteProviderTurnInputAttempts(
    principal: AuthenticatedPrincipal,
    filter: IncompleteProviderTurnInputAttemptFilter,
  ): Promise<B3Result<B3Page<ProviderTurnTerminalInputAttempt>>>;

  getNotificationInputReservation(
    principal: AuthenticatedPrincipal,
    notificationInputReservationId: NotificationInputReservationId,
  ): Promise<B3Result<NotificationInputReservation>>;

  readTerminalStream(
    principal: AuthenticatedPrincipal, input: ReadTerminalStreamInput,
  ): AsyncIterable<B3Result<TerminalOutputFrame>>;
}

export type TerminalContract = TerminalCommands & TerminalQueries & {
  readonly system: TerminalSystemSeam;
  /** Release runtime-private resources. Never stops a PTY. */
  dispose(): Promise<void>;
};

export type TerminalError = B3ContractError;
