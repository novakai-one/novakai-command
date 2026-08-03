// Reading a provider's screen (§13.5, NVK-KIMI-030 N-1, NVK-KIMI-054).
//
// The gate judges one thing — what the AGENT said — and everything in this file
// exists to separate that from what the Runtime typed at it. That used to be
// done by subtracting the lines of the prompt from the output, which works
// perfectly against a session that echoes line for line and not at all against
// a real TUI: the composer takes the turn as one long line, re-wraps it at the
// window width, and paints each word at an explicit cursor column. No row on
// that screen equals a line the Runtime composed, so nothing was subtracted,
// and when the wrap landed on the confirmation marker the gate read its own
// instruction sentence back as the agent's answer.
//
// Position is the property a reflow cannot destroy. That is what these
// functions find.

/** How many rows one paint may move without saying where it landed. */
const MAX_ROW_JUMP = 512;

/**
 * What a human would read off the screen: the provider's paint replayed, so a
 * match is about what was SAID and not about how the provider painted it.
 *
 * This used to DELETE every escape sequence, and deleting a cursor move is not
 * a neutral act. A TUI redrawing a row it has already drawn does not redraw the
 * whole row — it steps the cursor over the columns whose content is already
 * correct and paints only the runs that changed. Straight out of a real claude
 * PTY (`packages/agents/b3/tests/fixtures/claude-gate-screen.txt`):
 *
 *     then one space, then a\u001B[26GJSON\u001B[32Grray of the\u001B[44Gt\u001B[46Gkens
 *
 * for a screen that reads `then a JSON array of the tokens`. The `a` of "array"
 * and the `o` of "tokens" are not in that stream at all; they are already on the
 * screen. Delete the jumps and the surviving runs glue together — `aJSONrray of
 * thetkens` — with every stepped-over character silently gone.
 *
 * That is NVK-048 class 6, and it was fatal about one governed spawn in three:
 * harmless while the skipped columns held spaces, and a false conviction the
 * moment one held a character of the token. `p10` recorded the product
 * terminating a Run and writing skills drift against an agent whose answer was
 * verbatim correct, on the strength of `nvk048-skll@v1#d0`.
 *
 * So the positioning is replayed onto rows instead. Everything else — colour,
 * cursor visibility, synchronised-update and alt-screen modes, window titles —
 * still goes, because none of it moves a character.
 *
 * What comes back is a TRANSCRIPT of paints, not a final screen: a row is
 * emitted each time the cursor leaves it or returns to its start, so a row
 * repainted ten times appears ten times, latest last. The gate needs the
 * history — a confirmation a spinner has since painted over is still something
 * the agent said — and every reader downstream takes the LAST match, so the
 * newest paint is the one that wins.
 */
export function plainText(output: string): string {
  return replay(output);
}

/** The rows a paint has touched, and where the next character lands. */
interface Screen {
  readonly rows: string[][];
  readonly emitted: string[];
  row: number;
  column: number;
  saved: { readonly row: number; readonly column: number } | null;
}

function rowAt(screen: Screen, row: number): string[] {
  while (screen.rows.length <= row) screen.rows.push([]);
  return screen.rows[row]!;
}

/** This row into the transcript, as it currently reads. */
function emit(screen: Screen): void {
  screen.emitted.push((screen.rows[screen.row] ?? []).join('').replace(/\s+$/u, ''));
}

/** One character, at the cursor — over whatever the last paint left there. */
function put(screen: Screen, character: string): void {
  const row = rowAt(screen, screen.row);
  while (row.length < screen.column) row.push(' ');
  row[screen.column] = character;
  screen.column += 1;
}

/**
 * Leave this row for another one, and keep what it said.
 *
 * The jump is bounded. A stream is read while it is still arriving, so a
 * mangled parameter is a real possibility, and a row index taken on faith is
 * one allocation loop away from taking the Runtime down.
 */
function toRow(screen: Screen, row: number): void {
  emit(screen);
  screen.row = Math.min(Math.max(0, row), screen.row + MAX_ROW_JUMP);
  rowAt(screen, screen.row);
}

/**
 * The CSI sequence starting at `index`, or `null` if what is there is not one.
 *
 * A stream can end mid-sequence, and a provider can emit a private form nobody
 * here models. Neither is a licence to swallow the text that follows: an
 * unrecognised escape costs its own two characters and nothing else.
 */
