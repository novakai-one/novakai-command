/**
 * presence-transport-memory adapter (Messaging-Seams.md §4.3): in-process
 * transport for embedded use and tests. The real WS adapter is S1-c; the PTY
 * adapter is out of S1 scope. This adapter satisfies the full §4.1 seam
 * (deliver / push / liveness callbacks) so the core's two-lane choreography
 * runs against a real seam, not a stub.
 *
 * Default behaviour: `deliver`/`push` report a real `effect` and record it —
 * it models a healthy transport. Hosts/tests script outcomes per call (e.g.
 * transient failure → R5 retry budget; permanent failure →
 * failed{transport-failure}; presence-gone → presence closes, Delivery stays
 * pending) and raise the liveness callbacks the core funnels into the single
 * presence-close path (R9).
 */

import type { PresenceId, TransportKind } from "../public/contract/index.js";
import type { SubscriptionMessage } from "../public/contract/index.js";
import type {
  DeliverPayload,
  EffectReport,
  PresenceTransport,
  TransportLivenessCallbacks,
} from "../seams/presenceTransport.js";

export interface RecordedDelivery {
  presenceId: PresenceId;
  payload: DeliverPayload;
}

export interface RecordedPush {
  presenceId: PresenceId;
  frame: SubscriptionMessage;
}

export type DeliverScript = (presenceId: PresenceId, payload: DeliverPayload) => EffectReport;
export type PushScript = (presenceId: PresenceId, frame: SubscriptionMessage) => EffectReport;

export interface MemoryPresenceTransport extends PresenceTransport {
  /** Test/host control: script the next deliver outcomes (default: effect). */
  setDeliverScript(script: DeliverScript | undefined): void;
  /** Test/host control: script push outcomes (default: effect). */
  setPushScript(script: PushScript | undefined): void;
  /** Test/host control: raise the §4.1 liveness callbacks into the core. */
  simulateDisconnect(presenceId: PresenceId): void;
  simulateLivenessTimeout(presenceId: PresenceId): void;
  /** Every deliver call that reported a real effect, in order (G10 evidence). */
  readonly effects: RecordedDelivery[];
  /** Every push frame that reported a real effect, in order. */
  readonly pushes: RecordedPush[];
  /** Every deliver attempt (any outcome), in order — retry-budget evidence. */
  readonly attempts: RecordedDelivery[];
}

export interface MemoryPresenceTransportOptions {
  kind: TransportKind;
}

const EFFECT: EffectReport = { kind: "effect" };

export function createMemoryPresenceTransport(
  options: MemoryPresenceTransportOptions,
): MemoryPresenceTransport {
  let deliverScript: DeliverScript | undefined;
  let pushScript: PushScript | undefined;
  let liveness: TransportLivenessCallbacks | undefined;
  const effects: RecordedDelivery[] = [];
  const pushes: RecordedPush[] = [];
  const attempts: RecordedDelivery[] = [];

  return {
    kind: options.kind,
    effects,
    pushes,
    attempts,

    setDeliverScript(script: DeliverScript | undefined): void {
      deliverScript = script;
    },
    setPushScript(script: PushScript | undefined): void {
      pushScript = script;
    },
    simulateDisconnect(presenceId: PresenceId): void {
      liveness?.onDisconnect(presenceId);
    },
    simulateLivenessTimeout(presenceId: PresenceId): void {
      liveness?.onLivenessTimeout(presenceId);
    },
    attachLiveness(callbacks: TransportLivenessCallbacks): void {
      liveness = callbacks;
    },

    async deliver(presenceId: PresenceId, payload: DeliverPayload): Promise<EffectReport> {
      attempts.push({ presenceId, payload });
      const report = deliverScript ? deliverScript(presenceId, payload) : EFFECT;
      if (report.kind === "effect") effects.push({ presenceId, payload });
      return report;
    },

    async push(presenceId: PresenceId, frame: SubscriptionMessage): Promise<EffectReport> {
      const report = pushScript ? pushScript(presenceId, frame) : EFFECT;
      if (report.kind === "effect") pushes.push({ presenceId, frame });
      return report;
    },
  };
}
