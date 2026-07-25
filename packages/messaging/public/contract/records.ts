/**
 * The 10 authoritative records (+ nested value objects), mirroring
 * contract/messaging-contract.json `records` exactly.
 *
 * Law #3: every enumeration/literal type is imported from ./generated.js.
 * Hand-written code never re-types a contract literal.
 *
 * I3 envelope: every independently-persisted record carries
 * id / kind / schemaVersion / createdAt.
 */

import { schemaVersion } from "./generated.js";
import type {
  AcceptanceId,
  AcceptanceRecordKind,
  AttemptId,
  BlockedReason,
  ClientMessageId,
  ContactPolicyDefaultRule,
  ContactPolicyKind,
  DeliveryAttemptKind,
  DeliveryAttemptOutcome,
  DeliveryId,
  DeliveryKind,
  DeliveryState,
  DeliveryStateReason,
  DndPolicyKind,
  MessageBodyFormat,
  MessageId,
  MessageKind,
  PersonId,
  PolicyId,
  PresenceId,
  PresenceKind,
  Priority,
  RecipientSnapshotKind,
  RequestHash,
  Sequence,
  SnapshotId,
  TemplateId,
  TemplateKind,
  ThreadId,
  ThreadKind,
  ThreadRecordKind,
  Timestamp,
  TransportKind,
} from "./generated.js";

/**
 * The authority seam names its authenticated identity `Principal`
 * (Messaging-Seams §2.1); the contract source names the durable identity
 * `PersonId`. One identity, two prose names — the alias keeps both
 * vocabularies honest without a second brand.
 */
export type PrincipalId = PersonId;

type SchemaVersion = typeof schemaVersion;

export interface MessageBody {
  text: string;
  format?: MessageBodyFormat;
  subject?: string;
  /** Template-bound custom fields (R12 allowlist: body.fields.<name>). */
  fields?: Record<string, unknown>;
}

export interface TemplateRef {
  templateId: TemplateId;
  fields?: Record<string, unknown>;
}

export interface Message {
  id: MessageId;
  kind: MessageKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  threadId: ThreadId;
  /** The authenticated Principal, always (DEC-11, I4, G3). Never caller-supplied. */
  senderId: PersonId;
  clientMessageId: ClientMessageId;
  sequence: Sequence;
  priority: Priority;
  body: MessageBody;
  template?: TemplateRef;
}

/** Present iff threadKind = direct. Canonical sorted pair (DEC-03). */
export interface ThreadDirect {
  pair: [PersonId, PersonId];
}

/** Present iff threadKind = team|mission. */
export interface ThreadRoom {
  authority: string;
  externalId: string;
}

export interface Thread {
  id: ThreadId;
  kind: ThreadRecordKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  threadKind: ThreadKind;
  direct?: ThreadDirect;
  room?: ThreadRoom;
}

export interface Delivery {
  id: DeliveryId;
  kind: DeliveryKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  messageId: MessageId;
  threadId: ThreadId;
  recipientId: PersonId;
  state: DeliveryState;
  stateReason?: DeliveryStateReason;
}

export interface DeliveryAttempt {
  id: AttemptId;
  kind: DeliveryAttemptKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  deliveryId: DeliveryId;
  presenceId?: PresenceId;
  transport: TransportKind;
  outcome: DeliveryAttemptOutcome;
  /** Adapter-reported failure detail. Never settles state by itself. */
  detail?: string;
}

export interface Presence {
  id: PresenceId;
  kind: PresenceKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  personId: PersonId;
  transport: TransportKind;
  /** Caller-chosen display label. Presentation data, never a durable join (G2). */
  clientLabel?: string;
}

export interface ContactPolicy {
  id: PolicyId;
  kind: ContactPolicyKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  personId: PersonId;
  allowlist: PersonId[];
  defaultRule: ContactPolicyDefaultRule;
  /** Optimistic-concurrency counter (Store-Seam §5). */
  revision: number;
}

export interface DndPolicy {
  id: PolicyId;
  kind: DndPolicyKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  personId: PersonId;
  enabled: boolean;
  revision: number;
}

export interface TemplateBinding {
  /** The template-declared field name a sender supplies. */
  field: string;
  /** Target path in the Message schema. MUST be in templateBindablePaths (R12). */
  path: string;
}

export interface Template {
  id: TemplateId;
  kind: TemplateKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  name: string;
  description?: string;
  bindings: TemplateBinding[];
  /** Retired templates reject new sends; history unchanged (I10). */
  retired: boolean;
  revision: number;
}

export interface MembershipEvidence {
  authority: string;
  /** Opaque membership-authority revision at resolution time (Store-Seam §9, R8). */
  revision: string;
  resolvedAt: Timestamp;
}

export interface BlockedRecipient {
  personId: PersonId;
  reason: BlockedReason;
}

export interface RecipientSnapshot {
  id: SnapshotId;
  kind: RecipientSnapshotKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  messageId: MessageId;
  recipients: PersonId[];
  /** R4: room-send recipients whose ContactPolicy blocks the sender. */
  blocked?: BlockedRecipient[];
  /** Room sends only. Frozen with the snapshot (R8 store side, Store-Seam §9). */
  membership?: MembershipEvidence;
}

export interface AcceptanceRecord {
  id: AcceptanceId;
  kind: AcceptanceRecordKind;
  schemaVersion: SchemaVersion;
  createdAt: Timestamp;
  senderId: PersonId;
  clientMessageId: ClientMessageId;
  requestHash: RequestHash;
  messageId: MessageId;
  threadId: ThreadId;
  sequence: Sequence;
  /** DEC-21 recovery marker, written inside the acceptance transaction. */
  effectsPending: boolean;
  /** Persisted at acceptance (MSG-010); survives idempotent retries (Store-Seam §11.3). */
  urgentDowngraded?: boolean;
}
