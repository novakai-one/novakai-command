// Where Transcript and Supervision meet over Q11, and the only place they do.
//
// Supervision cannot see a provider transcript and Transcript cannot see a
// Notification. Neither should: a Transcript that knew about Notifications
// would be a second supervision authority, and a Supervision that read
// transcript files would be a second Transcript. So this file is the whole
// meeting — a TRANSLATOR, holding no durable state and making no decision that
// either capability's contract does not already make.
//
// What it translates, and nothing more:
//
//   Transcript says   "this pass committed these human turns, on this Run's
//                      binding, at these positions, with these digests"
//   Supervision says  "these Notifications had their input submitted and are
//                      still waiting to be seen in the provider's own words"
//
// The MATCH is not made here. Every candidate pairing is offered to the frozen
// command, which owns the law and refuses everything that is not the exact turn
// this Notification caused — wrong Run, wrong Terminal attempt, wrong turn,
// wrong text. Reproducing any of those checks here would be a second, drifting
// copy of Q11; a refusal is the expected answer for most pairings and is not an
// error. That is why this file can be read in one sitting and still be right.
import {
  mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type ProviderSessionId,
  type ProviderTurnId, type SystemCommandContext, type TerminalInputAttemptId,
  type TranscriptBindingId, type TranscriptLineId,
} from '@novakai/foundation/contract';
import type { RunEvent } from '../../../agent-runtime/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type { Notification } from '../../../supervision/contract/index.js';

/** The one event kind this consumes. Additive facts on it, never a new channel. */
const COMMITTED = 'transcript.line.committed';

/**
 * The states a positive observation may still promote from.
 *
 * `delivery-uncertain` is included on purpose. It is a closure over what
 * Transcript could see AT THE TIME, not a verdict that the turn never happened,
 * and the frozen machine keeps the arrow open — so a line that shows up later
 * still promotes. The reverse never happens: nothing here can walk an observed
 * Notification back.
 */
const AWAITING: readonly Notification['state'][] = ['offered-to-endpoint', 'delivery-uncertain'];

/** How many waiting Notifications one committed pass will consider. */
const CANDIDATE_LIMIT = 100;

const READER: SystemCommandContext<'sys_transcript'>['principal'] = {
  id: 'sys_transcript', kind: 'system', verifiedScopes: [],
};

