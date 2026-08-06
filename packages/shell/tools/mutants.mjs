// shell/tools/mutants.mjs — the honesty laws, written as the edits that break them.
//
// B4. Every seat of this lane has reported "N mutants aimed, N killed" and left
// behind no way to run them again. That is the same shape as the defect L-08
// names: a claim about the tests that the tests themselves cannot check. A
// mutant that lives only in a report is a mutant that stops being true the first
// time somebody edits the file it was aimed at, silently.
//
// So each entry below is an executable claim: apply `to` in place of `from`, and
// the suite MUST go red. If it stays green, the law in `law` is currently
// unguarded — the code obeys it, and nothing would notice if it stopped.
//
// Rules for adding one:
//
//   1. `from` must appear EXACTLY ONCE in the file. The runner errors otherwise
//      rather than guessing, because an anchor that no longer matches would
//      report a kill it never earned.
//   2. Aim at a LAW, not at an implementation detail. A mutant that only breaks
//      a coincidence teaches the next seat to write a test pinning that
//      coincidence — which is exactly how the usage screen came to assert the
//      false empty (L-08).
//   3. The mutant must be something a person could plausibly write. `x + 1` on a
//      random constant is noise; dropping a guard clause is a Tuesday.

/**
 * @typedef {object} Mutant
 * @property {string} id      Stable handle, quoted in reports.
 * @property {string} slice   Which slice's law this is.
 * @property {string} file    Path relative to packages/shell.
 * @property {string} law     The sentence that stops being true. Present tense.
 * @property {string} from    Exact source text, must occur exactly once.
 * @property {string} to      What a plausible mistake would put there instead.
 */

