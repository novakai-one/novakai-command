import type { ProviderSessionId, SendId } from './types.js';

/**
 * The observable moments of messaging, named so one send's trace reads as a
 * story: accepted → dispatch started → dispatch settled → (reply) ingested →
 * event drained → message published.
 */
export const messagingTraceStages = [
  'send.accepted',
  'send.dispatch-started',
  'send.dispatch-settled',
  'ingest.pass',
  'ingest.failed',
  'eventbus.drained',
  'message.published',
] as const;

export type MessagingTraceStage = (typeof messagingTraceStages)[number];

/** One observable moment. `sendId` correlates a send's journey end to end. */
export interface MessagingTraceEvent {
  readonly stage: MessagingTraceStage;
  readonly sendId?: SendId;
  readonly sessionId?: ProviderSessionId;
  readonly detail?: string;
}

/**
 * Where trace events go. Core emits structured events only; hosts own the
 * rendering (a console line today, a websocket feed later) by supplying a
 * sink, and the sink stamps the time it observed the event. Emission is
 * guarded: a throwing sink is swallowed and never breaks the work it observes.
 */
export type MessagingTraceSink = (event: MessagingTraceEvent) => void;
