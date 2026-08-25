/**
 * The 8 commands: inputs and results, mirroring contract/messaging-contract.json
 * `commands` exactly. No sender field exists anywhere — identity comes from
 * authentication only (DEC-11, G3).
 */

import type {
  Address,
  ClientMessageId,
  ContactPolicyDefaultRule,
  MessageId,
  PersonId,
  PresenceId,
  Priority,
  Sequence,
  TemplateId,
  ThreadId,
  TransportKind,
} from "./types.js";
import type { MessageBody, TemplateBinding } from "./records.js";

// --- inputs ------------------------------------------------------------------

export interface SendMessageInput {
  address: Address;
  body: MessageBody;
  priority: Priority;
  clientMessageId: ClientMessageId;
}

export interface SendFromTemplateInput {
  address: Address;
  templateId: TemplateId;
  /** Values for the template's declared binding fields (R12 allowlist). */
  fields: Record<string, unknown>;
  priority: Priority;
  clientMessageId: ClientMessageId;
}

export interface OpenPresenceInput {
  transport: TransportKind;
  clientLabel?: string;
}

export interface ClosePresenceInput {
  presenceId: PresenceId;
}

export interface SetDndPolicyInput {
  /** Defaults to the caller. Another Person's policy requires policy.admin. */
  personId?: PersonId;
  enabled: boolean;
}

export interface SetContactPolicyInput {
  /** Defaults to the caller. Another Person's policy requires policy.admin. */
  personId?: PersonId;
  allowlist: PersonId[];
  defaultRule: ContactPolicyDefaultRule;
}

export interface UpsertTemplateInput {
  /** Omit to create; supply to revise (expectedRevision semantics, Store-Seam §5). */
  templateId?: TemplateId;
  name: string;
  description?: string;
  bindings: TemplateBinding[];
}

export interface RetireTemplateInput {
  templateId: TemplateId;
}

// --- results -----------------------------------------------------------------

export interface PresenceOpened {
  presenceId: PresenceId;
}

/** Idempotent (R9): closing an unknown or already-closed Presence succeeds. */
export interface PresenceClosed {}

export interface SendAccepted {
  messageId: MessageId;
  threadId: ThreadId;
  sequence: Sequence;
  /** True when an urgent send was downgraded for lack of priority.override (MSG-010). Survives idempotent retries. */
  urgentDowngraded?: boolean;
  /** True when this is the original acceptance returned to a retry (Store-Seam §2). */
  duplicate?: boolean;
}

export interface PolicyUpdated {
  revision: number;
}

export interface TemplateUpserted {
  templateId: TemplateId;
  revision: number;
}

export interface TemplateRetired {}
