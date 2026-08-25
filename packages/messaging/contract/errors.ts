/**
 * Per-error field shapes for the 13-error catalogue, mirroring
 * contract/messaging-contract.json `errors[].fields` exactly.
 * Error names and the MessagingError class live in ./types.js (law #3).
 */

import type {
  Address,
  ErrorName,
  Grant,
  MessageId,
  PersonId,
} from "./types.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface NotAuthenticatedFields {}

export interface NotAuthorizedFields {
  requiredGrant?: Grant;
}

export interface UnknownRecipientFields {
  address?: Address;
}

export interface UnknownThreadFields {
  threadId?: string;
}

export interface UnknownMessageFields {
  messageId?: string;
}

export interface BlockedByContactPolicyFields {
  recipientId?: PersonId;
}

export interface ValidationFailedFields {
  issues?: ValidationIssue[];
}

export interface TemplateNotFoundFields {
  templateId?: string;
}

export interface TemplateFieldMismatchFields {
  templateId?: string;
  issues?: ValidationIssue[];
}

export interface VersionUnsupportedFields {
  supported?: string[];
}

/** FORWARD-RESERVED (R13, O2): appears in no per-operation failure list in v1. */
export interface RateLimitedFields {
  retryAfterMs?: number;
}

export interface IdempotencyConflictFields {
  clientMessageId?: string;
  originalMessageId?: MessageId;
}

export interface DependencyUnavailableFields {
  /**
   * Open-typed string, NOT an enum (tolerate-unknown is the compatibility
   * rule). Known values: store | membership | authority | clock.
   */
  dependency?: string;
  /** Per-instance flag. Absent/unknown → assume false. */
  retryable?: boolean;
}

export interface ErrorFieldsMap {
  NotAuthenticated: NotAuthenticatedFields;
  NotAuthorized: NotAuthorizedFields;
  UnknownRecipient: UnknownRecipientFields;
  UnknownThread: UnknownThreadFields;
  UnknownMessage: UnknownMessageFields;
  BlockedByContactPolicy: BlockedByContactPolicyFields;
  ValidationFailed: ValidationFailedFields;
  TemplateNotFound: TemplateNotFoundFields;
  TemplateFieldMismatch: TemplateFieldMismatchFields;
  VersionUnsupported: VersionUnsupportedFields;
  RateLimited: RateLimitedFields;
  IdempotencyConflict: IdempotencyConflictFields;
  DependencyUnavailable: DependencyUnavailableFields;
}

export type FieldsFor<Name extends ErrorName> = ErrorFieldsMap[Name];
