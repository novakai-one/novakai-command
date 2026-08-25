/** Existing v1 commands plus additive transcript-first send declarations. */
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
} from './types.js';
import type { MessageBody, TemplateBinding } from './records.js';
import type { SendJournal } from './records/send-journal.js';

/** Send literal text to one Messaging address. */
export interface SendMessageInput {
  address: Address;
  body: MessageBody;
  priority: Priority;
  clientMessageId: ClientMessageId;
}

/** Render and send a stored template. */
export interface SendFromTemplateInput {
  address: Address;
  templateId: TemplateId;
  fields: Record<string, unknown>;
  priority: Priority;
  clientMessageId: ClientMessageId;
}

/** Open one transport presence for the authenticated principal. */
export interface OpenPresenceInput {
  transport: TransportKind;
  clientLabel?: string;
}

/** Close one previously opened presence. */
export interface ClosePresenceInput {
  presenceId: PresenceId;
}

/** Change do-not-disturb policy for the holder or named person. */
export interface SetDndPolicyInput {
  personId?: PersonId;
  enabled: boolean;
}

/** Replace the holder's contact allowlist and default rule. */
export interface SetContactPolicyInput {
  personId?: PersonId;
  allowlist: PersonId[];
  defaultRule: ContactPolicyDefaultRule;
}

/** Create or replace one message template. */
export interface UpsertTemplateInput {
  templateId?: TemplateId;
  name: string;
  description?: string;
  bindings: TemplateBinding[];
}

/** Retire one message template by identifier. */
export interface RetireTemplateInput {
  templateId: TemplateId;
}

/** Durable identity returned for an opened presence. */
export interface PresenceOpened {
  presenceId: PresenceId;
}

/** Idempotent: closing an unknown or already-closed Presence succeeds. */
export interface PresenceClosed {}

/** Existing v1 acceptance returned after a message is committed. */
export interface SendAccepted {
  messageId: MessageId;
  threadId: ThreadId;
  sequence: Sequence;
  urgentDowngraded?: boolean;
  duplicate?: boolean;
}

/** Revision returned after a policy mutation. */
export interface PolicyUpdated {
  revision: number;
}

/** Identity and revision returned after a template upsert. */
export interface TemplateUpserted {
  templateId: TemplateId;
  revision: number;
}

/** Successful idempotent template retirement. */
export interface TemplateRetired {}

/** Trusted host command; the host derives issuedBy from its authenticated holder. */
export interface ConversationSendInput {
  readonly conversationId: string;
  readonly issuedBy: string;
  readonly targetAgentId: string;
  readonly text: string;
  readonly clientOpId: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

/** Transcript-first acceptance; provider completion is deliberately absent. */
export interface ConversationSendAcceptance {
  readonly sendId: SendJournal['id'];
  readonly clientOpId: string;
  readonly state: SendJournal['state'];
  readonly duplicate: boolean;
  readonly targetAgentId: string;
  readonly targetSessionId?: SendJournal['targetSessionId'];
}
