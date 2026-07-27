// core/live-lane — R3-1: agents owns the LIVE LANE. The session adapter
// subscribes terminal output and issues messages.send via messaging's PUBLIC
// contract in real time. Messaging's store is never touched (sealed capability).
//
// Messaging entry point used: MessagingSession.sendMessage (packages/messaging/
// public/capability.ts) with SendMessageInput { address, body, priority,
// clientMessageId } (packages/messaging/public/contract/commands.ts). Typed
// structurally here so agents does not reach into messaging internals.
import { randomUUID } from 'node:crypto';
import type { Unsubscribe } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

/** Structural match for messaging's public MessagingSession.sendMessage. */
export interface LiveLaneSender {
  sendMessage(input: unknown): Promise<{ kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown }>;
}

export interface LiveLaneBinding {
  sessionId: string;
  /** messaging Address, e.g. "thread:thread_…" — who receives the agent's output. */
  address: string;
  sender: LiveLaneSender;
}

/**
 * Attach the live lane: PTY output chunks become messages in real time.
 * Conversion policy (NOTED, S1): one output chunk → one message, text = raw
 * chunk. Line-buffering/TUI control-sequence filtering is a renderer concern.
 */
export function attachLiveLane(ctx: AgentsContext, binding: LiveLaneBinding): Unsubscribe {
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(binding.sessionId));
  if (!adapter) return () => undefined;
  return adapter.subscribe(binding.sessionId, (e) => {
    if (e.type !== 'output') return;
    void binding.sender.sendMessage({
      address: binding.address,
      body: { text: e.data },
      priority: 'normal',
      clientMessageId: `c_${randomUUID()}`,
    });
  });
}
