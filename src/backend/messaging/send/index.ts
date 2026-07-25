// Send API (docs/agent-messaging.md §3): wraps a SendMessage into a
// MessageEnvelope and submits it to the router. HTTP has no ambient identity,
// so `from` rides alongside the doc's SendMessage shape — supplied by
// server-owned callers (the Chris lane /api/user/messages, ExternalSessionsHub)
// since N2 deleted the agent-originated route and its self-claimed `from`.
import { randomUUID } from 'node:crypto';
import { MessageRouter, ChannelInterruptError } from '../router/index.js';
import { isChannel, isRoom } from '../types.js';
import type { MessageEnvelope, SendMessage } from '../types.js';

export class InvalidSendError extends Error {}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidSendError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireDelivery(value: unknown): MessageEnvelope['delivery'] {
  const delivery = value ?? 'normal';
  if (delivery !== 'normal' && delivery !== 'interrupt') {
    throw new InvalidSendError('delivery must be "normal" or "interrupt"');
  }
  return delivery;
}

export class SendApi {
  constructor(private readonly router: MessageRouter) {}

  /**
   * Validates, wraps, records and routes one send. Returns the envelope with
   * its settled status. Interrupt→channel is rejected BEFORE the envelope is
   * recorded — a rejected request is not a send, so it never enters the audit
   * record.
   */
  async send(from: string, message: SendMessage & { threadId?: string }): Promise<MessageEnvelope> {
    const sender = requireText(from, 'from');
    const recipient = requireText(message.to, 'to');
    const delivery = requireDelivery(message.delivery);
    requireText(message.body, 'body');
    if (delivery === 'interrupt' && (isChannel(recipient) || isRoom(recipient))) {
      throw new ChannelInterruptError(recipient);
    }
    const envelope = this.wrap(sender, recipient, delivery, message);
    await this.router.route(envelope);
    return envelope;
  }

  private wrap(
    sender: string,
    recipient: string,
    delivery: MessageEnvelope['delivery'],
    message: SendMessage & { threadId?: string },
  ): MessageEnvelope {
    return {
      id: `msg_${randomUUID()}`,
      from: sender,
      'to': recipient,
      delivery,
      body: message.body,
      ...(typeof message.threadId === 'string' && message.threadId !== ''
        ? { threadId: message.threadId }
        : {}),
      createdAt: new Date().toISOString(),
      status: 'queued',
    };
  }
}
