// core/live-lane — R3-1: agents owns the LIVE LANE. The session adapter
// subscribes terminal output and issues messages.send via messaging's PUBLIC
// contract in real time. Messaging's store is never touched (sealed capability).
//
import type { PtyEvent, Unsubscribe } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

export interface LiveLaneBinding {
  sessionId: string;
  /** Advisory destination retained during the compatibility window. */
  address: string;
}

/**
 * Attach the telemetry lane for context advisories and turn boundaries.
 * Provider output never crosses a message-content interface.
 * S2b: attaching registers the session for context advisories (ruling 1)
 * and tracks turn boundaries — output/activity extends the turn; an 'idle'
 * activity ENDS it (M5: idle never extends); a quiet window
 * (ctx.advisoryQuietMs) ends it too. Advisory queue semantics (ruled, DEC-S2-6):
 * latest-wins coalescing, capped at ONE timestamped pending advisory.
 */
export function attachLiveLane(ctx: AgentsContext, binding: LiveLaneBinding): Unsubscribe {
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(binding.sessionId));
  if (!adapter) return () => undefined;
  ctx.laneState.set(binding.sessionId, { pending: null, busyUntil: 0, timer: null });
  const unsub = adapter.subscribe(binding.sessionId, (e) => {
    noteLaneEvent(ctx, binding.sessionId, e);
    if (e.type === 'exited') {
      const st = ctx.laneState.get(binding.sessionId);
      if (st?.timer) clearTimeout(st.timer);
      ctx.laneState.delete(binding.sessionId);
    }
  });
  return () => {
    const st = ctx.laneState.get(binding.sessionId);
    if (st?.timer) clearTimeout(st.timer);
    ctx.laneState.delete(binding.sessionId);
    unsub();
  };
}

/**
 * Turn tracking: output/activity extends the turn; an 'idle' activity event
 * ENDS the turn immediately (M5 — the adapter's quiet-window heuristic says the
 * turn is over, so queued advisories flush between turns right away); quiet
 * ends it via the timer.
 */
function noteLaneEvent(ctx: AgentsContext, sessionId: string, e: PtyEvent): void {
  const st = ctx.laneState.get(sessionId);
  if (!st || e.type === 'exited') return;
  if (e.type === 'activity' && e.activity === 'idle') {
    st.busyUntil = 0;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    flushAdvisories(ctx, sessionId);
    return;
  }
  st.busyUntil = Date.now() + ctx.advisoryQuietMs;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => flushAdvisories(ctx, sessionId), ctx.advisoryQuietMs);
}

/** Deliver the LATEST queued advisory — BETWEEN turns only (never mid-stream). */
export function flushAdvisories(ctx: AgentsContext, sessionId: string): void {
  const st = ctx.laneState.get(sessionId);
  if (!st || !st.pending) return;
  if (Date.now() < st.busyUntil) return; // still mid-turn; timer will retry
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
  if (!adapter) return;
  const latest = st.pending;
  st.pending = null; // latest-wins: stale advisories were already dropped at push time
  adapter.send(sessionId, latest.line);
}

/**
 * Push a focus-change advisory to an in-app session (DEC-S2-6). Idle session →
 * delivered immediately as a system context line; mid-turn → queued,
 * latest-wins (a newer advisory REPLACES the pending one — capped at 1).
 * Sessions without a live lane are pull-only (nvk-context) — refused (false),
 * never silently dropped.
 */
export function pushContextAdvisory(ctx: AgentsContext, sessionId: string, line: string): boolean {
  const st = ctx.laneState.get(sessionId);
  if (!st) return false;
  const adapter = Object.values(ctx.adapters).find((a) => a.attach(sessionId));
  if (!adapter) return false;
  if (Date.now() >= st.busyUntil) return adapter.send(sessionId, line);
  st.pending = { line, at: new Date().toISOString() }; // timestamped, coalescing
  return true;
}
