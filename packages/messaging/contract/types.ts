// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
// Source: contract/messaging-contract.json (law #3 single source of truth).
// contractVersion 1.2.0 · schemaVersion 1 · sha256:0a97cfbe52fd2ab9
// Regenerate: npm run generate
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<Name extends string> = { readonly [brand]: Name };

// --- versions & constants ------------------------------------------------
export const contractVersion = "1.2.0" as const;
export const schemaVersion = 1 as const;
export const constants = {
  "messageMaxBytes": 32768,
  "pageLimitMax": 200,
  "subscriptionBufferMax": 256
} as const;
export const templateBindablePaths = [
  "body.text",
  "body.subject",
  "body.format",
  "body.fields.<name>",
  "priority"
] as const;

// --- branded identities ----------------------------------------------------
export type PersonId = string & Brand<"PersonId">;
export type PresenceId = string & Brand<"PresenceId">;
export type ThreadId = string & Brand<"ThreadId">;
export type MessageId = string & Brand<"MessageId">;
export type DeliveryId = string & Brand<"DeliveryId">;
export type AttemptId = string & Brand<"AttemptId">;
export type TemplateId = string & Brand<"TemplateId">;
export type SnapshotId = string & Brand<"SnapshotId">;
export type AcceptanceId = string & Brand<"AcceptanceId">;
export type PolicyId = string & Brand<"PolicyId">;
export type SubscriptionId = string & Brand<"SubscriptionId">;
export type Timestamp = string & Brand<"Timestamp">;
export type Sequence = number & Brand<"Sequence">;
export type Cursor = string & Brand<"Cursor">;
export type ProviderSessionId = string & Brand<"ProviderSessionId">;
export type ProviderResumeId = string & Brand<"ProviderResumeId">;
export type TranscriptSourceId = string & Brand<"TranscriptSourceId">;
export type TranscriptLineId = string & Brand<"TranscriptLineId">;
export type IngestCheckpointId = string & Brand<"IngestCheckpointId">;
export type EventCursor = string & Brand<"EventCursor">;
export type ConversationId = string & Brand<"ConversationId">;
export type SendId = string & Brand<"SendId">;
export type SendAttemptId = string & Brand<"SendAttemptId">;
export type PendingDeliveryId = string & Brand<"PendingDeliveryId">;
export type RequestHash = string & Brand<"RequestHash">;
export type ClientMessageId = string & Brand<"ClientMessageId">;
export type Address = string & Brand<"Address">;

// --- id patterns (runtime reference for adapters/validators) ---------------
export const idPatterns = {
  PersonId: "^person_[A-Za-z0-9-]+$",
  PresenceId: "^presence_[A-Za-z0-9-]+$",
  ThreadId: "^thread_[A-Za-z0-9-]+$",
  MessageId: "^message_[A-Za-z0-9-]+$",
  DeliveryId: "^delivery_[A-Za-z0-9-]+$",
  AttemptId: "^attempt_[A-Za-z0-9-]+$",
  TemplateId: "^template_[A-Za-z0-9-]+$",
  SnapshotId: "^snapshot_[A-Za-z0-9-]+$",
  AcceptanceId: "^acceptance_[A-Za-z0-9-]+$",
  PolicyId: "^(contactpolicy|dndpolicy)_[A-Za-z0-9-]+$",
  SubscriptionId: "^subscription_[A-Za-z0-9-]+$",
  Cursor: "^s_[0-9]+$",
  ProviderSessionId: "^sess_[0-9a-f-]{36}$",
  TranscriptSourceId: "^source_[0-9a-f]{64}$",
  TranscriptLineId: "^transcriptLine_[0-9a-f]{64}$",
  IngestCheckpointId: "^ingestCheckpoint_[0-9a-f]{64}$",
  EventCursor: "^event_[0-9]+$",
  ConversationId: "^conv_[A-Za-z0-9_-]+$",
  SendId: "^send_[0-9a-f]{64}$",
  SendAttemptId: "^sendAttempt_[0-9a-f]{64}$",
  PendingDeliveryId: "^pendingDelivery_[0-9a-f]{64}$",
  RequestHash: "^[0-9a-f]{64}$",
  Address: "^(person:person_|thread:thread_)[A-Za-z0-9-]+$",
} as const;

