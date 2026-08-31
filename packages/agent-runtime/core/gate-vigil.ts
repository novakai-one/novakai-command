// Watching a session that has been asked a question.
//
// A provider CLI does not read its stdin until it has finished painting itself,
// and turn 1 goes out within a second of the PTY starting. The bytes are not
// bounced back by the application — the tty's own line discipline echoes them —
// so the transcript looks the same whether the provider read them or not. What
// differs is what happens NEXT: a session that received a question is busy, and
// one that never did is perfectly still. Stillness, not a stopwatch, is what
// earns a second ask.
import { b3ok, type B3Result, type CommandContext } from '@novakai/foundation/contract';
import type { TurnDeliveryStep } from '../contract/types.js';
import type { RunsCore } from './runs-context.js';

/** How still a session must be before turn 1 is asked again. */
const UNANSWERED_TURN_MS = 12_000;
/** Bounded: a session that has ignored four identical questions is not listening. */
const MAX_PROMPT_SENDS = 4;

export interface Vigil {
  asked: number;
  quietSince: number;
  painted: number;
}

export const startVigil = (core: RunsCore): Vigil =>
  ({ asked: 1, quietSince: core.clock(), painted: 0 });

/** Anything painted at all resets the clock this waits on. */
export function noteStillness(core: RunsCore, vigil: Vigil, seen: string): void {
  if (seen.length === vigil.painted) return;
  vigil.painted = seen.length;
  vigil.quietSince = core.clock();
}

/**
 * Nothing has answered and nothing is happening: ask again — the SAME question,
 * so a session that gets two copies is asked one thing twice. Never the work
 * turn, which exactly one valid confirmation releases.
 *
 * The repeat carries its OWN effect key. Reusing the first attempt's key would
 * make it an idempotent replay and the write would be swallowed — the exact
 * shape that made the work turn disappear before P0-1.
 */
export async function maybeAskAgain(
  core: RunsCore,
  context: CommandContext,
  turn: {
    readonly terminalSessionId: string;
    readonly effectKey: string;
    readonly keystrokes: readonly TurnDeliveryStep[];
  },
  vigil: Vigil,
): Promise<B3Result<null>> {
  void context;
  void turn;
  if (core.clock() - vigil.quietSince < UNANSWERED_TURN_MS) return b3ok(null);
  if (vigil.asked >= MAX_PROMPT_SENDS) return b3ok(null);
  // A semantic submit that crossed the provider-effect boundary is never
  // retried from screen stillness. PTY quiet cannot prove the provider missed
  // it, and a second raw write would be a second uncorrelated provider turn.
  vigil.asked = MAX_PROMPT_SENDS;
  vigil.quietSince = core.clock();
  return b3ok(null);
}
