/**
 * The 9 queries: inputs and results, mirroring contract/messaging-contract.json
 * `queries` exactly. Paged reads are sequence-ordered (DEC-19); limit is
 * clamped to constants.pageLimitMax, never rejected (Store-Seam §4).
 */

import type {
  CapabilityViewFeatures,
  Cursor,
  MessageId,
  PersonId,
  ThreadId,
} from "./types.js";
import type {
  ContactPolicy,
  Delivery,
  DndPolicy,
  Message,
  Presence,
  Template,
  Thread,
} from "./records.js";

// --- inputs ------------------------------------------------------------------

export interface GetThreadInput {
  threadId: ThreadId;
}

export interface ListThreadsForPersonInput {
  personId?: PersonId;
}

export interface GetMessagesInput {
  threadId: ThreadId;
  cursor?: Cursor;
  limit?: number;
}

export interface GetInboxInput {
  personId?: PersonId;
  cursor?: Cursor;
  limit?: number;
}

export interface GetDeliveryInput {
  messageId: MessageId;
}

export interface GetPolicyInput {
  personId?: PersonId;
}

export interface ListTemplatesInput {
  includeRetired?: boolean;
  cursor?: Cursor;
  limit?: number;
}

export interface GetPresenceInput {
  personId: PersonId;
}

export interface GetCapabilitiesInput {}

// --- results -----------------------------------------------------------------

export type ThreadView = Thread;

export interface ThreadListResult {
  threads: Thread[];
}

export interface MessagePage {
  messages: Message[];
  nextCursor?: Cursor;
}

export interface DeliveryListResult {
  deliveries: Delivery[];
}

export interface PolicyView {
  contact: ContactPolicy;
  dnd: DndPolicy;
}

export interface TemplatePage {
  templates: Template[];
  nextCursor?: Cursor;
}

export interface PresenceListResult {
  presences: Presence[];
}

export interface CapabilityViewLimits {
  messageMaxBytes: number;
  pageLimitMax: number;
  subscriptionBufferMax: number;
}

/** Discovery. Callable pre-authentication; reveals versions and limits only. */
export interface CapabilityView {
  contractVersion: string;
  /** DEC-17 WS protocol version. */
  protocolVersion: string;
  features: CapabilityViewFeatures[];
  limits: CapabilityViewLimits;
}