// --- mintable id kinds (Messaging-Seams §5.1) -------------------------------
export const idPrefixes = {
  "acceptance": "acceptance_",
  "attempt": "attempt_",
  "contactpolicy": "contactpolicy_",
  "delivery": "delivery_",
  "dndpolicy": "dndpolicy_",
  "message": "message_",
  "presence": "presence_",
  "send": "send_",
  "snapshot": "snapshot_",
  "subscription": "subscription_",
  "template": "template_",
  "thread": "thread_",
} as const;
export type IdKind = keyof typeof idPrefixes;
export interface IdTypeMap {
  readonly "acceptance": AcceptanceId;
  readonly "attempt": AttemptId;
  readonly "contactpolicy": PolicyId;
  readonly "delivery": DeliveryId;
  readonly "dndpolicy": PolicyId;
  readonly "message": MessageId;
  readonly "presence": PresenceId;
  readonly "send": SendId;
  readonly "snapshot": SnapshotId;
  readonly "subscription": SubscriptionId;
  readonly "template": TemplateId;
  readonly "thread": ThreadId;
}

// --- enumerations & literal consts (collected from the contract source) -----
export const acceptanceRecordKindValue = ["acceptance"] as const; // source path: AcceptanceRecord.kind
export type AcceptanceRecordKind = (typeof acceptanceRecordKindValue)[number];
export const blockedReasonValue = ["blocked-by-contact-policy"] as const; // source path: RecipientSnapshot.blocked.reason
export type BlockedReason = (typeof blockedReasonValue)[number];
export const capabilityViewFeaturesValues = ["direct","rooms","subscribe","attention","templates"] as const; // source path: CapabilityView.features
export type CapabilityViewFeatures = (typeof capabilityViewFeaturesValues)[number];
export const contactPolicyDefaultRuleValues = ["allow","deny"] as const; // source path: ContactPolicy.defaultRule
export type ContactPolicyDefaultRule = (typeof contactPolicyDefaultRuleValues)[number];
export const contactPolicyKindValue = ["contact-policy"] as const; // source path: ContactPolicy.kind
export type ContactPolicyKind = (typeof contactPolicyKindValue)[number];
export const deliveryAttemptKindValue = ["delivery-attempt"] as const; // source path: DeliveryAttempt.kind
export type DeliveryAttemptKind = (typeof deliveryAttemptKindValue)[number];
export const deliveryAttemptOutcomeValues = ["effect","failure","superseded"] as const; // source path: DeliveryAttempt.outcome
export type DeliveryAttemptOutcome = (typeof deliveryAttemptOutcomeValues)[number];
export const deliveryKindValue = ["delivery"] as const; // source path: Delivery.kind
export type DeliveryKind = (typeof deliveryKindValue)[number];
export const deliveryStateValues = ["pending","held","delivered","failed"] as const; // source path: DeliveryState
export type DeliveryState = (typeof deliveryStateValues)[number];
export const deliveryStateReasonValues = ["blocked-by-contact-policy","retry-exhausted","transport-failure","dnd-hold","dnd-released","adapter-effect","fan-out-loser"] as const; // source path: DeliveryStateReason
export type DeliveryStateReason = (typeof deliveryStateReasonValues)[number];
export const dndPolicyKindValue = ["dnd-policy"] as const; // source path: DndPolicy.kind
export type DndPolicyKind = (typeof dndPolicyKindValue)[number];
export const grantValues = ["priority.override","policy.admin","template.write","oversight.read"] as const; // source path: Grant
export type Grant = (typeof grantValues)[number];
export const messageBodyFormatValues = ["text","markdown"] as const; // source path: MessageBody.format
export type MessageBodyFormat = (typeof messageBodyFormatValues)[number];
export const messageKindValue = ["message"] as const; // source path: Message.kind
export type MessageKind = (typeof messageKindValue)[number];
export const pendingDeliveryStateValues = ["queued","claimed","submitted-confirmed","submitted-unconfirmed","transcript-observed","failed"] as const; // source path: PendingDeliveryState
export type PendingDeliveryState = (typeof pendingDeliveryStateValues)[number];
export const policyChangedPolicyValues = ["contact","dnd"] as const; // source path: PolicyChanged.policy
export type PolicyChangedPolicy = (typeof policyChangedPolicyValues)[number];
export const presenceChangedChangeValues = ["opened","closed"] as const; // source path: PresenceChanged.change
export type PresenceChangedChange = (typeof presenceChangedChangeValues)[number];
export const presenceKindValue = ["presence"] as const; // source path: Presence.kind
export type PresenceKind = (typeof presenceKindValue)[number];
export const priorityValues = ["normal","urgent"] as const; // source path: Priority
export type Priority = (typeof priorityValues)[number];
export const providerNameValues = ["claude","codex","kimi"] as const; // source path: ProviderName
export type ProviderName = (typeof providerNameValues)[number];
export const providerSessionStatusValues = ["discovered-only","assignment-pending","adoption-pending","idle","busy","closed","failed"] as const; // source path: ProviderSessionStatus
export type ProviderSessionStatus = (typeof providerSessionStatusValues)[number];
export const providerSubmissionCertaintyValues = ["confirmed","unconfirmed"] as const; // source path: ProviderSubmissionCertainty
export type ProviderSubmissionCertainty = (typeof providerSubmissionCertaintyValues)[number];
export const recipientSnapshotKindValue = ["recipient-snapshot"] as const; // source path: RecipientSnapshot.kind
export type RecipientSnapshotKind = (typeof recipientSnapshotKindValue)[number];
export const sendAttemptStateValues = ["claimed","awaiting-session-assignment","awaiting-transcript","confirmed","failed","indeterminate"] as const; // source path: SendAttemptState
export type SendAttemptState = (typeof sendAttemptStateValues)[number];
export const sendStateValues = ["accepted","dispatching","awaiting-session-assignment","awaiting-transcript","confirmed","failed","indeterminate"] as const; // source path: SendState
export type SendState = (typeof sendStateValues)[number];
export const setContactPolicyInputDefaultRuleValues = ["allow","deny"] as const; // source path: SetContactPolicyInput.defaultRule
export type SetContactPolicyInputDefaultRule = (typeof setContactPolicyInputDefaultRuleValues)[number];
export const subscribeInputEventsValues = ["MessageCommitted","DeliveryUpdated","PresenceChanged","PolicyChanged"] as const; // source path: SubscribeInput.events
export type SubscribeInputEvents = (typeof subscribeInputEventsValues)[number];
export const subscriptionEndedKindValue = ["ended"] as const; // source path: SubscriptionMessage.Ended.kind
export type SubscriptionEndedKind = (typeof subscriptionEndedKindValue)[number];
export const subscriptionEndedReasonValues = ["overflow","closed","auth-lost","dependency-lost"] as const; // source path: SubscriptionMessage.Ended.reason
export type SubscriptionEndedReason = (typeof subscriptionEndedReasonValues)[number];
export const subscriptionEventFrameKindValue = ["event"] as const; // source path: SubscriptionMessage.Event.kind
export type SubscriptionEventFrameKind = (typeof subscriptionEventFrameKindValue)[number];
export const subscriptionStartedKindValue = ["started"] as const; // source path: SubscriptionMessage.Started.kind
export type SubscriptionStartedKind = (typeof subscriptionStartedKindValue)[number];
export const templateKindValue = ["template"] as const; // source path: Template.kind
export type TemplateKind = (typeof templateKindValue)[number];
export const threadKindValues = ["direct","team","mission"] as const; // source path: Thread.threadKind
export type ThreadKind = (typeof threadKindValues)[number];
export const threadRecordKindValue = ["thread"] as const; // source path: Thread.kind
export type ThreadRecordKind = (typeof threadRecordKindValue)[number];
export const transcriptEventKindValues = ["provider-session.registered","transcript-line.appended"] as const; // source path: TranscriptEventKind
export type TranscriptEventKind = (typeof transcriptEventKindValues)[number];
export const transcriptRoleValues = ["user","assistant","system","hook","tool","tool_call","tool_result","attachment"] as const; // source path: TranscriptRole
export type TranscriptRole = (typeof transcriptRoleValues)[number];
export const transportKindValues = ["ws","pty"] as const; // source path: TransportKind
export type TransportKind = (typeof transportKindValues)[number];

