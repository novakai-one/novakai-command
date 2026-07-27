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
 *
 * S2b: attaching also registers the session for context advisories (ruling 1)
 * and tracks turn boundaries — output/activity extends the turn; a quiet
 * window (ctx.advisoryQuietMs) ends it and flushes queued advisories.
 */
export function attachLiveLane(ctx: AgentsContext, binding: LiveLaneBinding): Unsubscribe {
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(binding.sessionId));
  if (!adapter) return () => undefined;
  ctx.laneState.set(binding.sessionId, { queue: [], busyUntil: 0, timer: null });
  const unsub = adapter.subscribe(binding.sessionId, (e) => {
    noteLaneEvent(ctx, binding.sessionId, e.type);
    if (e.type === 'exited') {
      const st = ctx.laneState.get(binding.sessionId);
      if (st?.timer) clearTimeout(st.timer);
      ctx.laneState.delete(binding.sessionId);
    }
    if (e.type !== 'output') return;
    void binding.sender.sendMessage({
      address: binding.address,
      body: { text: e.data },
      priority: 'normal',
      clientMessageId: `c_${randomUUID()}`,
    });
  });
  return () => {
    const st = ctx.laneState.get(binding.sessionId);
    if (st?.timer) clearTimeout(st.timer);
    ctx.laneState.delete(binding.sessionId);
    unsub();
  };
}

/** Turn tracking: output/activity extends the turn; quiet ends it and flushes. */
function noteLaneEvent(ctx: AgentsContext, sessionId: string, type: string): void {
  const st = ctx.laneState.get(sessionId);
  if (!st || type === 'exited') return;
  st.busyUntil = Date.now() + ctx.advisoryQuietMs;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => flushAdvisories(ctx, sessionId), ctx.advisoryQuietMs);
}

/** Deliver queued advisories in order — BETWEEN turns only (never mid-stream). */
export function flushAdvisories(ctx: AgentsContext, sessionId: string): void {
  const st = ctx.laneState.get(sessionId);
  if (!st || st.queue.length === 0) return;
  if (Date.now() < st.busyUntil) return; // still mid-turn; timer will retry
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
  if (!adapter) return;
  for (const line of st.queue.splice(0)) adapter.send(sessionId, line);
}

/**
 * Push a focus-change advisory to an in-app session (DEC-S2-6). Idle session →
 * delivered immediately as a system context line; mid-turn → queued, flushed
 * between turns. Sessions without a live lane are pull-only (nvk-context) —
 * refused (false), never silently dropped.
 */
export function pushContextAdvisory(ctx: AgentsContext, sessionId: string, line: string): boolean {
  const st = ctx.laneState.get(sessionId);
  if (!st) return false;
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
  if (!adapter) return false;
  if (Date.now() >= st.busyUntil) return adapter.send(sessionId, line);
  st.queue.push(line);
  return true;
}
