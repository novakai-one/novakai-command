// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
// Source: contract/messaging-contract.json (law #3 single source of truth).
// contractVersion 1.1.0 · schemaVersion 1 · sha256:6df08803e3e2c3eb
// Regenerate: npm run generate
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<Name extends string> = { readonly [brand]: Name };

// --- versions & constants ------------------------------------------------
export const contractVersion = "1.1.0" as const;
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
  readonly "snapshot": SnapshotId;
  readonly "subscription": SubscriptionId;
  readonly "template": TemplateId;
  readonly "thread": ThreadId;
}

// --- enumerations & literal consts (collected from the contract source) -----
// source path: AcceptanceRecord.kind
export const acceptanceRecordKindValue = ["acceptance"] as const;
export type AcceptanceRecordKind = (typeof acceptanceRecordKindValue)[number];
// source path: RecipientSnapshot.blocked.reason
export const blockedReasonValue = ["blocked-by-contact-policy"] as const;
export type BlockedReason = (typeof blockedReasonValue)[number];
// source path: CapabilityView.features
export const capabilityViewFeaturesValues = ["direct","rooms","subscribe","attention","templates"] as const;
export type CapabilityViewFeatures = (typeof capabilityViewFeaturesValues)[number];
// source path: ContactPolicy.defaultRule
export const contactPolicyDefaultRuleValues = ["allow","deny"] as const;
export type ContactPolicyDefaultRule = (typeof contactPolicyDefaultRuleValues)[number];
// source path: ContactPolicy.kind
export const contactPolicyKindValue = ["contact-policy"] as const;
export type ContactPolicyKind = (typeof contactPolicyKindValue)[number];
// source path: DeliveryAttempt.kind
export const deliveryAttemptKindValue = ["delivery-attempt"] as const;
export type DeliveryAttemptKind = (typeof deliveryAttemptKindValue)[number];
// source path: DeliveryAttempt.outcome
export const deliveryAttemptOutcomeValues = ["effect","failure","superseded"] as const;
export type DeliveryAttemptOutcome = (typeof deliveryAttemptOutcomeValues)[number];
// source path: Delivery.kind
export const deliveryKindValue = ["delivery"] as const;
export type DeliveryKind = (typeof deliveryKindValue)[number];
// source path: DeliveryState
export const deliveryStateValues = ["pending","held","delivered","failed"] as const;
export type DeliveryState = (typeof deliveryStateValues)[number];
// source path: DeliveryStateReason
export const deliveryStateReasonValues = ["blocked-by-contact-policy","retry-exhausted","transport-failure","dnd-hold","dnd-released","adapter-effect","fan-out-loser"] as const;
export type DeliveryStateReason = (typeof deliveryStateReasonValues)[number];
// source path: DndPolicy.kind
export const dndPolicyKindValue = ["dnd-policy"] as const;
export type DndPolicyKind = (typeof dndPolicyKindValue)[number];
// source path: Grant
export const grantValues = ["priority.override","policy.admin","template.write","oversight.read"] as const;
export type Grant = (typeof grantValues)[number];
// source path: MessageBody.format
export const messageBodyFormatValues = ["text","markdown"] as const;
export type MessageBodyFormat = (typeof messageBodyFormatValues)[number];
// source path: Message.kind
export const messageKindValue = ["message"] as const;
export type MessageKind = (typeof messageKindValue)[number];
// source path: PolicyChanged.policy
export const policyChangedPolicyValues = ["contact","dnd"] as const;
export type PolicyChangedPolicy = (typeof policyChangedPolicyValues)[number];
// source path: PresenceChanged.change
export const presenceChangedChangeValues = ["opened","closed"] as const;
export type PresenceChangedChange = (typeof presenceChangedChangeValues)[number];
// source path: Presence.kind
export const presenceKindValue = ["presence"] as const;
export type PresenceKind = (typeof presenceKindValue)[number];
// source path: Priority
export const priorityValues = ["normal","urgent"] as const;
export type Priority = (typeof priorityValues)[number];
// source path: ProviderName
export const providerNameValues = ["claude","codex","kimi"] as const;
export type ProviderName = (typeof providerNameValues)[number];
// source path: ProviderSessionStatus
export const providerSessionStatusValues = ["discovered-only","assignment-pending","adoption-pending","idle","busy","closed","failed"] as const;
export type ProviderSessionStatus = (typeof providerSessionStatusValues)[number];
// source path: RecipientSnapshot.kind
export const recipientSnapshotKindValue = ["recipient-snapshot"] as const;
export type RecipientSnapshotKind = (typeof recipientSnapshotKindValue)[number];
// source path: SetContactPolicyInput.defaultRule
export const setContactPolicyInputDefaultRuleValues = ["allow","deny"] as const;
export type SetContactPolicyInputDefaultRule = (typeof setContactPolicyInputDefaultRuleValues)[number];
// source path: SubscribeInput.events
export const subscribeInputEventsValues = ["MessageCommitted","DeliveryUpdated","PresenceChanged","PolicyChanged"] as const;
export type SubscribeInputEvents = (typeof subscribeInputEventsValues)[number];
// source path: SubscriptionMessage.Ended.kind
export const subscriptionEndedKindValue = ["ended"] as const;
export type SubscriptionEndedKind = (typeof subscriptionEndedKindValue)[number];
// source path: SubscriptionMessage.Ended.reason
export const subscriptionEndedReasonValues = ["overflow","closed","auth-lost","dependency-lost"] as const;
export type SubscriptionEndedReason = (typeof subscriptionEndedReasonValues)[number];
// source path: SubscriptionMessage.Event.kind
export const subscriptionEventFrameKindValue = ["event"] as const;
export type SubscriptionEventFrameKind = (typeof subscriptionEventFrameKindValue)[number];
// source path: SubscriptionMessage.Started.kind
export const subscriptionStartedKindValue = ["started"] as const;
export type SubscriptionStartedKind = (typeof subscriptionStartedKindValue)[number];
// source path: Template.kind
export const templateKindValue = ["template"] as const;
export type TemplateKind = (typeof templateKindValue)[number];
// source path: Thread.threadKind
export const threadKindValues = ["direct","team","mission"] as const;
export type ThreadKind = (typeof threadKindValues)[number];
// source path: Thread.kind
export const threadRecordKindValue = ["thread"] as const;
export type ThreadRecordKind = (typeof threadRecordKindValue)[number];
// source path: TranscriptEventKind
export const transcriptEventKindValues = ["provider-session.registered","transcript-line.appended"] as const;
export type TranscriptEventKind = (typeof transcriptEventKindValues)[number];
// source path: TranscriptRole
export const transcriptRoleValues = ["user","assistant","system","hook","tool","tool_call","tool_result","attachment"] as const;
export type TranscriptRole = (typeof transcriptRoleValues)[number];
// source path: TransportKind
export const transportKindValues = ["ws","pty"] as const;
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
