// Message router — records every envelope, then delivers via the adapter
// seam: PTY typing for agents, the log+ws record for the human. Failures
// are part of the audit record: the envelope is appended first, and every
// outcome lands as a status amendment.
//
// N3 deletions: the channel/room arms (routeChannel, routeRoom,
// deliverRoomMembers) are gone — #team lives in the messaging capability
// (fleet room; capability delivery does the PTY fan-out) and free rooms are
// archive-only. The router now serves the human direct lane until N4.
import { MessageStore } from '../store/index.js';
import { MailboxDeliveryAdapter, PtyDelivery, PtyDeliveryAdapter } from '../delivery/index.js';
import { resolveActor } from '../actors/index.js';
import type { ResolvedActor } from '../actors/index.js';
import type { EnvelopeIdentity } from '../identity/index.js';
import { formatInboundMarker, isChannel, isRoom, mailboxIdentityFor } from '../types.js';
import type { AgentAddress, DeliveryOutcome, DeliveryReceipt, MailboxLookup, MessageEnvelope } from '../types.js';
import type { EffectConfirmer } from '../confirm/index.js';

/** Recipient not found / not running — the error carries the live roster (§5). */
export class RecipientNotFoundError extends Error {
  constructor(recipient: string, public readonly roster: AgentAddress[]) {
    const live = roster.length ? roster.map((agent) => agent.name).join(', ') : '(none running)';
    super(`recipient "${recipient}" is not a live agent — live agents: ${live}`);
  }
}

/** Two agents ping-ponging must not interrupt-storm each other (§6). */
export class InterruptRateLimitError extends Error {
  constructor(sender: string, maxPerMinute: number) {
    super(`interrupt rate cap: ${sender} already sent ${maxPerMinute} interrupts this minute`);
  }
}

/** Interrupting the whole fleet is never what anyone means (§4). */
export class ChannelInterruptError extends Error {
  constructor(channel: string) {
    super(`interrupt delivery is rejected for channel recipients (${channel})`);
  }
}

export class RoomNotFoundError extends Error {
  constructor(roomId: string) {
    super(`room "${roomId}" was not found`);
  }
}

export class NotARoomMemberError extends Error {
  constructor(sender: string, roomId: string) {
    super(`sender "${sender}" is not a member of room "${roomId}"`);
  }
}

/** Room fan-out is best-effort AND honest: live members still get the write;
 *  members whose PTY failed land on the receipt and the envelope settles 'partial'. */

export class InterruptRateLimiter {
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    public readonly maxPerMinute = 3,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records the attempt when allowed; false once the sender hits the cap. */
  tryAcquire(sender: string): boolean {
    const cutoff = this.clock() - 60_000;
    const recent = (this.sentAt.get(sender) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maxPerMinute) {
      this.sentAt.set(sender, recent);
      return false;
    }
    recent.push(this.clock());
    this.sentAt.set(sender, recent);
    return true;
  }
}

/** The Presence facts confirmation needs, looked up at delivery time. */
export interface PresenceLookup {
  (agentId: string): { sessionId: string; projectDir?: string; provider: string } | null;
}

export class MessageRouter {
  private readonly adapters: { agent: PtyDeliveryAdapter; mailbox: MailboxDeliveryAdapter };

  constructor(
    private readonly store: MessageStore,
    delivery: PtyDelivery,
    private readonly roster: () => AgentAddress[],
    private readonly interruptLimiter = new InterruptRateLimiter(),
    private readonly mailboxLookup: MailboxLookup = mailboxIdentityFor,
    /** Stamps durable ids + missionId server-side; absent in rigs without stores. */
    private readonly identity?: EnvelopeIdentity,
    /** D1: transcript-backed effect verification for interrupts. */
    private readonly confirmer?: EffectConfirmer,
    private readonly presenceFor?: PresenceLookup,
    private readonly confirmTimeoutMs = 15_000,
  ) {
    this.adapters = { agent: new PtyDeliveryAdapter(delivery), mailbox: new MailboxDeliveryAdapter() };
  }

  async route(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    // Identity is stamped before the FIRST append so the audit record carries
    // the durable ids from birth (plan v2 §1.5).
    this.identity?.stamp(envelope, this.roster());
    this.store.append(envelope);
    return this.routeDirect(envelope);
  }

  private async routeDirect(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    const roster = this.roster();
    const actor = resolveActor(envelope.to, roster, [], this.mailboxLookup);
    if (actor?.kind === 'mailbox') return this.deliverMailbox(envelope, actor);
    if (actor?.kind !== 'agent') throw this.fail(envelope, new RecipientNotFoundError(envelope.to, roster));
    if (envelope.delivery === 'interrupt' && !this.interruptLimiter.tryAcquire(envelope.from)) {
      throw this.fail(envelope, new InterruptRateLimitError(envelope.from, this.interruptLimiter.maxPerMinute));
    }
    return this.deliverAgent(envelope, actor.address);
  }