function csiAt(
  output: string, index: number,
): { readonly params: string; readonly final: string; readonly end: number } | null {
  let scan = index + 2;
  while (scan < output.length && /[0-9;?<>=!]/u.test(output[scan]!)) scan += 1;
  const paramsEnd = scan;
  while (scan < output.length && /[ -/]/u.test(output[scan]!)) scan += 1;
  const final = output[scan];
  if (final === undefined || !/[@-~]/u.test(final)) return null;
  return { params: output.slice(index + 2, paramsEnd), final, end: scan + 1 };
}

/** The first numeric parameter, defaulted the way a terminal defaults it. */
function firstParam(params: string, fallback: number): number {
  const head = (params.replace(/^[?<>=!]/u, '').split(';')[0] ?? '');
  const value = Number.parseInt(head, 10);
  return Number.isNaN(value) ? fallback : value;
}

/** An erase-in-line, in the three forms a TUI actually emits. */
function eraseInLine(screen: Screen, mode: number): void {
  const row = rowAt(screen, screen.row);
  if (mode === 0) row.length = Math.min(row.length, screen.column);
  else if (mode === 1) {
    for (let at = 0; at <= screen.column && at < row.length; at += 1) row[at] = ' ';
  } else if (mode === 2) row.length = 0;
}

/**
 * Everything the positioning subset does, and nothing else.
 *
 * Returns whether the sequence was understood. One that was not is still
 * removed — it paints no character — but the caller ends the current row first,
 * so two runs either side of a jump this function cannot follow are never glued
 * into a word that was never on the screen. That is the whole defect in
 * miniature: being silent about a move is worse than breaking the line.
 */
function applyCsi(screen: Screen, params: string, final: string): boolean {
  switch (final) {
    case 'G': case '`': screen.column = Math.max(0, firstParam(params, 1) - 1); return true;
    case 'C': case 'a': screen.column += firstParam(params, 1); return true;
    case 'D': screen.column = Math.max(0, screen.column - firstParam(params, 1)); return true;
    case 'A': toRow(screen, screen.row - firstParam(params, 1)); return true;
    case 'B': case 'e': toRow(screen, screen.row + firstParam(params, 1)); return true;
    case 'K': eraseInLine(screen, firstParam(params, 0)); return true;
    // Colour, cursor visibility, mode switches, device reports, scroll regions,
    // window manipulation: dressing. None of it moves a character, so none of
    // it needs the line broken.
    case 'm': case 'h': case 'l': case 'n': case 'c': case 'q': case 'u': case 'r': case 't':
      return true;
    default: return false;
  }
}

/** Past an OSC, or past nothing if the terminator has not arrived yet. */
function afterOsc(output: string, index: number): number {
  const rest = output.slice(index + 2);
  const bell = rest.indexOf('\u0007');
  const st = rest.indexOf('\u001B\\');
  if (bell < 0 && st < 0) return index + 2;
  const at = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
  return index + 2 + at + (rest[at] === '\u0007' ? 1 : 2);
}

/**
 * The screen a provider painted, replayed row by row.
 *
 * Absolute addressing (`CUP`, erase-in-display, the alt-screen paints codex
 * lives in) is deliberately NOT modelled: those are relative to a VIEWPORT, and
 * what arrives here is a whole session's stream, where "row 1 of the screen" is
 * not a row of the transcript. They break the row instead — which gives up a
 * join that was never safe to make, rather than inventing a position.
 */
