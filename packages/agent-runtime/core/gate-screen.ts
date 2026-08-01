// Reading a provider's screen (§13.5, NVK-KIMI-030 N-1).
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

/**
 * What a human would read off the screen: ANSI dressing removed, so a match is
 * about what was SAID and not about how the provider painted it.
 */
export function plainText(output: string): string {
  return output.replace(/\[[0-9;?]*[A-Za-z]/gu, '');
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
