// How a turn reaches an interactive provider (§14, §24.2).
//
// Shared by the three production adapters and by the fake, and it lives HERE
// rather than in `fake.ts` — every real adapter importing its delivery rule
// from the test double was a seam pointing the wrong way (NVK-KIMI-031
// finding 6).
//
// ── What was measured, and on what ──────────────────────────────────────────
//
// 2026-08-02, raw PTYs, no Novakai machinery in the way. The harness is kept:
// `packages/agents/b3/tests/turn-delivery-probe.mts`. The turn is the gate's
// real turn 1 (532 characters). "SENT" means the CLI started working.
//
//   delivery                                    claude    codex     kimi
//   text and submit key in ONE write            NOT SENT  NOT SENT  NOT SENT
//   text, beat, submit key alone — FLATTENED    SENT      SENT      3 of 8
//   text, beat, submit key alone — LINES INTACT SENT      SENT      7 of 8
//
// Two separate findings live in that table.
//
// The submit key must be its OWN write. A big fast burst is taken for a paste,
// and a submit key inside that burst is absorbed into the pasted text instead
// of sending it — the turn lands in the composer, echoes, and sits there for
// ever. That is hold-out B3, and it is true of all three.
//
// And the flattening has to go. It was introduced on the belief that a composer
// treats an embedded newline as "add a line" and never submits, which is false:
// with the lines intact all three answered a brief that ASKED how many lines it
// had, and all three said three. What flattening actually bought was a turn
// `kimi` submits about a third of the time. It also silently rewrote every
// brief — code, JSON, Markdown, numbered instructions — before sending it, so
// what the agent was asked to do was not what the operator wrote.
import type { TurnDeliveryStep } from '../../contract/providers.js';

/** Every one of the three declares carriage return as its submit boundary. */
const SUBMIT_KEY = '\r';

/**
 * The beat between the text and the key.
 *
 * Measured, not guessed: 150ms already sufficed for a 2615-character turn, so
 * 250ms is the cheapest value with room above what was observed to work.
 */
const BEAT_MS = 250;

/**
 * The turn as written, then the key that sends it.
 *
 * The only thing changed on the way through is a bare carriage return inside
 * the text, which would submit half a turn. A CR in a brief means a line break,
 * so that is what it becomes.
 */
export function deliverTurn(text: string): readonly TurnDeliveryStep[] {
  return [
    { utf8Text: text.replace(/\r\n?/gu, '\n'), pauseMsAfter: BEAT_MS },
    { utf8Text: SUBMIT_KEY, pauseMsAfter: 0 },
  ];
}

/**
 * The shared line-finder: last occurrence wins, because a session that was
 * prompted twice must be judged on what it said LAST, and a provider that
 * echoes the prompt back would otherwise let the prompt confirm itself.
 */
export function findMarkerLine(text: string, marker: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.startsWith(marker)) return line;
  }
  return null;
}
