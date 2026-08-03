// One provider-activity decision at a time per Run.
//
// Foundation CAS protects one record write, but Q7's safe-boundary decision
// spans Run truth, a Terminal reservation, and the ordered delivery protocol.
// The Runtime is an OS-level singleton, so this private queue closes the
// in-process gap without creating another durable authority.
export class RunActivityQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<Value>(agentRunId: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(agentRunId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.tails.set(agentRunId, next.then(() => undefined, () => undefined));
    return next;
  }
}
