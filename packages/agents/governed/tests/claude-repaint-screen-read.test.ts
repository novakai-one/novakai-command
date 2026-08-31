// The gate reading a REAL claude screen (NVK-KIMI-054, NVK-048 class 6).
//
// `tests/fixtures/claude-gate-screen.txt` is 29KB of bytes a real `claude` TUI
// wrote to a real PTY while it was answering the gate's own turn 1, captured by
// NVK-048's `repro-v2.mjs` (`/tmp/nvk-048/out/repro-9DE2C59E-turn1.pty.txt`).
// Nothing in it was typed by hand.
//
// The shape that breaks the gate is DIFFERENTIAL REPAINT. A TUI that redraws a
// row it has already drawn does not redraw the whole row: it jumps the cursor
// over the columns whose content is already correct and paints only the runs
// that changed. Straight from the fixture —
//
//   then one space, then a\x1b[26GJSON\x1b[32Grray of the\x1b[44Gt\x1b[46Gkens
//
// — where the screen reads `then a JSON array of the tokens`. The `a` of
// "array" and the `o` of "tokens" are not in the stream at all on this pass;
// they are already on the screen, and the cursor steps over them.
//
// A reader that DELETES the cursor jump glues the surviving runs together and
// silently deletes every character that was stepped over. That is not a
// cosmetic loss. NVK-048's `p10` run recorded it landing on the answer:
//
//   reason: "the confirmation is not the pinned set (expected 1 token(s))"
//   confirmedSkills: ["nvk048-skll@v1#d0"]        // pinned: nvk048-sk_i_ll
//
// A verbatim-correct agent, convicted of skills drift for a character its
// provider never needed to send twice. ~1 spawn in 3: harmless when the skipped
// columns hold spaces, fatal when one holds a character of the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMarkerLine } from '../adapters/providers/turn-delivery.js';
// The gate's own screen reading, imported rather than imitated: this test is
// only worth anything if it fails where the gate fails.
import {
  plainText, sinceTheQuestion, withoutOurOwnWords,
} from '../../../agent-runtime/core/gate-screen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = readFileSync(path.join(here, 'fixtures', 'claude-gate-screen.txt'), 'utf8');

/** The turn 1 that produced this screen, and the fingerprint it ended with. */
const MARKER = 'SKILLS-CONFIRMED:';
const FINGERPRINT = '(novakai turn ff2de3eb31c7)';
const TOKENS = ['nvk048-skill@v1#d0'];
const TURN_ONE = [
  'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
  '',
  'TASK CONTEXT: Ignore this brief. NVK0489DE2C59EBRIEF',
  '',
  `Required skills, already resolved for you (${String(TOKENS.length)}, in this order):`,
  ...TOKENS.map((token, index) => `  ${String(index + 1)}. ${token}`),
  '',
  `Reply with EXACTLY ONE line and no other content: start it with ${MARKER}`,
  'then one space, then a JSON array of the tokens above, quoted, in the order',
  'listed. Nothing before the marker on that line, and nothing after the array.',
  '',
  FINGERPRINT,
].join('\n');

const OURS = new Set(
  TURN_ONE.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
);

/** `awaitConfirmation`'s decision, with the same functions in the same order. */
function gateReads(screen: string): string | null {
  const since = sinceTheQuestion(plainText(screen), FINGERPRINT, 0);
  if (since === null) return null;
  return findMarkerLine(withoutOurOwnWords(since, OURS), MARKER);
}

test('the fixture is a real screen that carries a complete confirmation', () => {
  // Guards the fixture itself: if this ever fails the capture is broken, and the
  // tests below would be proving something about nothing.
  const compact = plainText(SCREEN).replace(/\s+/gu, '');
  assert.ok(compact.includes(`${MARKER}["${TOKENS[0]!}"]`),
    'the fixture no longer contains a complete confirmation');
});

test('a differentially repainted row is read as the words it shows', () => {
  // The defect at its source, on unmodified provider bytes. These are the
  // Runtime's OWN sentences coming back off the screen, so what they should read
  // as is not a matter of opinion — it is in `TURN_ONE` above, character for
  // character. Today they come back as `aJSONrray of thetkens`.
  const screen = plainText(SCREEN);
  for (const sentence of [
    'then a JSON array of the tokens above',
    'Nothing before the marker on that line',
  ]) {
    assert.ok(screen.includes(sentence),
      `the screen deleted characters a real claude stepped over: ${
        JSON.stringify(screen.slice(Math.max(0, screen.indexOf(sentence.slice(0, 12)) - 20), screen.indexOf(sentence.slice(0, 12)) + 90))}`);
  }
});

/**
 * The confirmation, painted the way the fixture paints a repainted row.
 *
 * Built from the real grammar rather than copied, because `p10`'s own PTY bytes
 * were not kept — only what the product stored about them. Paint 1 streams the
 * answer as far as the `i` of `skill`; paint 2 redraws the row and steps over
 * that one column, because it is already correct on screen. Every byte here is
 * a shape the fixture contains.
 */
function repaintedConfirmation(): string {
  const said = `● ${MARKER} ${JSON.stringify(TOKENS)}`;
  const column = 2;
  const stepped = said.indexOf('nvk048-sk') + 'nvk048-sk'.length; // the `i`
  const at = (zeroBased: number): string => `[${String(zeroBased + 1)}G`;
  return [
    // Paint 1: the reply so far, ending on the character that will be stepped over.
    at(column), said.slice(0, stepped + 1),
    // Paint 2: same row, redrawn — and column `stepped` is skipped.
    '\r', at(column), said.slice(0, stepped),
    at(column + stepped + 1), said.slice(stepped + 1),
    '[K\r\n',
  ].join('');
}

test('a repainted confirmation is not convicted of a character it never lost', () => {
  // NVK-048 `p10`, reconstructed: the answer is correct, the screen shows it
  // correct, and the read hands the judge `nvk048-skll@v1#d0`.
  const line = findMarkerLine(plainText(repaintedConfirmation()), MARKER);
  assert.notEqual(line, null, 'the gate read no confirmation off a screen that has one');
  const body = line!.slice(line!.indexOf(MARKER) + MARKER.length).trim();
  assert.deepEqual(JSON.parse(body), TOKENS);
});
