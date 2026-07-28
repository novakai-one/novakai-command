import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ShellServices } from '../contract/index.js';
import { resendFailedMessage } from '../ui/screens/messaging/MessagingScreen.js';

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
});
