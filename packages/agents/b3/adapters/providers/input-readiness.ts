// When a provider CLI is actually reading its input (§14, NVK-KIMI-078/079).
//
// Companion to `turn-delivery.ts`: that file says HOW a turn must be typed, this
// one says WHEN it may be typed at all. Both are per-provider screen contracts,
// and both are here rather than in the caller because only the adapter knows
// what its own CLI paints.
//
// ── The defect this exists for ──────────────────────────────────────────────
//
// A managed PTY reports `live` when the process was SPAWNED, which is not when
// the process is LISTENING. Claude Code opens by firing terminal-capability
// queries — bracketed paste, Kitty keyboard, OSC 11 background colour, two
// Primary Device Attributes, XTVERSION — and then parses the answers. Novakai
// answers none of them, so it sits in that parser for about a second. Bytes
// written into that window are consumed there: the turn never becomes a
// provider turn, claude writes no transcript at all, and the skills gate then
// polls a screen that will never change until its 120 s deadline expires.
//
// The product wrote 1 196 ms after PTY open. Measured against real
// `claude` 2.1.219 (NVK-KIMI-078, 17 raw-PTY arms, captures kept):
//
//   painted at write   arms                       result
//   0–77 B             fast200 sweep200 sweep500  never received (7/7)
//                      ready1–3 c400-1
//   882–1448 B         sweep1000/1500/2000        received 1.76–3.76 s (10/10)
//                      slow3000 c400-2/3 comp1–4
//
// Perfect separation, and NOT on elapsed time: c400-1 and c400-2/3 wrote at the
// same 1.2 s and went opposite ways. It is a state. A fixed sleep cannot fix it.
//
// The obvious cheap heuristic is also refuted: "output arrived, then went quiet"
// resolves at 77 B — the CLI goes quiet *because* it is waiting for the answers
// to the queries it just fired — and lost 3 of 3 (`ready1–3`).
//
// ── What each CLI paints, and when ─────────────────────────────────────────
//
// Boot captures taken first-hand for NVK-KIMI-079, no writes to the child, 120
// columns, cwd `/private/tmp/nvk-holdout-b3d`. Harness and raw captures:
// `build-reports/nvk079/boot-capture.mjs`, `boot-<provider>-c120.screen.txt`.
//
//   provider  version       what says "the composer exists"          first true
//   claude    2.1.219       two full-width `─` rules (the composer      1 100 ms
//                           box's top and bottom borders)
//   codex     0.146.0       the banner box CLOSED (`╰──…──╯`) and         595 ms
//                           the `›` composer caret painted
//   kimi      0.32.0        TWO closed boxes — the banner box and       1 717 ms
//                           the composer box under it
//
// Each predicate is that provider's own shape; there is deliberately no shared
// one. Codex draws a 43-column rounded box and puts its composer caret on a
// bare row beneath it, so "two full-width rules" would never be true of codex.
// Kimi draws its composer as a second box, so claude's two-rule test is
// satisfied by kimi's BANNER alone — a full box too early, which is exactly the
// failure being fixed. Sharing one predicate would be invented parity.
//
// The argument is the session's raw paint, escape sequences included — the same
// bytes Terminal holds in its replay buffer. It is not the replayed screen: the
// measurements above were taken on the raw stream, and a predicate must be
// tested on what it will actually be handed.

/**
 * A horizontal rule long enough to be furniture rather than content.
 *
 * Eight is well under the narrowest box any of the three draws (codex's is 43
 * columns at 120 cols) and well over anything that shows up inside a word.
 */
const RULE = /[─]{8,}/gu;

/** A rounded box that has been CLOSED — its bottom-left and bottom-right corner. */
const CLOSED_BOX = /╰─{8,}╯/gu;

function count(screen: string, pattern: RegExp): number {
  return (screen.match(pattern) ?? []).length;
}

/**
 * Claude: the composer box is a pair of full-width `─` rules with the `❯`
 * placeholder row between them. Both borders painted means the box exists.
 *
 * Measured 1 100 ms after spawn at 120 columns. Every one of the 17 NVK-078
 * captures reaches this state; none of the seven that lost the turn had reached
 * it when the product wrote.
 */
export function claudeInputReadyOn(screen: string): boolean {
  return count(screen, RULE) >= 2;
}

/**
 * Codex: a closed banner box, and the `›` caret it puts its composer on.
 *
 * Both halves are load-bearing. The box alone is painted while the model line
 * still reads `model: loading`, and the caret alone would match the character
 * anywhere in a reply.
 */
export function codexInputReadyOn(screen: string): boolean {
  return count(screen, CLOSED_BOX) >= 1 && screen.includes('›');
}

/**
 * Kimi: two closed boxes — the welcome banner, then the composer box below it.
 *
 * One closed box is the banner, and kimi paints that before the composer
 * exists. The second is the composer.
 */
export function kimiInputReadyOn(screen: string): boolean {
  return count(screen, CLOSED_BOX) >= 2;
}