const transcriptContext = (): SystemCommandContext<'sys_transcript'> => ({
  principal: READER,
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/** One committed human turn, as it arrives on the stream. */
interface CommittedInputLine {
  readonly transcriptLineId: TranscriptLineId;
  readonly sourcePosition: string;
  readonly sourceDigest: string;
  readonly textDigest: string;
}

const isCommittedInputLine = (value: unknown): value is CommittedInputLine => {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return typeof line['transcriptLineId'] === 'string'
    && typeof line['sourcePosition'] === 'string'
    && typeof line['sourceDigest'] === 'string'
    && typeof line['textDigest'] === 'string';
};

/** What a committed pass tells this translator, or null when it tells it nothing. */
interface CommittedPass {
  readonly bindingId: TranscriptBindingId;
  readonly agentRunId: AgentRunId;
  readonly providerSessionId: ProviderSessionId;
  readonly lines: readonly CommittedInputLine[];
}

/**
 * Read the pass off the event. Parsed from `unknown` at the seam rather than
 * trusted: this crosses a capability boundary even though both sides are
 * composed in one process, and a payload that has drifted must produce nothing
 * rather than a half-built claim.
 */
function passOf(event: RunEvent): CommittedPass | null {
  if (event.kind !== COMMITTED) return null;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload === undefined) return null;
  const { bindingId, agentRunId, providerSessionId } = payload;
  if (typeof bindingId !== 'string') return null;
  if (typeof agentRunId !== 'string') return null;
  if (typeof providerSessionId !== 'string') return null;
  const lines = payload['committedInputLines'];
  if (!Array.isArray(lines)) return null;
  const parsed = lines.filter(isCommittedInputLine);
  if (parsed.length === 0) return null;
  return {
    bindingId: bindingId as TranscriptBindingId,
    agentRunId: agentRunId as AgentRunId,
    providerSessionId: providerSessionId as ProviderSessionId,
    lines: parsed,
  };
}

/**
 * The durable turn identity this Notification's input effect produced, or null
 * when there is none.
 *
 * Q11 correlates on a durable ProviderTurnId, and Supervision's is the one
 * Runtime recorded when the input was submitted — the transcript file speaks the
 * provider's own native ids, which are a different namespace entirely. So a
 * submission that never yielded a turn id has no durable turn to name, and no
 * amount of transcript activity invents one: this returns null and the
 * Notification stays where it is. Missing evidence does not become positive.
 */
function submittedTurnOf(notification: Notification): {
  readonly providerTurnId: ProviderTurnId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
} | null {
  const attempt = notification.deliveryAttempt;
  if (attempt.state !== 'submitted-confirmed' && attempt.state !== 'submitted-unconfirmed') {
    return null;
  }
  if (attempt.providerTurnId === undefined) return null;
  return {
    providerTurnId: attempt.providerTurnId,
    terminalInputAttemptId: attempt.terminalInputAttemptId,
  };
}

/** Consumes committed transcript passes; promotes what Q11 says may be promoted. */
export interface NotificationTranscriptObserver {
  observe(event: RunEvent): Promise<void>;
}

/**
 * Is this waiting Notification even about the Run this pass belongs to, and did
 * its input effect produce a durable turn to name? Both are facts already
 * written down; neither is a judgement about the turn itself.
 */
function pairableWith(
  notification: Notification, pass: CommittedPass,
): ReturnType<typeof submittedTurnOf> {
  // The Run a line belongs to is Transcript's own fact, read off the binding —
  // not something the pairing gets to assume.
  if (notification.subject.kind !== 'agent-run') return null;
  if (String(notification.subject.agentRunId) !== String(pass.agentRunId)) return null;
  return submittedTurnOf(notification);
}

/**
 * Offer every line of this pass to the frozen command until one is accepted.
 *
 * One line promotes it or none does — the rest of the pass cannot also be the
 * same turn. A refusal means "not this line" and is the ordinary answer; the law
 * that produced it lives in the command, which is the point of this whole file.
 */
async function offerPass(
  supervision: SupervisionCore, notification: Notification, pass: CommittedPass,
  submitted: NonNullable<ReturnType<typeof submittedTurnOf>>,
): Promise<void> {
  for (const line of pass.lines) {
    const observed = await supervision.recordNotificationTranscriptObservation(
      transcriptContext(),
      {
        notificationId: notification.id,
        expectedRecordVersion: notification.recordVersion,
        expectedEffectKey: notification.deliveryEffectKey,
        terminalInputAttemptId: submitted.terminalInputAttemptId,
        evidence: {
          bindingId: pass.bindingId,
          transcriptLineId: line.transcriptLineId,
          agentRunId: pass.agentRunId,
          providerSessionId: pass.providerSessionId,
          providerTurnId: submitted.providerTurnId,
          sourcePosition: line.sourcePosition,
          sourceDigest: line.sourceDigest,
          // The same `sha256:<hex>` shape Supervision computes over the input it
          // authorised. Equality of these two is the whole difference between
          // "our turn" and "a turn".
          logicalInputDigest: `sha256:${line.textDigest}`,
        },
      },
    );
    if (observed.ok) return;
  }
}

export function notificationTranscriptObserver(
  supervision: SupervisionCore,
): NotificationTranscriptObserver {
  return {
    async observe(event: RunEvent): Promise<void> {
      const pass = passOf(event);
      if (pass === null) return;

      const waiting = await supervision.listNotifications(READER, {
        state: AWAITING, limit: CANDIDATE_LIMIT,
      });
      if (!waiting.ok) return;

      for (const notification of waiting.value.items) {
        const submitted = pairableWith(notification, pass);
        if (submitted !== null) await offerPass(supervision, notification, pass, submitted);
      }
    },
  };
}
