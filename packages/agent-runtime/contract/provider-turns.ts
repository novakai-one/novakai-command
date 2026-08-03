/* eslint-disable max-lines -- The frozen provider-turn aggregate is specified as one contract. */

import type {
  ActivityGeneration,
  AgentRunId,
  B3Page,
  ClientOpId,
  ControllerAttachmentId,
  EventCursor,
  IsoUtc,
  LeaseGeneration,
  B3PrincipalId,
  ProviderSessionId,
  ProviderUsageEvidenceId,
  ProviderTurnId,
  ProviderTurnSubmissionId,
  ProviderTurnSubmissionSource,
  RecordEnvelope,
  RecordVersion,
  RuntimeEpochId,
  TerminalInputAttemptId,
  TerminalInputLeaseId,
  TerminalSessionId,
  TranscriptBindingId,
  TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';

export type ProviderTurnSubmissionOrigin =
  | {
      readonly kind: 'controller';
      readonly attachmentId: ControllerAttachmentId;
      readonly inputLeaseId: TerminalInputLeaseId;
      readonly leaseGeneration: LeaseGeneration;
      readonly inputSequence: number;
      readonly requestingPrincipalId: B3PrincipalId;
    }
  | {
      readonly kind: 'runtime-effect';
      readonly source: ProviderTurnSubmissionSource;
      readonly sourceEffectKey: string;
      readonly sourceObjectRef: string;
      readonly requestingSystemPrincipalId: 'sys_agent_runtime';
    };

export type ProviderTurnRecoverableLogicalInput =
  | { readonly kind: 'controller-replay-only' }
  | { readonly kind: 'runtime-effect-snapshot'; readonly utf8Text: string };

export interface ProviderTurnActivationTarget {
  readonly expectedRunRecordVersion: RecordVersion;
  readonly providerTurnId: ProviderTurnId;
  /** Reserved post-activation generation. */
  readonly activityGeneration: ActivityGeneration;
}

export type ProviderTurnActivation =
  | { readonly state: 'pending' }
  | {
      readonly state: 'committed';
      readonly committedRunRecordVersion: RecordVersion;
      readonly activatedAt: IsoUtc;
    };

export type ProviderTurnSubmissionState =
  | {
      readonly kind: 'queued';
      readonly queuedAt: IsoUtc;
      readonly deliveryAttemptOrdinal: number;
      readonly lastBlockingReason?:
        | 'active-input-lease'
        | 'controller-draft'
        | 'active-provider-turn';
    }
  | {
      readonly kind: 'prepared';
      readonly preparedAt: IsoUtc;
      readonly deliveryAttemptOrdinal: number;
      readonly activation: Extract<ProviderTurnActivation, { readonly state: 'pending' }>;
    }
  | {
      readonly kind: 'submitted-confirmed';
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly submittedAt: IsoUtc;
      readonly activation: ProviderTurnActivation;
    }
  | {
      readonly kind: 'submitted-unconfirmed';
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly submittedAt: IsoUtc;
      readonly uncertaintyReason: string;
      readonly activation: ProviderTurnActivation;
    }
  | {
      readonly kind: 'completed';
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly submissionDisposition: 'submitted-confirmed' | 'submitted-unconfirmed';
      readonly activationActivityGeneration: ActivityGeneration;
      readonly completionActivityGeneration: ActivityGeneration;
      readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
      readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
      readonly terminalAttemptRecordVersion: RecordVersion;
      readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
      readonly completedRunRecordVersion: RecordVersion;
      readonly completedAt: IsoUtc;
    }
  | {
      readonly kind: 'rejected';
      readonly rejectedAt: IsoUtc;
      readonly terminalInputAttemptId?: TerminalInputAttemptId;
      readonly reason: string;
      readonly effectEscaped: false;
      readonly evidenceRefs?: readonly string[];
    }
  | {
      readonly kind: 'recovery-required';
      readonly enteredAt: IsoUtc;
      readonly lastSafeState:
        | 'queued'
        | 'prepared'
        | 'submitted-confirmed'
        | 'submitted-unconfirmed';
      readonly terminalInputAttemptId?: TerminalInputAttemptId;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'completion-unproven-final';
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly closedAt: IsoUtc;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
      readonly runFinalReason: 'unrecoverable-failure';
    };

export interface ProviderTurnSubmission extends RecordEnvelope<
  ProviderTurnSubmissionId,
  'providerTurnSubmission'
> {
  readonly providerTurnId: ProviderTurnId;
  readonly agentRunId: AgentRunId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerConversationId: string | null;
  readonly terminalSessionId: TerminalSessionId;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly runtimeEpochId: RuntimeEpochId;
  readonly submissionEffectKey: string;
  readonly inputDigest: string;
  readonly recoverableLogicalInput: ProviderTurnRecoverableLogicalInput;
  readonly startTranscriptWatermark: string | null;
  readonly activationTarget: ProviderTurnActivationTarget;
  readonly origin: ProviderTurnSubmissionOrigin;
  readonly state: ProviderTurnSubmissionState;
}

export interface ProviderTurnOperationFence {
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnSubmissionId: ProviderTurnSubmissionId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly commandClientOpId: ClientOpId;
  readonly submissionEffectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly controllerResumeDeadlineAt?: IsoUtc;
  readonly acquiredAt: IsoUtc;
  readonly phase:
    | 'terminal-prepared'
    | 'submission-prepared'
    | 'activating'
    | 'active'
    | 'completing'
    | 'completion-barrier-committed'
    | 'recovery-required';
}

export interface CompletedProviderTurnDisposition {
  readonly providerTurnId: ProviderTurnId;
  readonly activationActivityGeneration: ActivityGeneration;
  readonly completionActivityGeneration: ActivityGeneration;
  readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
  readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly terminalAttemptRecordVersion: RecordVersion;
  readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
  readonly completedAt: IsoUtc;
}

export interface ControllerProviderTurnSubmitInput {
  readonly kind: 'controller';
  readonly agentRunId: AgentRunId;
  readonly terminalSessionId: TerminalSessionId;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly attachmentId: ControllerAttachmentId;
  readonly inputLeaseId: TerminalInputLeaseId;
  readonly leaseGeneration: LeaseGeneration;
  readonly expectedNextInputSequence: number;
  readonly utf8Text: string;
}

export interface SystemProviderTurnSubmitInput {
  readonly kind: 'runtime-effect';
  readonly source: ProviderTurnSubmissionSource;
  readonly sourceEffectKey: string;
  readonly sourceObjectRef: string;
  readonly agentRunId: AgentRunId;
  readonly terminalSessionId: TerminalSessionId;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly utf8Text: string;
}

export type ProviderTurnSubmitInput =
  | ControllerProviderTurnSubmitInput
  | SystemProviderTurnSubmitInput;

export type ProviderTurnSubmitOutcome =
  | {
      readonly kind: 'queued-not-yet-safe';
      readonly submissionEffectKey: string;
      readonly blocking:
        | { readonly kind: 'active-input-lease'; readonly leaseId: TerminalInputLeaseId }
        | { readonly kind: 'controller-draft' }
        | { readonly kind: 'active-provider-turn' };
      readonly submission: ProviderTurnSubmission;
      readonly retryable: true;
      readonly providerEffectCreated: false;
    }
  | {
      readonly kind: 'submitted-confirmed';
      readonly submission: ProviderTurnSubmission;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly activeTuple: ProviderTurnActivationTarget;
    }
  | {
      readonly kind: 'submitted-unconfirmed';
      readonly submission: ProviderTurnSubmission;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly activeTuple: ProviderTurnActivationTarget;
      readonly retryForbidden: true;
    }
  | {
      readonly kind: 'not-submitted';
      readonly submission: ProviderTurnSubmission;
      readonly effectEscaped: false;
    };

export interface ProviderTurnSubmissionFilter {
  readonly agentRunId?: AgentRunId;
  readonly providerSessionId?: ProviderSessionId;
  readonly states?: readonly ProviderTurnSubmissionState['kind'][];
  readonly includeTerminal: boolean;
  readonly cursor?: EventCursor;
  readonly limit: number;
}

export interface CompleteProviderTurnInput {
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly expectedActiveTuple: {
    readonly providerTurnId: ProviderTurnId;
    readonly activityGeneration: ActivityGeneration;
  };
  readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
  readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
}

export interface CompletedProviderTurnOutcome {
  readonly kind: 'completed';
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly activationActivityGeneration: ActivityGeneration;
  readonly completionActivityGeneration: ActivityGeneration;
  readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
  readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly terminalAttemptRecordVersion: RecordVersion;
  readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
}

export type CompleteProviderTurnOutcome =
  | CompletedProviderTurnOutcome
  | { readonly kind: 'already-completed-by-same-evidence'; readonly original: CompletedProviderTurnOutcome }
  | {
      readonly kind: 'evidence-not-yet-available';
      readonly missing: readonly ('transcript' | 'agents')[];
      readonly retryable: true;
    }
  | {
      readonly kind: 'completion-boundary-unproven';
      readonly status: 'uncertain' | 'unavailable';
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'lineage-evidence-mismatch';
      readonly owner: 'runtime' | 'transcript' | 'agents';
      readonly expected: Readonly<Record<string, string>>;
      readonly actual: Readonly<Record<string, string | null>>;
      readonly retryable: false;
    }
  | {
      readonly kind: 'target-changed';
      readonly expectedTuple: CompleteProviderTurnInput['expectedActiveTuple'];
      readonly actualTuple: {
        readonly providerTurnId?: ProviderTurnId;
        readonly activityGeneration: ActivityGeneration;
      };
      readonly inputLeaseChanged: false;
      readonly retryable: false;
    }
  | {
      readonly kind: 'run-final';
      readonly agentRunId: AgentRunId;
      readonly lifecycle: 'stopped' | 'failed' | 'interrupted';
      readonly retryable: false;
    };

export interface CloseProviderTurnCompletionUnprovenInput {
  readonly agentRunId: AgentRunId;
  readonly providerTurnId: ProviderTurnId;
  readonly expectedActiveTuple?: {
    readonly providerTurnId: ProviderTurnId;
    readonly activityGeneration: ActivityGeneration;
  };
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
  readonly reason: string;
  readonly completionEvidenceRefs: readonly [string, ...string[]];
}

export type CloseProviderTurnCompletionUnprovenOutcome =
  | {
      readonly kind: 'provider-still-live-or-unknown';
      readonly terminalLiveness: 'live' | 'unknown' | 'final';
      readonly providerLiveness: 'live' | 'unknown' | 'final';
      readonly bothFinal: false;
      readonly retryable: true;
      readonly runChanged: false;
    }
  | {
      readonly kind: 'submission-rejected-no-effect';
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly submission: ProviderTurnSubmission;
      readonly terminalInputAttemptId?: TerminalInputAttemptId;
      readonly effectEscaped: false;
      readonly terminalReservationCancelled: boolean;
      readonly runFenceCleared: boolean;
      readonly runActivityChanged: false;
      readonly completionClaimed: false;
    }
  | {
      readonly kind: 'run-finalised-completion-unproven';
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly lifecycle: 'failed';
      readonly activity: 'unknown';
      readonly finalReason: 'unrecoverable-failure';
      readonly completionClaimed: false;
    };

export type ProviderTurnSubmissionPage = B3Page<ProviderTurnSubmission>;
