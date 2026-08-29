import type { MessagingTraceEvent, MessagingTraceSink } from '../contract/trace.js';

/**
 * Emits one trace moment. Observation never breaks the observed: an absent
 * sink is a no-op and a throwing sink is swallowed — the send, the pass, and
 * the pump complete exactly as if nobody were watching.
 */
export const emitTrace = (
  sink: MessagingTraceSink | undefined,
  event: MessagingTraceEvent,
): void => {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // A broken observer is a rendering problem, never a messaging failure.
  }
};
