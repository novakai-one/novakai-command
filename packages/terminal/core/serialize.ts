// One decision at a time per session.
//
// Foundation's CAS makes a single record safe; it does not make "read the
// leases, decide who wins, then write" safe. Two controllers grabbing the
// lease in the same tick must be ordered, so every session-scoped decision
// runs inside this queue. The Runtime is an OS-level singleton (DEC-B3V4-27),
// so in-process ordering is the whole story.
export class SessionQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<T>(lane: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(lane) ?? Promise.resolve();
    const next = previous.then(work, work);
    // Swallow only the CHAIN's rejection, never the caller's: the caller still
    // receives `next` and its error.
    this.tails.set(lane, next.then(() => undefined, () => undefined));
    return next;
  }
}
