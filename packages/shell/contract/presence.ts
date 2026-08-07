// shell/contract/presence.ts — SHL-006. Shell consumes ONLY the agentEvent
// stream (R3-17) via the PresenceSource seam; current state is derived from
// the latest event per agentId (§11 ruling 8) — never stored, never authoritative.
import type { AgentEvent, PresenceSnapshot, PresenceSource, Unsubscribe } from './types.js';

export class PresenceTracker {
  private snapshots = new Map<string, PresenceSnapshot>();
  private listeners = new Set<() => void>();
  private unsubscribe: Unsubscribe | null = null;

  attach(source: PresenceSource): void {
    this.detach();
    this.unsubscribe = source.subscribeAgentEvents((e) => this.apply(e));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  apply(e: AgentEvent): void {
    const prev = this.snapshots.get(e.agentId);
    switch (e.type) {
      case 'spawned':
      case 'online':
        this.snapshots.set(e.agentId, { agentId: e.agentId, state: 'online', activity: prev?.activity, at: e.at });
        break;
      case 'activity':
        // ruling 12: the adapter's quiet-window heuristic signals 'idle' —
        // that reads as online (calm), never as typing.
        if (e.activity === 'idle') {
          this.snapshots.set(e.agentId, { agentId: e.agentId, state: 'online', at: e.at });
        } else {
          this.snapshots.set(e.agentId, { agentId: e.agentId, state: 'active', activity: e.activity, at: e.at });
        }
        break;
      case 'offline':
        this.snapshots.set(e.agentId, { agentId: e.agentId, state: 'offline', at: e.at });
        break;
    }
    for (const l of this.listeners) l();
  }

  get(agentId: string): PresenceSnapshot {
    return this.snapshots.get(agentId) ?? { agentId, state: 'offline' };
  }

  all(): PresenceSnapshot[] {
    return [...this.snapshots.values()];
  }

  subscribe(l: () => void): Unsubscribe {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** §4 signature: subscribePresence(handler) — raw event passthrough. */
export function subscribePresence(source: PresenceSource, handler: (e: AgentEvent) => void): Unsubscribe {
  return source.subscribeAgentEvents(handler);
}
