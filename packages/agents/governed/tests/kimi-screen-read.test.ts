// The gate reading a REAL kimi screen (NVK-KIMI-034).
//
// `tests/fixtures/kimi-gate-screen.txt` is 63KB of bytes a real `kimi` 0.31.1
// wrote to a real PTY at the Runtime's own 400-column viewport, captured by
// `tests/kimi-gate-read-probe.mts` while it was answering the gate's own turn 1.
// Nothing in it was typed by hand. The model's reply is in there, correct and
// complete — and the public three-generation proof still failed generation 3
// with "no confirmation arrived before the gate timed out", twice.
//
// Why a fixture and not a mock: the shape that breaks the gate is not something
// anyone would think to imitate. kimi streams a reply by repainting ONE row and
// ending each paint with a bare carriage return and no line feed, so the spinner
// frames and every partial answer are interleaved into what an LF-split reads as
// a single line — and the FIRST marker in that line is a half-painted
// `SKILLS-CONFIRMED:` with a spinner after it, not the answer.
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
const SCREEN = readFileSync(path.join(here, 'fixtures', 'kimi-gate-screen.txt'), 'utf8');

/** The turn 1 that produced this screen, and the fingerprint it ended with. */
const MARKER = 'SKILLS-CONFIRMED:';
const FINGERPRINT = '(novakai turn 0123456789ab)';
const TOKENS = [
  'elite-codebase-engineering@v3#a1b2c3d4',
  'test-driven-development@v2#e5f6a7b8',
];
const TURN_ONE = [
  'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
  '',
  'TASK CONTEXT: Say the word DAMSON once, then stop.',
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

test('the answer a real kimi painted is on the screen the gate is handed', () => {
  // Guards the fixture itself: if this ever fails the capture is broken, and the
  // test below would be proving something about nothing.
  const compact = plainText(SCREEN).replace(/\s+/gu, '');
  assert.ok(compact.includes(`${MARKER}["${TOKENS[0]!}","${TOKENS[1]!}"]`),
    'the fixture no longer contains a complete confirmation');
});

test('the gate finds the confirmation a real kimi painted', () => {
  const line = gateReads(SCREEN);
  assert.notEqual(line, null, 'the gate read no confirmation off a screen that has one');
});

test('what the gate reads off that screen judges as the pinned set', () => {
  const line = gateReads(SCREEN)!;
  const body = line.slice(line.indexOf(MARKER) + MARKER.length).trim();
  assert.deepEqual(JSON.parse(body), TOKENS);
});

test('a half-painted marker is never taken for the answer', () => {
  // The exact shape that defeated it: one row repainted with bare carriage
  // returns, the first marker in it still empty, the complete answer last.
  const repainted = [
    'context: 0% (0/1M)',
    ' ⠹ working... · Tip: /tasks to check progress',
    ` ● ${MARKER}`,
    ' ⠹ working... · Tip: /tasks to check progress',
    ` ● ${MARKER} ["${TOKENS[0]!}",`,
    ' ⠹ working... · Tip: /tasks to check progress',
    ` ● ${MARKER} ["${TOKENS[0]!}", "${TOKENS[1]!}"]`,
  ].join('\r');
  const line = findMarkerLine(repainted, MARKER);
  assert.notEqual(line, null, 'a row repainted with carriage returns hid the answer');
  const body = line!.slice(line!.indexOf(MARKER) + MARKER.length).trim();
  assert.deepEqual(JSON.parse(body), TOKENS);
});