// --- operation / event / error name catalogues -----------------------------
export const commandNames = ["OpenPresence","ClosePresence","SendMessage","SendFromTemplate","SetDndPolicy","SetContactPolicy","UpsertTemplate","RetireTemplate"] as const;
export type CommandName = (typeof commandNames)[number];
export const queryNames = ["GetThread","ListThreadsForPerson","GetMessages","GetInbox","GetDelivery","GetPolicy","ListTemplates","GetPresence","GetCapabilities"] as const;
export type QueryName = (typeof queryNames)[number];
export const eventNames = ["MessageCommitted","DeliveryUpdated","PresenceChanged","PolicyChanged"] as const;
export type EventName = (typeof eventNames)[number];
export const subscriptionNames = ["Subscribe"] as const;
export type SubscriptionName = (typeof subscriptionNames)[number];

// --- error catalogue (13 errors; RateLimited is forward-reserved) -----------
export const errorCatalogue = [
  { name: "NotAuthenticated", retryable: false, reserved: false },
  { name: "NotAuthorized", retryable: false, reserved: false },
  { name: "UnknownRecipient", retryable: false, reserved: false },
  { name: "UnknownThread", retryable: false, reserved: false },
  { name: "UnknownMessage", retryable: false, reserved: false },
  { name: "BlockedByContactPolicy", retryable: false, reserved: false },
  { name: "ValidationFailed", retryable: false, reserved: false },
  { name: "TemplateNotFound", retryable: false, reserved: false },
  { name: "TemplateFieldMismatch", retryable: false, reserved: false },
  { name: "VersionUnsupported", retryable: false, reserved: false },
  { name: "RateLimited", retryable: true, reserved: true },
  { name: "IdempotencyConflict", retryable: false, reserved: false },
  { name: "DependencyUnavailable", retryable: false, reserved: false },
] as const;
export type ErrorName = (typeof errorCatalogue)[number]["name"];

