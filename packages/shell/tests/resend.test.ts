import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ShellServices } from '../contract/index.js';
import { resendFailedMessage } from '../ui/screens/messaging/benchCommands.js';
import { settleOptimisticMessage } from '../ui/screens/messaging/messageList.js';

describe('manual resend idempotency', () => {
  it('reuses the failed message clientOpId instead of minting a new one', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      message: {
        id: 'message_original', conversationId: 'conv_1', senderId: 'me',
        text: 'retry me', createdAt: new Date().toISOString(), clientOpId: 'op_original',
      },
    }));
    const services = { sendMessage } as unknown as ShellServices;
    const failed: ChatMessage = {
      id: 'pending_1', conversationId: 'conv_1', senderId: 'me',
      text: 'retry me', createdAt: new Date().toISOString(),
      failed: 'ReplyInterrupted', clientOpId: 'op_original',
    };

    await resendFailedMessage(services, failed);

    expect(sendMessage).toHaveBeenCalledWith('conv_1', 'retry me', 'op_original');
  });

  it('normalizes a rejected send so the optimistic row renders the failure inline', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('ConversationUnavailable: the server rejected this send');
    });
    const services = { sendMessage } as unknown as ShellServices;
    const pending: ChatMessage = {
      id: 'pending_rejected',
      conversationId: 'conv_1',
      senderId: 'me',
      text: 'retry me',
      createdAt: new Date().toISOString(),
      pending: true,
      clientOpId: 'op_rejected',
    };

    const outcome = await resendFailedMessage(services, pending);
    const settled = settleOptimisticMessage([pending], pending.id, outcome);

    expect(settled).toEqual([{
      ...pending,
      pending: false,
      failed: 'SendRejected: ConversationUnavailable: the server rejected this send',
    }]);
  });
});
