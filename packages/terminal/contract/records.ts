// Terminal durable records (B3V4-P2 §7).
//
// Terminal writes these four kinds and nothing else, through one Foundation
// scoped handle. It never opens a JSONL file (§18.2).
import type {
  ActivityGeneration, AgentRunId, B3PrincipalId, CommandReceiptId,
  ControllerAttachmentId, IsoUtc, LeaseGeneration, NotificationId,
  NotificationInputReservationId, ProviderTurnId, RecordEnvelope, RuntimeEpochId,
  TerminalInputAttemptId, TerminalInputLeaseId, TerminalSessionId,
} from '@novakai/foundation/contract';

export type TerminalSessionStatus =
  | 'reserved' | 'starting' | 'live' | 'exited' | 'failed' | 'recovery-required';

/** Who the session belongs to. A plain shell has no Agent Run behind it. */
export type TerminalSessionOwner =
  | { readonly kind: 'plain-shell'; readonly shellInstanceId: string }
  | { readonly kind: 'agent-run'; readonly agentRunId: AgentRunId };

export interface TerminalSession extends RecordEnvelope<TerminalSessionId, 'terminalSession'> {
  readonly owner: TerminalSessionOwner;
  readonly status: TerminalSessionStatus;
  /** Identifies WHAT was launched, so a recovering runtime can tell whether a
   *  surviving process is the same session or a different one. */
  readonly launchFingerprint: string;
  /**
   * The open command that owns this session — §13.5's deterministic effect key.
   * It is what lets a retry find the PTY its own earlier attempt started, so a
   * repeated open adopts or reports recovery instead of spawning a second one.
   */
  readonly launchOperationId: CommandReceiptId;
  readonly runtimeEpochId: RuntimeEpochId;
  /**
   * Opaque to every caller: PIDs and socket paths are not public facts. Empty
   * until a launch actually returns a process — an empty ref is the durable
   * statement "nothing was ever owned here", not "we lost it".
   */
  readonly privateProcessRef: string;
  readonly workingDirectory: string;
  readonly openedAt?: IsoUtc;
  readonly exitedAt?: IsoUtc;
  readonly exitCode?: number;
  readonly signal?: string;
  /**
   * Durable CHECKPOINT of the output stream, not a per-byte counter. Output
   * bytes are an ordered bounded stream, never permanent history (§7), so the
   * live counter is runtime-private and only lifecycle transitions persist it.
   */
  readonly outputSequence: number;
  readonly earliestReplaySequence: number;
}

/** One list, so the type and the runtime validator can never disagree (§4.2). */
export const CONTROLLER_KINDS = [
  'novakai-shell', 'external-terminal', 'script', 'operations',
] as const;

export type ControllerKind = typeof CONTROLLER_KINDS[number];

export interface ControllerAttachment
  extends RecordEnvelope<ControllerAttachmentId, 'controllerAttachment'> {
  readonly terminalSessionId: TerminalSessionId;
  readonly controllerKind: ControllerKind;
  readonly principalId: B3PrincipalId;
  readonly connectedAt: IsoUtc;
  readonly lastSeenAt: IsoUtc;
  readonly focused: boolean;
  readonly viewport?: { readonly columns: number; readonly rows: number };
  readonly state: 'attached' | 'detached' | 'stale';
  /** Controller-owned composer truth; a present draft fences system delivery. */
  readonly draftState: 'empty' | 'present';
  readonly draftGeneration: number;
}

export type LeaseEndedReason =
  | 'released' | 'expired' | 'takeover' | 'runtime-interrupt' | 'session-final';

export interface TerminalInputLease
  extends RecordEnvelope<TerminalInputLeaseId, 'terminalInputLease'> {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly generation: LeaseGeneration;
  readonly expiresAt: IsoUtc;
  readonly state: 'active' | 'released' | 'expired' | 'revoked';
  readonly endedReason?: LeaseEndedReason;
}

export const TERMINAL_INPUT_KINDS = ['text', 'raw-control-c', 'message-delivery'] as const;

export type TerminalInputKind = typeof TERMINAL_INPUT_KINDS[number];

export type TerminalInputOutcome =
  | 'accepted' | 'submitted-confirmed' | 'submitted-unconfirmed' | 'rejected';

export type TerminalInputAttempt = RecordEnvelope<
  TerminalInputAttemptId, 'terminalInputAttempt'
> & (
  | {
      readonly source: 'controller';
      readonly terminalSessionId: TerminalSessionId;
      readonly attachmentId: ControllerAttachmentId;
      readonly leaseGeneration: LeaseGeneration;
      readonly inputSequence: number;
      /** The bytes themselves are never durable: terminal input is not chat. */
      readonly payloadDigest: string;
      readonly kindOfInput: TerminalInputKind;
      readonly outcome: TerminalInputOutcome;
    }
  | {
      readonly source: 'system-notification';
      readonly terminalSessionId: TerminalSessionId;
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly deliveryEffectKey: string;
      readonly providerTurnId: ProviderTurnId;
      readonly attachmentId?: never;
      readonly leaseGeneration?: never;
      readonly inputSequence: number;
      readonly payloadDigest: string;
      readonly kindOfInput: 'message-delivery';
      readonly outcome: 'submitted-confirmed' | 'submitted-unconfirmed';
      readonly submittedAt: IsoUtc;
    }
);

/** Terminal's durable keyboard fence for one deterministic Notification effect. */
export type NotificationInputReservation = RecordEnvelope<
  NotificationInputReservationId, 'notificationInputReservation'
> & {
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly notificationId: NotificationId;
  readonly deliveryEffectKey: string;
  readonly expectedActivityGeneration: ActivityGeneration;
  readonly inputTextDigest: string;
  readonly providerTurnId: ProviderTurnId;
} & (
  | {
      readonly state: 'reserved';
      readonly terminalInputAttemptId?: never;
      readonly endedAt?: never;
      readonly cancelReason?: never;
    }
  | {
      readonly state: 'cancelled';
      readonly terminalInputAttemptId?: never;
      readonly endedAt: IsoUtc;
      readonly cancelReason: 'supervision-claim-rejected' | 'runtime-compensation';
    }
  | {
      readonly state: 'committed';
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly endedAt: IsoUtc;
      readonly cancelReason?: never;
    }
);

/**
 * The turn a lifecycle interrupt may target. Terminal does not own Run
 * activity (Agent Runtime does), so Runtime tells Terminal which turn is
 * currently active; §13.3 then requires Terminal to refuse a barrier against
 * any other tuple.
 */
export interface ActiveProviderTurn {
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly agentRunId: AgentRunId;
}
