// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
// Source: contract/messaging-contract.json (law #3 single source of truth).
// contractVersion 1.2.0 · schemaVersion 1 · sha256:8c7c35709437e41f
// Regenerate: npm run generate
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<Name extends string> = { readonly [brand]: Name };

// --- versions & constants ------------------------------------------------
export const contractVersion = "1.2.0" as const;
export const schemaVersion = 1 as const;

// --- branded identities ----------------------------------------------------
export type Timestamp = string & Brand<"Timestamp">;
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

// --- id patterns (runtime reference for adapters/validators) ---------------
export const idPatterns = {
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
} as const;

// --- mintable id kinds ------------------------------------------------------
export const idPrefixes = {
  "send": "send_",
} as const;
export type IdKind = keyof typeof idPrefixes;
export interface IdTypeMap {
  readonly "send": SendId;
}

// --- enumerations & literal consts (collected from the contract source) -----
export const pendingDeliveryStateValues = ["queued","claimed","submitted-confirmed","submitted-unconfirmed","transcript-observed","failed"] as const; // source path: PendingDeliveryState
export type PendingDeliveryState = (typeof pendingDeliveryStateValues)[number];
export const providerNameValues = ["claude","codex","kimi"] as const; // source path: ProviderName
export type ProviderName = (typeof providerNameValues)[number];
export const providerSessionStatusValues = ["discovered-only","assignment-pending","adoption-pending","idle","busy","closed","failed"] as const; // source path: ProviderSessionStatus
export type ProviderSessionStatus = (typeof providerSessionStatusValues)[number];
export const providerSubmissionCertaintyValues = ["confirmed","unconfirmed"] as const; // source path: ProviderSubmissionCertainty
export type ProviderSubmissionCertainty = (typeof providerSubmissionCertaintyValues)[number];
export const sendAttemptStateValues = ["claimed","awaiting-session-assignment","awaiting-transcript","confirmed","failed","indeterminate"] as const; // source path: SendAttemptState
export type SendAttemptState = (typeof sendAttemptStateValues)[number];
export const sendStateValues = ["accepted","dispatching","awaiting-session-assignment","awaiting-transcript","confirmed","failed","indeterminate"] as const; // source path: SendState
export type SendState = (typeof sendStateValues)[number];
export const transcriptEventKindValues = ["provider-session.registered","transcript-line.appended"] as const; // source path: TranscriptEventKind
export type TranscriptEventKind = (typeof transcriptEventKindValues)[number];
export const transcriptRoleValues = ["user","assistant","system","hook","tool","tool_call","tool_result","attachment"] as const; // source path: TranscriptRole
export type TranscriptRole = (typeof transcriptRoleValues)[number];

// --- operation / event / error name catalogues -----------------------------

// --- error catalogue -------------------------------------------------------
export const errorCatalogue = [
  { name: "IdempotencyConflict", retryable: false, reserved: false },
  { name: "DependencyUnavailable", retryable: false, reserved: false },
  { name: "InvalidSendInput", retryable: false, reserved: false },
  { name: "InvalidQuery", retryable: false, reserved: false },
  { name: "InvalidConversationView", retryable: false, reserved: false },
  { name: "UnknownTargetAgent", retryable: false, reserved: false },
] as const;
export type ErrorName = (typeof errorCatalogue)[number]["name"];

/**
 * The public error type. One umbrella class; the name discriminates.
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
