// The Terminal public contract (B3V4-P2 §12.3). This is the only door.
//
// Callers never learn a PID, a socket path, or how replay is buffered. What
// they get is: a session, who is attached, who may type, an ordered stream,
// and typed failure.
import type {
  ActivityGeneration, AgentRunId, AuthenticatedPrincipal, B3ContractError,
  B3Result, CommandContext, ControllerAttachmentId, LeaseGeneration,
  ProviderTurnId, RuntimeEpochId, SystemCommandContext, TerminalInputLeaseId,
  TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  ControllerAttachment, ControllerKind, TerminalInputAttempt, TerminalInputKind,
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

export interface WriteTerminalInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly inputLeaseId: TerminalInputLeaseId;
  readonly leaseGeneration: LeaseGeneration;
  readonly expectedNextInputSequence: number;
  readonly kindOfInput: TerminalInputKind;
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
}

export interface ListTerminalSessionsFilter {
  readonly state?: 'live' | 'final' | 'all';
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
  const focused = [...attached]
    .filter((item) => item.focused)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0]
    ?? [...attached].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
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

  writeInput(
    context: CommandContext, input: WriteTerminalInput,
  ): Promise<B3Result<TerminalInputAttempt>>;

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
