// tools/close-preview.tsx — a dev-only VISUAL proof of FZ-VIEW-033's close
// truth table, driven through the REAL `TerminalScreen`.
//
// Everything that decides anything here is the shipped code: the real screen,
// the real chrome, the real `contract/terminalClose.ts` table, and the real
// `contract/terminalTab.ts` record rules over an in-memory driver. What is
// stubbed is exactly one thing — the Runtime's terminal facade — because the
// offline harness starts no nvk-server, so no PTY exists to attach to (seat 2's
// standing note).
//
// That stub is an ADAPTER behind the existing `TerminalConnection` seam, the same
// shape `app/mockServices.ts` is for the frozen door. It is NOT a second
// composition of the screen (the tracer's law): the close path Chris drives on
// this page is byte-for-byte the one the product runs.
//
// Three scenarios, by query param (a full navigation each — a hash change fires
// no load event and the harness would wait for one forever), because the truth table's whole point is that the
// SAME press has three different honest answers:
//
//   ?scenario=live     the Runtime says the session is running → it must ASK
//   ?scenario=exited   the Runtime says it ended → no question, and the window
//                      must still close (the old close path could not)
//   ?scenario=unknown  the Runtime does not report the session → no question,
//                      and no claim in either direction
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalScreen } from '../ui/screens/terminal/TerminalScreen.js';
import {
  setTerminalTab, closeTerminalTab,
  type TerminalTabDriver, type TerminalTabRecord,
} from '../contract/terminalTab.js';
import type { ShellTerminalTabServices } from '../contract/services.js';
import type { TerminalConnection } from '../app/terminalClient.js';
import type { TerminalTabView } from '../contract/terminalServices.js';

const SESSION = 'terminal_00000000-0000-7000-8000-00000000001f';
const TAB_ID = 'terminalTab_00000000-0000-7000-8000-0000000000f1';

type Scenario = 'live' | 'exited' | 'unknown';
const scenario = ((): Scenario => {
  const asked = new URLSearchParams(globalThis.location.search).get('scenario');
  return asked === 'exited' || asked === 'unknown' ? asked : 'live';
})();

const sessionView = (status: TerminalTabView['status']): TerminalTabView => ({
  terminalSessionId: SESSION,
  status,
  owner: { kind: 'plain-shell', label: 'novakai-shell' },
  workingDirectory: '/Users/chris/Novakai-Command',
  attachedControllerCount: 1,
  holdsInputLease: true,
  replay: { earliestSequence: 0, latestSequence: 3 },
  nextInputSequence: 1,
});

/** What the Runtime reports. `unknown` reports NOTHING — not a zero, an absence. */
const REPORTED: readonly TerminalTabView[] = scenario === 'unknown'
  ? []
  : [sessionView(scenario === 'exited' ? 'exited' : 'live')];

const okay = <Value, >(value: Value) => ({ succeeded: true as const, value });

const connection: TerminalConnection = {
  listTerminals: async () => okay(REPORTED),
  openTerminal: async () => okay(sessionView('live')),
  attach: async () => (scenario === 'live'
    ? okay({ attachmentId: 'attachment_1', leaseId: 'lease_1', leaseGeneration: 1, nextInputSequence: 1 })
    // A session that is not live has nothing to attach to, and the real client
    // says so. This is the case that used to leave the close button dead.
    : { succeeded: false as const, code: 'TerminalNotLive', message: 'this session is not live' }),
  detach: async () => okay(null),
  write: async () => okay({ inputSequence: 1 }),
  resize: async () => okay(sessionView('live')),
  readReplay: async () => okay([{
    kind: 'bytes' as const,
    text: 'chris@novakai ~/Novakai-Command $ npm run build\r\n'
      + '[build] compiled 42 modules\r\nchris@novakai ~/Novakai-Command $ ',
  }]),
  runtimeStatus: async () => okay({
    activeEpochId: 'epoch_1', liveTerminalSessionCount: 1, attachedControllerCount: 1,
  }),
  onOutput: () => {},
  close: () => {},
};

/* eslint-disable id-length -- `ok` is the Result contract's own field name
   (contract/errors.ts). Renaming it here would be a driver that does not satisfy
   the interface it is standing in for. */
/** The REAL record rules over a Map. Nothing about persistence is faked twice. */
const stored = new Map<string, { record: TerminalTabRecord; version: number }>();
const driver: TerminalTabDriver = {
  list: async () => [...stored.values()].map((held) => held.record),
  read: async (id) => stored.get(id) ?? null,
  create: async (record) => {
    stored.set(record.id, { record, version: 1 });
    return { ok: true as const, value: { record, version: 1 } };
  },
  update: async (id, record, expectedVersion) => {
    stored.set(id, { record, version: expectedVersion + 1 });
    return { ok: true as const, value: { record, version: expectedVersion + 1 } };
  },
};
const tabs: ShellTerminalTabServices = {
  list: () => driver.list(),
  save: (id, patch, clientOpId) => setTerminalTab(driver, id, patch, clientOpId),
  close: (id, clientOpId) => closeTerminalTab(driver, id, clientOpId),
};

// The tab exists BEFORE the page boots, so the screen restores it rather than
// opening a new session — which is the only way the exited and unknown cases can
// be staged at all.
await setTerminalTab(driver, TAB_ID, { terminalSessionId: SESSION, title: 'build', mode: 'raw' }, 'op_seed');

const readout = document.querySelector('#readout');
if (readout) {
  readout.textContent = `scenario ${scenario} — the Runtime reports `
    + (REPORTED.length === 0 ? 'nothing about this session' : `it as ${REPORTED[0].status}`);
}

createRoot(document.querySelector('#preview') as HTMLElement).render(
  <TerminalScreen
    services={connection}
    tabs={tabs}
    workingDirectory="/Users/chris/Novakai-Command"
    screenContext="snapshot-only"
  />,
);
