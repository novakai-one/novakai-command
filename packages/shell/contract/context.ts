// shell/contract/context.ts — context bus payloads (req 9, SHL-008, DEC-S2-6/7).
// The send-time snapshot travels with EVERY human-composed message (red gate 2:
// missing context = typed violation; {app, ref:'none'} counts as present —
// §22 ruling 7). Snapshot is taken at SEND time, never compose time (R3-12).
import type { Ref } from './types.js';
import type { ChatMessage } from './services.js';
import { getFocus } from './focus.js';
import {
  ok, fail, missingContext, type Result, type MissingContextError,
} from './errors.js';

/** What an agent can ask about: which app, and which object (or none). */
export interface ScreenContext {
  app: string;
  ref: Ref | 'none';
}

/** Red gate 2: context must be PRESENT. ref 'none' is present (ruling 7). */
export function requireContext(
  ctx: ScreenContext | null | undefined,
): Result<ScreenContext, MissingContextError> {
  if (!ctx || typeof ctx.app !== 'string' || ctx.app === '' || (ctx.ref !== 'none' && (typeof ctx.ref !== 'object' || ctx.ref === null))) {
    return fail(missingContext());
  }
  return ok(ctx);
}

/** Stamp the snapshot onto an outbound payload (payload inspection target). */
export function attachContext<T extends object>(payload: T, ctx: ScreenContext): T & { context: ScreenContext } {
  return { ...payload, context: ctx };
}

let seq = 0;

/**
 * The shell's human-compose path: builds the outbound ChatMessage with the
 * send-time focus snapshot attached. The snapshot is read HERE (at send),
 * so what travels is what Chris saw when he hit send.
 */
export function composeHumanMessage(
  input: { conversationId: string; text: string; id?: string; createdAt?: string },
  snapshot: ScreenContext = getFocus(),
): ChatMessage {
  return {
    id: input.id ?? `msg_${Date.now().toString(36)}_${(seq += 1)}`,
    conversationId: input.conversationId,
    senderId: 'me',
    text: input.text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    context: snapshot,
  };
}
