// Agent messaging contracts per docs/agent-messaging.md §3. The envelope is
// the extensible object — permissions and future metadata land here later.
import type { ProviderId } from '../../shared/project/schema.js';

export interface MessageEnvelope {
  id: string;            // msg_<uuid>
  from: string;          // sender agent name (presentation)
  to: string;            // agent name or '#team' (presentation)
  delivery: 'normal' | 'interrupt';
  body: string;
  threadId?: string;     // optional conversation grouping
  createdAt: string;     // ISO
  // 'accepted' = bytes written to the recipient's PTY (D1 honesty: a direct
  // send — normal or interrupt — is never claimed 'delivered' until the
  // recipient's transcript proves the turn arrived, so a direct 'delivered'
  // always carries outcome evidence). Mailbox recipients have no PTY and no
  // transcript: their envelopes honestly stay 'queued' — the append is the
  // record (mission_transcript-proof-normal-sends).
  status: 'queued' | 'accepted' | 'delivered' | 'partial' | 'failed';
  /** Delivery evidence, amended onto the audit record as it accrues (M9). */
  outcome?: DeliveryOutcome;
  // Server-derived, never client-trusted (plan v2 §1.5, M11): durable joins
  // use these ids, so renames never sever message→Agent history.
  senderAgentId?: string;
  recipientAgentId?: string;
  missionId?: string;
}

/** Evidence metadata persisted on the envelope (ruling M9): who the bytes
 * went to, when they were accepted, and the transcript event that proved the
 * effect — or an honest note when no proof arrived. */
export interface DeliveryOutcome {
  acceptedAt?: string;
  confirmedAt?: string;
  agentId?: string;
  sessionId?: string;
  provider?: string;
  /** Identity of the confirming transcript user turn (provider timestamp or index). */
  transcriptEvent?: string;
  note?: string;
}

export interface Room {
  roomId: string;
  name: string;
  members: string[];
  createdBy: string;
  createdAt: string;
  archived: boolean;
}

export interface AgentAddress {
  agentId: string;
  name: string;
  provider: ProviderId;
}

export const CHRIS_MEMBER = 'chris';
export const KIMI_MEMBER = 'kimi';

export interface MailboxIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly memberName: string;
  readonly role: 'owner' | 'orchestrator';
  readonly permissions: readonly ('messages:send' | 'rooms:send')[];
}

/** Browser-authored messages resolve to this server-owned principal. */
export const CHRIS_IDENTITY: MailboxIdentity = {
  id: 'user:chris',
  displayName: 'Chris',
  memberName: CHRIS_MEMBER,
  role: 'owner',
  permissions: ['messages:send', 'rooms:send'],
};

/** Task orchestration resolves to a durable inbox, independent of a live PTY. */
export const KIMI_IDENTITY: MailboxIdentity = {
  id: 'orchestrator:kimi',
  displayName: 'Kimi',
  memberName: KIMI_MEMBER,
  role: 'orchestrator',
  permissions: ['messages:send'],
};

export const MAILBOX_IDENTITIES: readonly MailboxIdentity[] = [
  CHRIS_IDENTITY,
  KIMI_IDENTITY,
];

/** Lookup seam: the file-loaded registry and the static list both satisfy it. */
export type MailboxLookup = (memberName: string) => MailboxIdentity | undefined;

export function mailboxIdentityFor(memberName: string): MailboxIdentity | undefined {
  return MAILBOX_IDENTITIES.find((identity) => identity.memberName === memberName);
}

export function isChannel(recipient: string): boolean {
  return recipient.startsWith('#');
}

export function isRoom(recipient: string): boolean {
  return recipient.startsWith('room_');
}