  /** Mailbox recipients have no PTY and no transcript: the append IS the
   * delivery record and the envelope honestly stays 'queued' (Manager ruling
   * R1, Chief-confirmed — the Watchdog false-positive fix). No settle: a
   * status amendment here would claim an effect nobody can prove. */
  private async deliverMailbox(envelope: MessageEnvelope, actor: ResolvedActor): Promise<DeliveryReceipt> {
    try {
      return await this.adapters.mailbox.deliver(actor, envelope);
    } catch (error) {
      throw this.fail(envelope, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * D1 honesty for EVERY direct PTY send (normal AND interrupt): the send
   * settles 'accepted' when the bytes are written — 'delivered' is claimed
   * ONLY when the recipient's transcript proves the turn arrived, and the
   * amendment carries the evidence (M9). The confirmation runs
   * asynchronously; the send path never blocks on it.
   */
  private async deliverAgent(envelope: MessageEnvelope, address: AgentAddress): Promise<DeliveryReceipt> {
    try {
      await this.adapters.agent.deliver({ kind: 'agent', address }, envelope);
    } catch (error) {
      throw this.fail(envelope, error instanceof Error ? error : new Error(String(error)));
    }
    const presence = this.presenceFor?.(address.agentId) ?? null;
    this.amend(envelope, 'accepted', {
      acceptedAt: new Date().toISOString(),
      agentId: address.agentId,
      provider: address.provider,
      ...(presence?.sessionId ? { sessionId: presence.sessionId } : {}),
    });
    this.scheduleConfirmation(envelope, address, presence);
    return { messageId: envelope.id, deliveredAt: new Date().toISOString(), mode: `${envelope.delivery}-accepted` };
  }

  /** Fire-and-record: every outcome (proof, timeout, error) amends the audit record. */
  scheduleConfirmation(
    envelope: MessageEnvelope,
    address: AgentAddress,
    presence: { sessionId: string; projectDir?: string; provider: string } | null,
    noteContext = '',
  ): void {
    const prefix = noteContext ? `${noteContext}: ` : '';
    if (!this.confirmer || !presence?.sessionId) {
      this.amend(envelope, envelope.status, { note: `${prefix}effect unverifiable — no confirmer or no sessionId for ${address.name}` });
      return;
    }
    const target = { provider: address.provider, sessionId: presence.sessionId, projectDir: presence.projectDir };
    void this.confirmer.confirm(target, formatInboundMarker(envelope), { timeoutMs: this.confirmTimeoutMs })
      .then((proof) => this.recordProof(envelope, proof, prefix))
      .catch((error: unknown) => {
        this.amend(envelope, envelope.status, { note: `${prefix}confirmation error: ${error instanceof Error ? error.message : String(error)}` });
      });
  }

  /** Every confirmation outcome amends the audit record — proof or honest timeout. */
  private recordProof(envelope: MessageEnvelope, proof: { confirmedAt: string; transcriptEvent: string } | null, prefix: string): void {
    if (proof) this.amend(envelope, 'delivered', { confirmedAt: proof.confirmedAt, transcriptEvent: proof.transcriptEvent });
    else this.amend(envelope, envelope.status, { note: `${prefix}effect unverified within ${this.confirmTimeoutMs}ms` });
  }

  /**
   * Startup reconciliation (D2, ruling S6): the journal is re-read after a
   * backend restart and non-terminal envelopes are settled honestly —
   * 'queued' (never written) is retried ONCE (the host's messageId dedupe
   * makes a retry that actually reached the PTY a no-op); 'accepted' (written)
   * is transcript-verified and NEVER re-typed. Bounded to a recency window so
   * ancient journal history is never replayed.
   */
  async reconcile({ windowMs = 30 * 60 * 1000 }: { windowMs?: number } = {}): Promise<void> {
    const since = new Date(Date.now() - windowMs).toISOString();
    for (const envelope of this.store.history({ since })) {
      // N3: old channel/room lanes are archive — #team lives in the
      // capability now; never retry-falsify them through the direct lane.
      if (isChannel(envelope.to) || isRoom(envelope.to)) continue;
      if (envelope.status === 'queued') {
        // Mailbox sends LIVE at 'queued' — the append is the record (R1).
        // Re-routing one would append a duplicate line and re-broadcast it,
        // showing the message twice to every reader (R2).
        if (resolveActor(envelope.to, this.roster(), [], this.mailboxLookup)?.kind === 'mailbox') continue;
        try {
          await this.route({ ...envelope, status: 'queued' });
        } catch {
          // the retry's own failure already settled the envelope 'failed'
        }
      } else if (envelope.status === 'accepted') {
        const address = this.roster().find((agent) => agent.name === envelope.to
          || agent.agentId === envelope.outcome?.agentId);
        if (!address) {
          this.amend(envelope, 'accepted', { note: 'restart reconciliation: recipient no longer live — effect unverifiable' });
          continue;
        }
        this.scheduleConfirmation(envelope, address, this.presenceFor?.(address.agentId) ?? null, 'restart reconciliation');
      }
    }
  }

  private settle(envelope: MessageEnvelope, status: MessageEnvelope['status']): void {
    envelope.status = status;
    this.store.updateStatus(envelope.id, status);
  }

  private amend(envelope: MessageEnvelope, status: MessageEnvelope['status'], outcome: DeliveryOutcome): void {
    envelope.status = status;
    envelope.outcome = { ...envelope.outcome, ...outcome };
    this.store.amend(envelope.id, status, outcome);
  }

  private fail(envelope: MessageEnvelope, error: Error): Error {
    this.settle(envelope, 'failed');
    return error;
  }
}
