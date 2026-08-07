// shell/contract/context.ts — context bus payloads (req 9, SHL-008, DEC-S2-6/7).
// The send-time snapshot travels with EVERY human-composed message (red gate 2:
// missing context = typed violation; {app, ref:'none'} counts as present —
// §22 ruling 7). Snapshot is taken at SEND time, never compose time (R3-12).
//
// L-07: the type below was called `ScreenContext` and is NOT FZ-VIEW-015's
// `ScreenContext` — that one is `{captureId, capturedAt, source, support,
// advisoryOnly, contentRef?, limitations[]}`, advisory capture data Messaging
// owns. This one is "which app, which object", the focus the Shell reads at
// send time. Two different facts under one name, and the compose-and-send path
// (B2.3) is where both finally sit in one scope. The orchestrator's ruling was
// that the Shell-private name yields, so it did: `FocusSnapshot`, which says
// what it is. The frozen name is untouched, and the ECHO of it is
// `ScreenContextEcho` in contract/communications.ts — a name you cannot mistake
// for something this Shell is allowed to mint.
import type { Ref } from './types.js';
import type { ChatMessage } from './services.js';
import { getFocus } from './focus.js';
import {
  ok, fail, missingContext, type Result, type MissingContextError,
} from './errors.js';

/** What an agent can ask about: which app, and which object (or none). */
export interface FocusSnapshot {
  app: string;
  ref: Ref | 'none';
}

/** Red gate 2: context must be PRESENT. ref 'none' is present (ruling 7). */
export function requireContext(
  ctx: FocusSnapshot | null | undefined,
): Result<FocusSnapshot, MissingContextError> {
  if (!ctx || typeof ctx.app !== 'string' || ctx.app === '' || (ctx.ref !== 'none' && (typeof ctx.ref !== 'object' || ctx.ref === null))) {
    return fail(missingContext());
  }
  return ok(ctx);
}

/** Stamp the snapshot onto an outbound payload (payload inspection target). */
export function attachContext<T extends object>(payload: T, ctx: FocusSnapshot): T & { context: FocusSnapshot } {
  return { ...payload, context: ctx };
}

let seq = 0;

/**
 * The shell's human-compose path: builds the outbound ChatMessage with the
 * send-time focus snapshot attached. The snapshot is read HERE (at send),
 * so what travels is what Chris saw when he hit send.
 */
export function composeHumanMessage(
  input: { conversationId: string; text: string; id?: string; createdAt?: string; clientOpId?: string },
  snapshot: FocusSnapshot = getFocus(),
): ChatMessage {
  return {
    id: input.id ?? `msg_${Date.now().toString(36)}_${(seq += 1)}`,
    conversationId: input.conversationId,
    senderId: 'me',
    text: input.text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.clientOpId ? { clientOpId: input.clientOpId } : {}),
    context: snapshot,
  };
}
