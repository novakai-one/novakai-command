/* eslint-disable id-length -- `ok` is the frozen result field every B3 caller
   reads (FZ-CLI-SCHEMA-001/011). */
// shell/app/b3Envelope.ts — the one place the Shell turns a B3 wire answer into
// a value.
//
// Every method on FZ-VIEW-001 answers in the same envelope: `{ok:true, value}`
// or `{ok:false, error:{code,message}}`. Before this file the Runs door owned a
// private copy of that parse and the terminal client owned another one with
// different field names (`succeeded`), which is how the same refusal could reach
// two screens in two shapes. One parse, at the seam, from `unknown`.
import type { ShellReadResult } from '../contract/agentRuns.js';

/** A domain refusal, with the owner's own code and message kept. */
export function refused(
  error: { code?: unknown; message?: unknown } | undefined,
): ShellReadResult<never> {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'RuntimeUnavailable',
      message: typeof error?.message === 'string'
        ? error.message : 'the Runtime refused the request',
    },
  };
}

/** No answer at all — a dead socket is a state a screen must be able to DRAW. */
export function unavailable(message: string): ShellReadResult<never> {
  return { ok: false, error: { code: 'RuntimeUnavailable', message } };
}

/**
 * Parse one envelope. `accept` is the caller's own check on the VALUE, because
 * only the caller knows what it asked for — a page of Runs and a lease are both
 * legal answers, and neither should be handed on if the other arrived.
 */
export function readEnvelope<Value>(
  answer: unknown,
  accept: (value: unknown) => boolean,
  wrongShape: string,
): ShellReadResult<Value> {
  const frame = answer as {
    ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown };
  } | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('the Runtime returned no answer');
  }
  if (frame.ok !== true) return refused(frame.error);
  if (!accept(frame.value)) return unavailable(wrongShape);
  return { ok: true, value: frame.value as Value };
}

/** Anything that came back with an `ok:true` is accepted. */
export const anyValue = (): boolean => true;

/**
 * Run a call and turn a thrown transport error into the same envelope.
 *
 * This is the whole reason a screen can render a lost connection instead of
 * blanking: a socket that dies mid-command produces a value, not an exception
 * escaping into React (FZ-CLI-SCHEMA-011).
 */
export async function guarded<Value>(
  run: () => Promise<ShellReadResult<Value>>,
): Promise<ShellReadResult<Value>> {
  try {
    return await run();
  } catch (cause) {
    return unavailable(cause instanceof Error ? cause.message : String(cause));
  }
}
