// The agentEvent bus: agents OWNS the public presence event. Terminal's raw
// PtyEvents are wrapped/re-published here; subscribers see only AgentEvent.
import { AgentEvent as AgentEventSchema, type AgentEvent, type Unsubscribe } from '../../contract/schemas.js';

export class AgentEventBus {
  private readonly handlers: Array<(e: AgentEvent) => void> = [];
  /** Event log retained in-process so late subscribers can derive presence
   * snapshots — derived and ephemeral, never stored authoritatively. */
  private readonly log: AgentEvent[] = [];

  publish(e: AgentEvent): void {
    const parsed = AgentEventSchema.safeParse(e);
    if (!parsed.success) return; // malformed internal event: drop, never crash subscribers
    this.log.push(parsed.data);
    for (const h of this.handlers) h(parsed.data);
  }

  subscribe(handler: (e: AgentEvent) => void): Unsubscribe {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /** Latest event per agentId — derived presence snapshot, ephemeral. */
  presence(): Map<string, AgentEvent> {
    const latest = new Map<string, AgentEvent>();
    for (const e of this.log) latest.set(e.agentId, e);
    return latest;
  }
}
