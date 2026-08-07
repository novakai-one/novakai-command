// shell/contract/terminalTabStrip.ts — the tab strip's view-model (FZ-VIEW-017).
//
// A strip entry is a JOIN of two authorities, and the whole reason this file
// exists is that the join is where they get blurred:
//
//   durable `terminalTab` record  → a SHELL fact: which windows Chris has open.
//   Runtime `TerminalTabView`     → a SESSION fact: what is actually running.
//
// The Shell owns the first and only ever reads the second. So when the Runtime
// does not report a tab's session, the Shell does not get to fill the gap: it
// says unknown. FZ-VIEW-034 names the three tempting lies — dropping the tab
// (it exists), calling it exited (nobody said that), and drawing `0 windows
// attached` (that is the false zero, stated in the freeze as "Unavailable is
// not zero"). B0 found exactly that lie on the Runs screen; this is the same
// defect one screen over, refused up front.
//
// Pure on purpose: no driver, no React, no clock. The controller does the
// asking; this decides what the answer means.
import type { TerminalTabRecord } from './terminalTab.js';
import type { TerminalTabView } from './terminalServices.js';

/**
 * What the Runtime knows about a tab's session — a discriminated union rather
 * than an optional view, so "we did not ask / it is not there" cannot be read
 * as a value by accident. `known: false` has no `view` to reach for at all.
 */
export type TabSessionTruth =
  | { readonly known: true; readonly view: TerminalTabView }
  | { readonly known: false };

export interface TerminalTabStripEntry {
  readonly tabId: string;
  readonly title: string;
  readonly terminalSessionId: string;
  readonly mode: 'raw' | 'calm';
  readonly session: TabSessionTruth;
}

/**
 * A tab whose `title` is empty still has to be a clickable thing with a name.
 * The session's tail is used rather than "Untitled": it is the one label that
 * distinguishes two untitled tabs from each other, which is the only job the
 * fallback actually has.
 */
export function titleForTab(record: TerminalTabRecord): string {
  const given = record.title.trim();
  if (given !== '') return given;
  return `Terminal ${record.terminalSessionId.slice(-4)}`;
}

/** Order is preserved: two boots of the same store must draw the same strip. */
export function composeTabStrip(
  openTabs: readonly TerminalTabRecord[],
  liveViews: readonly TerminalTabView[],
): TerminalTabStripEntry[] {
  const bySession = new Map(liveViews.map((view) => [view.terminalSessionId, view]));
  return openTabs.map((record) => {
    const view = bySession.get(record.terminalSessionId);
    return {
      tabId: record.id,
      title: titleForTab(record),
      terminalSessionId: record.terminalSessionId,
      mode: record.mode,
      session: view === undefined ? { known: false } : { known: true, view },
    };
  });
}

/**
 * Status words for one strip entry, per FZ-VIEW-034: plain, non-contradictory,
 * and never a number the Runtime did not say. A REAL zero controller count is
 * fine and is drawn — it is the *absent* one that must not become a zero.
 */
export function describeTabSession(entry: TerminalTabStripEntry): string {
  if (!entry.session.known) return 'Session unknown';
  const { view } = entry.session;
  switch (view.status) {
    case 'live': {
      const windows = view.attachedControllerCount === 1
        ? '1 window attached'
        : `${view.attachedControllerCount} windows attached`;
      return `Running · ${windows}`;
    }
    case 'recovery-required':
      return 'Needs recovery';
    case 'exited':
      return 'Exited';
    case 'failed':
      return 'Failed';
    case 'starting':
      return 'Starting';
    case 'reserved':
      return 'Reserved';
  }
}