function replay(output: string): string {
  const screen: Screen = { rows: [[]], emitted: [], row: 0, column: 0, saved: null };

  for (let index = 0; index < output.length;) {
    const character = output[index]!;

    if (character === '\u001B') {
      const next = output[index + 1];
      if (next === '[') {
        const csi = csiAt(output, index);
        if (csi === null) { index += 2; continue; }
        if (!applyCsi(screen, csi.params, csi.final)) toRow(screen, screen.row + 1);
        index = csi.end;
        continue;
      }
      if (next === ']') {
        // Window titles, progress state, and the hyperlink terminator a real
        // kimi paints at the end of every row. Left in, one sits between a
        // wrapped confirmation and its continuation and makes the two
        // unjoinable.
        index = afterOsc(output, index);
        continue;
      }
      if (next === '7') {
        screen.saved = { row: screen.row, column: screen.column };
        index += 2;
        continue;
      }
      if (next === '8') {
        if (screen.saved !== null) {
          toRow(screen, screen.saved.row);
          screen.column = screen.saved.column;
        }
        index += 2;
        continue;
      }
      // Charset selection and the other short escapes: no movement.
      index += next !== undefined && /[()*+]/u.test(next) ? 3 : 2;
      continue;
    }

    if (character === '\n') { toRow(screen, screen.row + 1); index += 1; continue; }
    if (character === '\r') {
      // A repaint of this row is about to begin, and what it says now is
      // something the agent said. Kept, then painted over.
      emit(screen);
      screen.column = 0;
      index += 1;
      continue;
    }
    if (character === '\b') { screen.column = Math.max(0, screen.column - 1); index += 1; continue; }
    if (character === '\t') { screen.column += 8 - (screen.column % 8); index += 1; continue; }
    // Bell, and the shift-in/shift-out a kimi emits around its box drawing.
    if (character === '\u0007' || character === '\u000E' || character === '\u000F') {
      index += 1;
      continue;
    }

    put(screen, character);
    index += 1;
  }

  emit(screen);
  return screen.emitted.join('\n');
}

/**
 * The screen with the whitespace taken out, and a map back to where each
 * surviving character came from.
 *
 * A TUI does not type spaces. It moves the cursor to a column and paints the
 * next word, so once the CSI sequences are stripped the words run together: the
 * re-probe read `(novakaiturnfb276bd5d5ba)` off a real session for a fingerprint
 * composed as `(novakai turn fb276bd5d5ba)`. Any anchor that has to be FOUND on
 * a real screen has to be looked for in this form.
 */
function compacted(text: string): { readonly text: string; readonly origin: readonly number[] } {
  let compact = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/u.test(character)) continue;
    compact += character;
    origin.push(index);
  }
  return { text: compact, origin };
}

/** Whether this session has already been asked, however its TUI painted it. */
export function bearsFingerprint(output: string, fingerprint: string): boolean {
  return compacted(output).text.includes(fingerprint.replace(/\s+/gu, ''));
}

/**
 * Everything that arrived after turn 1 finished painting, or `null` if turn 1
 * has not appeared on the screen yet.
 *
 * The prompt ends with its fingerprint — the one short string only the Runtime
 * could have written — so the last time that fingerprint appears is the last
 * time turn 1 finished being painted, and an answer to turn 1 can only be after
 * it.
 */
export function afterPromptEcho(output: string, fingerprint: string): string | null {
  const screen = compacted(output);
  const needle = fingerprint.replace(/\s+/gu, '');
  const found = screen.text.lastIndexOf(needle);
  if (found < 0) return null;
  return output.slice(screen.origin[found + needle.length] ?? output.length);
}

/**
 * The part of the screen that can possibly be an answer to turn 1.
 *
 * Two anchors, and the later one wins. The prompt's echo is the stronger — it
 * ends exactly where the Runtime stopped speaking — and it survives a reflow
 * because it is found in the whitespace-free form. Where a provider does not
 * echo at all there is nothing to find, and the fallback is the offset the
 * screen stood at when turn 1 went out.
 *
 * A screen that has neither is a screen where nothing that could be an answer
 * has arrived, and the honest verdict there is silence, not a guess.
 */
export function sinceTheQuestion(
  screen: string, fingerprint: string, paintedBefore: number,
): string | null {
  const afterEcho = afterPromptEcho(screen, fingerprint);
  if (afterEcho !== null) return afterEcho;
  if (screen.length <= paintedBefore) return null;
  return screen.slice(paintedBefore);
}

/**
 * Drop every line the Runtime itself typed at this session.
 *
 * A belt, not the braces. It is exact and cheap against a session that echoes
 * faithfully, and it was the ONLY defence until N-1 showed that a reflowing
 * composer defeats it completely. `sinceTheQuestion` is what holds now.
 */
export function withoutOurOwnWords(output: string, ours: ReadonlySet<string>): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !ours.has(line.trim()))
    .join('\n');
}
