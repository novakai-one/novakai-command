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
 * The confirmation the agent painted, dug out of the furniture around it.
 *
 * "Last occurrence wins" is the security half: a session prompted twice is
 * judged on what it said LAST, and a provider that echoes the prompt back must
 * not be able to confirm itself. Everything else here is about what a real TUI
 * does to a line of text.
 *
 * `startsWith(marker)` was the whole of this function, and against a real codex
 * it found nothing: codex prints its reply as `• SKILLS-CONFIRMED: [...]` and
 * paints the composer's placeholder onto the SAME row, so the marker is neither
 * at the start of the line nor at the end of it. The line was on the screen, in
 * full, correct — and a governed codex Run died at the gate for 120 seconds of
 * silence (NVK-KIMI-032, rebuilt public proof).
 *
 * So: a decoration BEFORE the marker is allowed, and where a JSON array starts
 * right after the marker the line ends where that array ends. A reply that is
 * not an array is still returned in full, because an agent that answers WRONG
 * must be judged and recorded as drift rather than left to time out.
 */
export function findMarkerLine(text: string, marker: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const from = line.indexOf(marker);
    if (from < 0) continue;
    const said = line.slice(from);
    // Decoration before the marker is allowed ONLY when what follows is
    // unmistakably an answer. Turn 1 itself contains the sentence "start it
    // with SKILLS-CONFIRMED:" — marker at the end of the line, nothing after
    // it — and a kimi TUI repaints that row often enough to land it after the
    // prompt's own fingerprint, where the gate's position anchor can no longer
    // exclude it. Requiring the array shuts that door without closing the one
    // codex needs.
    if (from > 0 && !arrayStartsAfter(said, marker.length)) continue;
    const whole = closeArray(said, marker.length, lines.slice(index + 1));
    if (whole !== null) return whole;
  }
  return null;
}

/** Whether a JSON array opens immediately after the marker. */
function arrayStartsAfter(said: string, markerLength: number): boolean {
  const opened = said.indexOf('[', markerLength);
  return opened >= 0 && said.slice(markerLength, opened).trim() === '';
}

/**
 * The confirmation, ended where its array ends — across a wrap if it has to be,
 * and `null` while it is still being painted.
 *
 * A screen is not a transcript, and a streaming reply is not a finished one.
 * Two things were learned from a real kimi, both by watching a correct agent be
 * convicted:
 *
 *   - the canonical reply for two pinned skills is about 100 characters after
 *     the marker, so it WRAPS. Judging the row the marker is on reported "the
 *     confirmation was not a JSON array" over an array that was on the screen,
 *     complete, one line lower.
 *   - the reply arrives a piece at a time, so for a moment the screen holds
 *     `SKILLS-CONFIRMED:` and nothing else. Judged, an empty body is not JSON
 *     either — and the Run was terminated for skills drift a few hundred
 *     milliseconds before its own answer arrived.
 *
 * So a marker whose body is empty, or whose array has not closed yet, is not an
 * answer: it is an answer in progress, and the gate waits. A reply that is not
 * an array AT ALL comes back untouched, because an agent that answers WRONG
 * must be judged and recorded as drift rather than left to time out.
 */
function closeArray(
  said: string, markerLength: number, following: readonly string[],
): string | null {
  if (said.slice(markerLength).trim() === '') return null;
  const opened = said.indexOf('[', markerLength);
  if (opened < 0 || said.slice(markerLength, opened).trim() !== '') return said;
  let joined = said;
  for (let extra = 0; extra <= following.length; extra += 1) {
    const ends = arrayEnd(joined, opened);
    if (ends !== null) return joined.slice(0, ends + 1);
    if (extra === following.length) break;
    joined += following[extra]!;
  }
  return null;
}

/** Where the array that opened at `opened` closes, or `null` if it does not. */
function arrayEnd(said: string, opened: number): number | null {
  let depth = 0;
  const quote = { open: false, escaped: false };
  for (let index = opened; index < said.length; index += 1) {
    const character = said[index]!;
    if (quote.open) {
      stepThroughQuote(quote, character);
      continue;
    }
    if (character === '"') quote.open = true;
    else if (character === '[') depth += 1;
    else if (character === ']' && (depth -= 1) === 0) return index;
  }
  return null;
}

/** One character inside a JSON string literal: escapes, and the closing quote. */
function stepThroughQuote(quote: { open: boolean; escaped: boolean }, character: string): void {
  if (quote.escaped) {
    quote.escaped = false;
    return;
  }
  if (character === '\\') quote.escaped = true;
  else if (character === '"') quote.open = false;
}
