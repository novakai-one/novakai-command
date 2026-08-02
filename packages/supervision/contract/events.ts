import type {
  CapabilityOwner,
  EventCursor,
  IsoUtc,
  TraceCorrelationId,
} from '@novakai/foundation/contract';
import type { Notification } from './records.js';

/** The complete §15 event envelope. */
export interface PublicEvent<Kind extends string, Payload> {
  readonly eventId: string;
  readonly kind: Kind;
  readonly schemaVersion: 1;
  readonly occurredAt: IsoUtc;
  readonly committedAt: IsoUtc;
  readonly sourceOwner: CapabilityOwner;
  readonly traceId: TraceCorrelationId;
  readonly cursor: EventCursor;
  readonly payload: Payload;
}

/** The exact supervision-owned event-kind rows published by §15. */
export const SUPERVISION_EVENT_KINDS = [
  'supervision.deadline.changed',
  'supervision.notification.changed',
  'supervision.drift.ping',
  'supervision.drift.cleared',
  'supervision.drift.detected',
  'supervision.drift.escalated',
] as const;

/** One of the six supervision-owned event discriminants. */
export type SupervisionEventKind = typeof SUPERVISION_EVENT_KINDS[number];

/** §12.7 is the only clause that assigns a concrete supervision payload. */
export type NotificationEvent = PublicEvent<
  'supervision.notification.changed',
  Notification
>;

/**
 * A named §15 supervision event whose payload is not specified by pass2.
 * The open record is deliberate: inventing domain fields here would freeze a guess.
 */
export type UnspecifiedSupervisionEvent<
  Kind extends Exclude<SupervisionEventKind, 'supervision.notification.changed'>,
> = PublicEvent<Kind, Readonly<Record<string, unknown>>>;

/** Executable union of all supervision-owned §15 rows without invented payloads. */
export type SupervisionEvent =
  | NotificationEvent
  | UnspecifiedSupervisionEvent<'supervision.deadline.changed'>
  | UnspecifiedSupervisionEvent<'supervision.drift.ping'>
  | UnspecifiedSupervisionEvent<'supervision.drift.cleared'>
  | UnspecifiedSupervisionEvent<'supervision.drift.detected'>
  | UnspecifiedSupervisionEvent<'supervision.drift.escalated'>;

/** Usage-evidence event row consumed by Supervision; §15 leaves its payload open. */
export type ProviderUsageEvidenceCommittedEvent = PublicEvent<
  'agent.provider-usage-evidence.committed',
  Readonly<Record<string, unknown>>
>;
