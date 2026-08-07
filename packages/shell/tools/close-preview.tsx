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
// B3.2 adds the two the lifecycle door made reachable. Both are AGENT-owned
// sessions, because that is the only kind v4 can stop at all (§13.4):
//
//   ?scenario=agent    live, and the stop succeeds → the window closes saying
//                      the session is NOT running
//   ?scenario=refused  live, and `b3.agent.stop` refuses → the window must STAY
//                      OPEN and say so. This is the one that matters: a tab that
//                      closed here would hide a running Agent behind a closed
//                      window, which is the same lie as a Stop that only detaches
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
import type { ShellAgentServices } from '../contract/agentRuns.js';
import type { TerminalConnection } from '../app/terminalClient.js';
import type { TerminalTabView } from '../contract/terminalServices.js';

const SESSION = 'terminal_00000000-0000-7000-8000-00000000001f';
const TAB_ID = 'terminalTab_00000000-0000-7000-8000-0000000000f1';
const RUN_ID = 'agentRun_00000000-0000-7000-8000-0000000000a1';
const AGENT_ID = 'agent_9f0a2b64-4c3d-4e2f-9a1b-77c5d0e3f412';

type Scenario = 'live' | 'exited' | 'unknown' | 'agent' | 'refused';
const SCENARIOS: readonly Scenario[] = ['live', 'exited', 'unknown', 'agent', 'refused'];
const scenario = ((): Scenario => {
  const asked = new URLSearchParams(globalThis.location.search).get('scenario');
  return SCENARIOS.find((name) => name === asked) ?? 'live';
})();

/** The two agent scenarios differ in the STOP's answer, not in the session. */
const ownedByAgent = scenario === 'agent' || scenario === 'refused';

const sessionView = (status: TerminalTabView['status']): TerminalTabView => ({
  terminalSessionId: SESSION,
  status,
  owner: ownedByAgent
    ? { kind: 'agent-run', label: RUN_ID }
    : { kind: 'plain-shell', label: 'novakai-shell' },
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

/**
 * FZ-VIEW-001's `runs` + `lifecycle` slices, stubbed at the SOCKET's edge —
 * these two answer what a real Runtime would answer, and the screen runs the
 * shipped `planTerminalStop` / `useTabClose` over them unchanged.
 *
 * `routed` is the point, and it is seat 7's lesson applied to a mutation: a
 * window that closes and a window that failed to stop and closed anyway look
 * IDENTICAL on screen. Printing what was actually sent to `b3.agent.stop` is
 * what makes "the stop really happened" falsifiable in a browser.
 */
const routed: string[] = [];
const agentRuns: Pick<ShellAgentServices, 'runs' | 'lifecycle'> = {
  runs: {
    getAgentRun: async ({ agentRunId }) => {
      routed.push(`read ${agentRunId}`);
      showRouted();
      return {
        ok: true as const,
        value: {
          agent: { agentId: AGENT_ID, displayName: 'Scout', roleProfileId: 'agentRole_1' },
          run: { id: RUN_ID, agentId: AGENT_ID, recordVersion: 7 },
        } as never,
      };
    },
    listAgentRuns: async () => ({
      ok: false as const,
      error: { code: 'RuntimeUnavailable', message: 'not part of this preview' },
    }),
    getAgentRunTree: async () => ({
      ok: false as const,
      error: { code: 'RuntimeUnavailable', message: 'not part of this preview' },
    }),
  },
  lifecycle: {
    stopAgent: async (request) => {
      routed.push(`stop ${request.agentId} run ${request.expectedLiveRunId} `
        + `(${request.confirmation})`);
      showRouted();
      if (scenario === 'refused') {
        return {
          ok: false as const,
          error: { code: 'VersionConflict', message: 'this Run has already moved on' },
        };
      }
      return { ok: true as const, value: { kind: 'stopped' } };
    },
    spawnAgent: async () => notInPreview(),
    interruptAgentTurn: async () => notInPreview(),
    prepareStopAgentTree: async () => notInPreview(),
    stopAgentTree: async () => notInPreview(),
    continueAgent: async () => notInPreview(),
    adoptAgent: async () => notInPreview(),
  },
};

function notInPreview() {
  return {
    ok: false as const,
    error: { code: 'RuntimeUnavailable', message: 'not part of this preview' },
  };
}

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
    // What the STORE holds, printed where a browser can read it. Not what the
    // input shows: the whole question about a picker is whether the value the
    // control displays is the value that actually got written.
    showStored(record);
    return { ok: true as const, value: { record, version: expectedVersion + 1 } };
  },
};
const tabs: ShellTerminalTabServices = {
  list: () => driver.list(),
  save: (id, patch, clientOpId) => setTerminalTab(driver, id, patch, clientOpId),
  close: (id, clientOpId) => closeTerminalTab(driver, id, clientOpId),
};

