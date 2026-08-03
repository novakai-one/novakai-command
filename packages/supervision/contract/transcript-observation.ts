import type {
  AgentRunId,
  B3Result,
  ProviderSessionId,
  ProviderTurnId,
  RecordVersion,
  SystemCommandContext,
  TerminalInputAttemptId,
  TranscriptBindingId,
  TranscriptLineId,
} from '@novakai/foundation/contract';
import type { NotificationId } from './identifiers.js';
import type { Notification } from './records.js';

/** Durable positive evidence for the exact provider-visible delivery turn (Q11). */
export interface TranscriptDeliveryEvidence {
  readonly bindingId: TranscriptBindingId;
  readonly transcriptLineId: TranscriptLineId;
  readonly agentRunId: AgentRunId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly sourcePosition: string;
  readonly sourceDigest: string;
  readonly logicalInputDigest: string;
}

/** Durable negative closure for one exact provider delivery turn (Q11). */
export interface TranscriptDeliveryNonObservationEvidence {
  readonly bindingId: TranscriptBindingId;
  readonly agentRunId: AgentRunId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly reason:
    | 'complete-for-turn'
    | 'final-source-missing'
    | 'final-source-corrupt';
  readonly sourceDiscoveryState: 'bound' | 'missing' | 'corrupt';
  readonly completeThroughWatermark?: string;
  readonly evidenceRefs: readonly string[];
}

/** Transcript's exact-CAS positive observation command input (Q11). */
export interface RecordNotificationTranscriptObservationInput {
  readonly notificationId: NotificationId;
  readonly expectedRecordVersion: RecordVersion;
  readonly expectedEffectKey: string;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly evidence: TranscriptDeliveryEvidence;
}

/** Transcript's exact-CAS durable non-observation command input (Q11). */
export interface RecordNotificationTranscriptNonObservationInput {
  readonly notificationId: NotificationId;
  readonly expectedRecordVersion: RecordVersion;
  readonly expectedEffectKey: string;
  readonly evidence: TranscriptDeliveryNonObservationEvidence;
}

/** The two Transcript-owned Q11 commands merged into SupervisionCommands. */
export interface NotificationTranscriptCommands {
  recordNotificationTranscriptObservation(context: SystemCommandContext<'sys_transcript'>, input: RecordNotificationTranscriptObservationInput): Promise<B3Result<Notification>>;
  recordNotificationTranscriptNonObservation(context: SystemCommandContext<'sys_transcript'>, input: RecordNotificationTranscriptNonObservationInput): Promise<B3Result<Notification>>;
}