/**
 * The public error type. One umbrella class; the name discriminates.
 * Field shapes per error are the *Fields interfaces in ./errors.ts.
 */
export class MessagingError extends Error {
  override readonly name: ErrorName;
  readonly retryable: boolean;
  readonly fields: Record<string, unknown>;
  constructor(
    name: ErrorName,
    options?: { message?: string; retryable?: boolean; fields?: Record<string, unknown> },
  ) {
    super(options?.message ?? name);
    this.name = name;
    const catalogueEntry = errorCatalogue.find((entry) => entry.name === name);
    this.retryable = options?.retryable ?? catalogueEntry?.retryable ?? false;
    this.fields = options?.fields ?? {};
  }
}

// --- R5 delivery state machine ---------------------------------------------
export const deliveryTriggerValues = ["dnd-active","adapter-effect","policy-blocked","retry-exhausted","transport-permanent-failure","dnd-released","in-flight-effect"] as const;
export type DeliveryTrigger = (typeof deliveryTriggerValues)[number];
export interface DeliveryTransition {
  readonly from: DeliveryState;
  readonly to: DeliveryState;
  readonly trigger: DeliveryTrigger;
  readonly reason: DeliveryStateReason;
}
export const deliveryStateMachine: {
  readonly initial: DeliveryState;
  readonly terminal: readonly DeliveryState[];
  readonly transitions: readonly DeliveryTransition[];
} = {
  initial: "pending",
  terminal: ["delivered","failed"],
  transitions: [
    { from: "pending", to: "held", trigger: "dnd-active", reason: "dnd-hold" },
    { from: "pending", to: "delivered", trigger: "adapter-effect", reason: "adapter-effect" },
    { from: "pending", to: "failed", trigger: "policy-blocked", reason: "blocked-by-contact-policy" },
    { from: "pending", to: "failed", trigger: "retry-exhausted", reason: "retry-exhausted" },
    { from: "pending", to: "failed", trigger: "transport-permanent-failure", reason: "transport-failure" },
    { from: "held", to: "pending", trigger: "dnd-released", reason: "dnd-released" },
    { from: "held", to: "delivered", trigger: "in-flight-effect", reason: "adapter-effect" },
  ],
};

// --- cursor codec (Store-Seam §3: opaque "s_<n>" wrapping the sequence) -----
export function cursorFor(sequence: Sequence): Cursor {
  return `s_${sequence}` as Cursor;
}