const readout = document.querySelector('#readout');
const reported = REPORTED.length === 0
  ? 'nothing about this session'
  : `it as ${REPORTED[0].status}`;
let lastStored = '';
function showStored(record: TerminalTabRecord): void {
  lastStored = `scenario ${scenario} — the Runtime reports ${reported}`
    + ` · stored mode ${record.mode}`
    + ` · stored pacing ${record.calmPacing.revealLinesPerSecond}/s`
    + ` buffer ${record.calmPacing.maxBufferedLines}`;
  showRouted();
}

/** What the door was actually asked, under what the store actually holds. */
function showRouted(): void {
  if (!readout) return;
  readout.textContent = `${lastStored} · routed: `
    + `${routed.length === 0 ? 'nothing' : routed.join(' → ')}`;
}

// Declared BEFORE the seed write, which calls it: a `const` read from a hoisted
// function that runs first is a TDZ error, and this page went blank on exactly
// that — the whole surface gone, with a green typecheck.
//
// The tab exists BEFORE the page boots, so the screen restores it rather than
// opening a new session — which is the only way the exited and unknown cases can
// be staged at all.
const seeded = await setTerminalTab(
  driver, TAB_ID, { terminalSessionId: SESSION, title: 'build', mode: 'raw' }, 'op_seed',
);
if (seeded.ok) showStored(seeded.value.record);

createRoot(document.querySelector('#preview') as HTMLElement).render(
  <TerminalScreen
    services={connection}
    tabs={tabs}
    agentRuns={agentRuns}
    workingDirectory="/Users/chris/Novakai-Command"
    screenContext="snapshot-only"
  />,
);

/**
 * B3.3's motion reading, taken off a LIVE element rather than the stylesheet.
 *
 * §17 says calm is slow (`--motion-structural: 700ms`) and §20/DEC-S2-9 say
 * every animation collapses when motion is reduced — through TWO doors, the OS
 * media query and the exposed setting. A token declared correctly in
 * `tokens.css` proves neither: what matters is the duration that survives the
 * cascade onto a real node, which is why this measures the real
 * `.nvkTerminalTruth` rule and then flips the setting and measures again.
 */
function readMotion(): string {
  const probe = document.createElement('div');
  probe.className = 'nvkTerminalTruth';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  // Seconds on the way out of getComputedStyle, milliseconds on the way in.
  const readMs = (): string => {
    const seconds = parseFloat(getComputedStyle(probe).transitionDuration.split(',')[0]);
    return `${Math.round(seconds * 100000) / 100}ms`;
  };
  const root = document.documentElement;
  const before = root.dataset.motion;
  const structural = readMs();
  root.dataset.motion = 'reduced';
  const reduced = readMs();
  if (before === undefined) delete root.dataset.motion;
  else root.dataset.motion = before;
  probe.remove();
  return `structural ${structural} · reduced ${reduced}`;
}

// After a frame, so the style the component imported has actually landed.
requestAnimationFrame(() => {
  const slot = document.querySelector('#motion');
  if (slot) slot.textContent = readMotion();
});
