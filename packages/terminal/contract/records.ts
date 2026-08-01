// Terminal durable records (B3V4-P2 §7).
//
// Terminal writes these four kinds and nothing else, through one Foundation
// scoped handle. It never opens a JSONL file (§18.2).
import type {
  ActivityGeneration, AgentRunId, B3PrincipalId, ControllerAttachmentId, IsoUtc,
  LeaseGeneration, ProviderTurnId, RecordEnvelope, RuntimeEpochId,
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
  readonly runtimeEpochId: RuntimeEpochId;
  /** Opaque to every caller: PIDs and socket paths are not public facts. */
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

export type ControllerKind = 'novakai-shell' | 'external-terminal' | 'script' | 'operations';

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

export type TerminalInputKind = 'text' | 'raw-control-c' | 'message-delivery';

export type TerminalInputOutcome =
  | 'accepted' | 'submitted-confirmed' | 'submitted-unconfirmed' | 'rejected';

export interface TerminalInputAttempt
  extends RecordEnvelope<TerminalInputAttemptId, 'terminalInputAttempt'> {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: ControllerAttachmentId;
  readonly leaseGeneration: LeaseGeneration;
  readonly inputSequence: number;
  /** The bytes themselves are never durable: terminal input is not chat. */
  readonly payloadDigest: string;
  readonly kindOfInput: TerminalInputKind;
  readonly outcome: TerminalInputOutcome;
}

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