/** @type {readonly Mutant[]} */
export const MUTANTS = [
  // ── B1.3 · Calm pacing (contract/calmPacing.ts) ───────────────────────────
  {
    id: 'CALM-01',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Law 3 — a ceiling of zero would drop every line and announce none of '
      + 'them, because nothing can ever be released to carry the marker.',
    from: '  const ceiling = Math.max(1, pacing.maxBufferedLines);',
    to: '  const ceiling = pacing.maxBufferedLines;',
  },
  {
    id: 'CALM-02',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'The OLDEST lines go when the buffer overflows — a terminal shows you '
      + 'now, and dropping the newest freezes the tab on old output.',
    from: '    pending: queued.slice(lost),',
    to: '    pending: queued.slice(0, ceiling),',
  },
  {
    id: 'CALM-03',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Law 3 — the gap marker goes where the lost output was, so it is '
      + 'announced with the lines that replaced it, never above them.',
    from: '  const announced = state.dropped > 0 && releasing.length > 0;',
    to: '  const announced = state.dropped > 0;',
  },
  {
    id: 'CALM-04',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Law 2 — the trailing partial waits for the queue to drain, or the '
      + 'prompt prints above the output it belongs under.',
    from: '  const drained = remaining.length === 0;',
    to: '  const drained = true;',
  },
  {
    id: 'CALM-05',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'A partial that has been released is forgotten — a state that keeps it '
      + 'reprints the prompt on every tick forever.',
    from: "  const partial = drained ? '' : state.partial;",
    to: '  const partial = state.partial;',
  },
  {
    id: 'CALM-06',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Time that did not buy a line stays banked — discarding it starves any '
      + 'tab whose rate is below one line per tick.',
    from: '  const creditMs = rate === 0 ? banked : banked - (allowed * 1_000) / rate;',
    to: '  const creditMs = 0;',
  },
  {
    id: 'CALM-07',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'A flush announces a gap once and clears it — a flush is not an '
      + 'amnesty, and it is not a second alarm either.',
    from: "    state: { ...state, pending: [], partial: '', dropped: 0, creditMs: 0 },",
    to: "    state: { ...state, pending: [], partial: '', creditMs: 0 },",
  },
  {
    id: 'CALM-08',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Law 4 — a flush gives you everything held, the unterminated tail '
      + 'included. That tail is usually the prompt.',
    from: "  const held = state.pending.join('') + state.partial;",
    to: "  const held = state.pending.join('');",
  },
  {
    id: 'CALM-09',
    slice: 'B1.3',
    file: 'contract/calmPacing.ts',
    law: 'Law 1 — Raw is the identity function. A Raw that touches the bytes is '
      + 'a Raw that lies about what the process printed.',
    from: 'export function rawPassthrough(text: string): string {\n  return text;\n}',
    to: 'export function rawPassthrough(text: string): string {\n  return text.trimEnd();\n}',
  },

  // ── B2.5 · The notification read (contract/notificationRead.ts) ───────────
  {
    id: 'NOTE-01',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'The marked row is the FIRST in attention order, not the first in '
      + 'whatever order the page happened to arrive in.',
    from: '  return orderInbox(candidates)[0]?.id ?? null;',
    to: '  return candidates[0]?.id ?? null;',
  },
  {
    id: 'NOTE-02',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'Settling a human escalation RELEASES the marker. A settled row that '
      + 'keeps the mark is a screen that never goes calm.',
    from: "    (isHumanEscalation(item) && !isSettled(item)) || item.state === 'transcript-observed');",
    to: "    isHumanEscalation(item) || item.state === 'transcript-observed');",
  },
  {
    id: 'NOTE-03',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'The ordering releases with the marker — a settled escalation stops '
      + 'outranking live rows instead of sitting at the top forever.',
    from: '  if (isHumanEscalation(item) && !isSettled(item)) return 0;',
    to: '  if (isHumanEscalation(item)) return 0;',
  },
  {
    id: 'NOTE-04',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'An unrecognised state ranks with the uncertain, never with the '
      + 'finished. Sorting the unfamiliar to the bottom is the Shell deciding an '
      + 'unfamiliar fact is boring (CL-S).',
    from: 'const UNKNOWN_RANK = 3;',
    to: 'const UNKNOWN_RANK = 8;',
  },
  {
    id: 'NOTE-05',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'A state outside the frozen six is drawn as ITSELF. This is the exact '
      + 'lookup that used to print "undefined" onto the attention surface.',
    from: '  return STATE_WORDS[item.state] ?? item.state;',
    to: "  return STATE_WORDS[item.state] ?? 'Unknown';",
  },
  {
    id: 'NOTE-06',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'A delivery mode outside the frozen three is drawn as itself, for the '
      + 'same reason the state is.',
    from: '  return DELIVERY_WORDS[item.deliveryMode] ?? item.deliveryMode;',
    to: "  return DELIVERY_WORDS[item.deliveryMode] ?? 'Unknown';",
  },
  {
    id: 'NOTE-07',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'The escalation SENTENCE belongs to the marked row alone. Seat 5 found '
      + 'this in a screenshot with all 357 tests green: two escalations, two '
      + 'full-ink lines, one screen reading as two emergencies.',
    from: '  if (attention) {',
    to: '  if (isHumanEscalation(item)) {',
  },
  {
    id: 'NOTE-08',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'Only a row the provider has actually seen can be settled — the UI '
      + 'must not offer an action the capability will refuse.',
    from: "  return rows.filter((item) => item.state === 'transcript-observed');",
    to: '  return rows.filter((item) => !isSettled(item));',
  },
  {
    id: 'NOTE-09',
    slice: 'B2.5',
    file: 'contract/notificationRead.ts',
    law: 'A page that hid rows is not the same page as one that hid none — the '
      + 'omissions the page reports are said.',
    from: '    if (omission.count > 0) said.push(`${omission.count} hidden · ${omission.reason}`);',
    to: '    if (omission.count > 0) said.push(String(omission.count));',
  },

  // ── B2.1 · The false empty, L-08's own origin (contract/listAnswer.ts) ────
  {
    id: 'LIST-01',
    slice: 'B2.1',
    file: 'contract/listAnswer.ts',
    law: 'No answer is not "none". This is the false empty itself — the defect '
      + 'a test used to PIN rather than catch (L-08).',
    from: "  if (input.source === null || input.source === undefined) return { kind: 'waiting' };",
    to: "  if (input.source === null || input.source === undefined) return { kind: 'none' };",
  },
  {
    id: 'LIST-02',
    slice: 'B2.1',
    file: 'contract/listAnswer.ts',
    law: 'An absent source is absent whichever way it is absent — `undefined` is '
      + 'as much "nobody answered" as `null` is.',
    from: "  if (input.source === null || input.source === undefined) return { kind: 'waiting' };",
    to: "  if (input.source === null) return { kind: 'waiting' };",
  },
  {
    id: 'LIST-03',
    slice: 'B2.1',
    file: 'contract/listAnswer.ts',
    law: 'A failure outranks everything — a list beside a failure must not read '
      + 'as a complete list, and a failure with no source is still a failure.',
    from: "  if (input.failure !== null) return { kind: 'failed', failure: input.failure };",
    to: "  if (input.failure !== null && input.source !== null) return { kind: 'failed', failure: input.failure };",
  },

  // ── B1.5 · The backed host: geometry, history, and one open (seat 11) ─────
  // Every one of these was found in a browser against a REAL nvk-server, and
  // none of them can go red offline: the mock services spawn no process, so an
  // unmeasured viewport goes nowhere and history arrives down one path only.
  {
    id: 'VIEW-01',
    slice: 'B1.5',
    file: 'contract/terminalViewport.ts',
    law: 'The fit addon\'s floor is a measurement that did not happen. Accepting '
      + 'it opens a real pty at two columns, and the shell mangles every prompt '
      + 'it draws from then on — permanently, in the session\'s replay.',
    from: '  if (cols <= XTERM_FIT_FLOOR.cols || rows <= XTERM_FIT_FLOOR.rows) return UNKNOWN;',
    to: '  if (cols <= 0 || rows <= 0) return UNKNOWN;',
  },
  {
    id: 'VIEW-02',
    slice: 'B1.5',
    file: 'contract/terminalViewport.ts',
    law: 'Nothing measured is unknown, never a default — a viewport is set on '
      + 'somebody else\'s process, so a guess is a write.',
    from: '  if (!proposed) return UNKNOWN;',
    to: '  if (!proposed) return { known: true, columns: 80, rows: 24 };',
  },
  {
    id: 'VIEW-03',
    slice: 'B1.5',
    file: 'contract/terminalViewport.ts',
    law: 'The Runtime is told when the size CHANGES. Telling it on every '
      + 'measurement signals the process for nothing, and each signal writes a '
      + 'prompt redraw into the permanent output history.',
    from: '  return current.columns !== next.columns || current.rows !== next.rows;',
    to: '  return true;',
  },
  {
    id: 'BOOT-01',
    slice: 'B1.5',
    file: 'ui/screens/terminal/bootFlow.ts',
    law: 'Nothing is opened before the surface has been measured. This is the '
      + 'defect itself: the mount effect opened a pty at whatever the unlaid-out '
      + 'terminal happened to say.',
    from: "  if (viewport === null) return { kind: 'not-measured' };",
    to: '  const size = viewport ?? { columns: 80, rows: 24 };',
  },
  {
    id: 'RPLY-01',
    slice: 'B1.5',
    file: 'contract/terminalReplay.ts',
    law: 'History the replay already wrote is not written again — the Runtime '
      + 'catches every new subscriber up on the same backlog the Shell reads.',
    from: '  return frame.sequence > mark;',
    to: '  return true;',
  },
  {
    id: 'RPLY-02',
    slice: 'B1.5',
    file: 'contract/terminalReplay.ts',
    law: 'A frame the Runtime did not number is DRAWN. Dropping live output '
      + 'makes a working process look like a dead one, which is worse than '
      + 'drawing the banner twice.',
    from: '  if (frame.sequence === undefined) return true;',
    to: '  if (frame.sequence === undefined) return false;',
  },
  {
    id: 'RPLY-03',
    slice: 'B1.5',
    file: 'contract/terminalReplay.ts',
    law: 'A gap carries none of the session\'s bytes, so it is never progress — '
      + 'taking it as progress drops the live frames that fill the hole.',
    from: "    if (frame.kind === 'gap') continue;",
    to: "    if (frame.kind === 'gap-never') continue;",
  },
  {
    id: 'OPEN-01',
    slice: 'B1.5',
    file: 'contract/terminalOpen.ts',
    law: 'A clientOpId names ONE request. The size is part of an open, so reusing '
      + 'the id across sizes is a different request under an old name — which the '
      + 'owner refuses (IdempotencyConflict) and New tab stops working.',
    from: '  return [workingDirectory, columns, rows].join(JOIN);',
    to: '  return workingDirectory;',
  },
];
