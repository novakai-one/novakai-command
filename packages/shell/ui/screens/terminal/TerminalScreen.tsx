// The terminal surface: a strip of tabs, and the one you are looking at.
//
// The point it has to make, visibly: closing this window detaches it. There is
// no control here that can stop the session, because a window closing is not a
// kill signal (red gate 1).
//
// B1.2 gave it more than one tab, which changes the shape rather than the size.
// Two authorities are now on screen at once and they are NOT the same authority:
//
//   the `terminalTab` records — the Shell's, durable, "which windows Chris has";
//   the Runtime's session views — not the Shell's, live, "what is running".
//
// The join lives in contract/terminalTabStrip.ts so it can be tested without a
// DOM; this file does the asking. One xterm instance serves every tab: switching
// resets it and replays the session you switched to, and the session you left is
// DETACHED — a window that is not showing a session must not be counted against
// it, or the controller count on the other tab becomes a lie.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalChrome, toneFor } from './TerminalChrome.js';
import { TerminalPacing } from './TerminalPacing.js';
import { TerminalTabStrip } from './TerminalTabStrip.js';
import {
  chooseAdoptable, describeTerminal, SHELL_INSTANCE_ID,
  type TerminalAttachment, type TerminalOutcome, type TerminalTabView,
} from '../../../contract/terminalServices.js';
import { listOpenTerminalTabs, type TerminalTabRecord } from '../../../contract/terminalTab.js';
import {
  emptyCalmState, flushCalm, rawPassthrough, receiveCalm, revealCalm,
  type CalmPacing, type CalmState,
} from '../../../contract/calmPacing.js';
import { composeTabStrip, type TabSessionTruth } from '../../../contract/terminalTabStrip.js';
import { TerminalCloseAsk } from './TerminalCloseAsk.js';
import { useTabClose, type TabCloseWiring } from './useTabClose.js';
import { useTabOpen } from './useTabOpen.js';
import { useTabPacing } from './useTabPacing.js';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { ScreenContextSupport } from '../../../contract/screenContext.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';
import { adoptOrOpen, writeReplay, xtermTheme } from './session.js';
import { makeRawInputHandler } from './rawInput.js';

export interface TerminalScreenProps {
  readonly services: TerminalConnection;
  /** The Shell's own tab store (FZ-VIEW-017) — never the Runtime's. */
  readonly tabs: ShellTerminalTabServices;
  /**
   * FZ-VIEW-001's `runs` + `lifecycle` slices, for the one thing this screen
   * does that is not a terminal operation: stopping the Agent behind an
   * Agent-owned tab (FZ-VIEW-033's "Stop and close"). Required, not optional —
   * a screen that could be handed no stop door would silently go back to
   * drawing the limit, which is how it stayed unbuilt for seven seats.
   */
  readonly agentRuns: TabCloseWiring['agentRuns'];
  readonly workingDirectory: string;
  /**
   * FZ-VIEW-016. Handed in by the composition root, which is the one place that
   * reads the host's capabilities — this screen never reaches for a browser
   * global to answer it. Not optional: see TerminalChrome.
   */
  readonly screenContext: ScreenContextSupport;
}

type Attached = TerminalAttachment;

export function TerminalScreen(props: TerminalScreenProps): React.JSX.Element {
  const { services, tabs, workingDirectory } = props;
  const surface = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const attachment = useRef<Attached | null>(null);
  /** Also a ref: unmount cleanup must know it without waiting for a render. */
  const attachedTo = useRef<string | null>(null);
  const inputSequence = useRef(1);
  /** Has the "nothing was sent" line already been drawn for this blocked run? */
  const blockedAnnounced = useRef(false);
  const disposed = useRef(false);
  /**
   * Calm's whole memory, in a ref rather than state: it advances on a 16ms tick
   * and on every output frame, and re-rendering the terminal at that cadence
   * would be paying React for something xterm already owns.
   *
   * `paceRef` mirrors the selected tab's mode and pacing so the ONE registered
   * `onOutput` listener can read the current rule without being re-registered —
   * re-registering it is what would leave the tab you left writing into the
   * screen you are looking at (see the note on effect 1).
   */
  const calm = useRef<CalmState>(emptyCalmState(0));
  const paceRef = useRef<{ mode: 'raw' | 'calm'; pacing: CalmPacing }>({
    mode: 'raw', pacing: { maxBufferedLines: 2_000, revealLinesPerSecond: 24 },
  });
  const [openTabs, setOpenTabs] = useState<readonly TerminalTabRecord[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [liveViews, setLiveViews] = useState<readonly TerminalTabView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [watchingOnly, setWatchingOnly] = useState(false);

  const selectedTab = openTabs.find((record) => record.id === selectedTabId) ?? null;
  const selectedSessionId = selectedTab?.terminalSessionId ?? null;
  const view = liveViews.find((item) => item.terminalSessionId === selectedSessionId) ?? null;
  const entries = useMemo(() => composeTabStrip(openTabs, liveViews), [openTabs, liveViews]);

  const refresh = useCallback(async (): Promise<readonly TerminalTabView[]> => {
    const listed = await services.listTerminals();
    if (!listed.succeeded) return [];
    if (!disposed.current) setLiveViews(listed.value);
    return listed.value;
  }, [services]);

  // 1. The xterm instance, and the two listeners that outlive every tab switch.
  //    They are registered ONCE and routed through `attachedTo`: `onOutput` has
  //    no unsubscribe, so re-registering per switch would leave the tab you left
  //    still writing into the screen you are looking at.
  useEffect(() => {
    disposed.current = false;
    const screen = new Terminal({
      convertEol: false,
      fontSize: 13,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
      theme: xtermTheme(),
    });
    const fitAddon = new FitAddon();
    screen.loadAddon(fitAddon);
    if (surface.current) screen.open(surface.current);
    fitAddon.fit();
    terminal.current = screen;
    fitter.current = fitAddon;

    services.onOutput((emittedFor, frame) => {
      if (disposed.current || emittedFor !== attachedTo.current) return;
      if (frame.kind === 'exit') {
        // The exit notice is the Shell's own, not the session's bytes, and it
        // is never paced: "this ended" held behind a backlog is the one message
        // that must not arrive late.
        const { state, text } = flushCalm(calm.current);
        calm.current = state;
        screen.write(`${text}\r\n[the terminal exited]\r\n`);
        void refresh();
        return;
      }
      if (paceRef.current.mode === 'raw') {
        screen.write(rawPassthrough(frame.text));
        return;
      }
      calm.current = receiveCalm(calm.current, frame.text, paceRef.current.pacing);
    });

    // Calm's clock. Raw never reaches it, and a tick that releases nothing
    // writes nothing — an empty write would still cost xterm a render.
    const ticking = setInterval(() => {
      if (disposed.current || paceRef.current.mode !== 'calm') return;
      const { state, text } = revealCalm(calm.current, Date.now(), paceRef.current.pacing);
      calm.current = state;
      if (text !== '') screen.write(text);
    }, 16);

    // FZ-VIEW-032's Raw clause. The handler lives in rawInput.ts with the rule
    // it enforces, not inline here, so a keystroke's whole journey is one file.
    screen.onData(makeRawInputHandler({
      services,
      write: (text) => screen.write(text),
      refresh,
      onProblem: setProblem,
      refs: { attachment, attachedTo, inputSequence, blockedAnnounced },
    }));

    return () => {
      disposed.current = true;
      clearInterval(ticking);
      screen.dispose();
    };
  }, [services, refresh]);

  // 2. Which tabs exist. Restored from the Shell's store, so a reload comes back
  //    to the windows Chris had — and a first boot gets exactly one.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const restored = await listOpenTerminalTabs(tabs);
      const views = await refresh();
      if (!alive) return;
      if (restored.length > 0) {
        setOpenTabs(restored);
        setSelectedTabId(restored[0].id);
        return;
      }
      const screen = terminal.current;
      const session = await adoptOrOpen(
        services, workingDirectory, screen?.cols ?? 80, screen?.rows ?? 24,
      );
      if (!alive) return;
      if (!session.succeeded) {
        setProblem(`${session.code}: ${session.message}`);
        return;
      }
      if (!views.some((item) => item.terminalSessionId === session.value.terminalSessionId)) {
        setLiveViews([...views, session.value]);
      }
      const created = await tabs.save(
        `terminalTab_${crypto.randomUUID()}`,
        { terminalSessionId: session.value.terminalSessionId },
        mintShellOpId(),
      );
      if (!alive) return;
      if (!created.ok) {
        setProblem(`${created.error.code}: ${created.error.message}`);
        return;
      }
      setOpenTabs([created.value.record]);
      setSelectedTabId(created.value.record.id);
    })();
    return () => { alive = false; };
  }, [services, tabs, workingDirectory, refresh]);

  // 2b. The mode the ONE output listener reads. Kept in a ref deliberately —
  //     see the note where it is declared. Switching tabs starts Calm clean:
  //     nothing the previous tab was holding may appear in this one's stream.
  useEffect(() => {
    paceRef.current = {
      mode: selectedTab?.mode ?? 'raw',
      pacing: selectedTab?.calmPacing ?? { maxBufferedLines: 2_000, revealLinesPerSecond: 24 },
    };
  }, [selectedTab]);

  useEffect(() => {
    calm.current = emptyCalmState(Date.now());
  }, [selectedTabId]);

  // 3. Attach to whichever session the selected tab shows. Switching tabs runs
  //    this cleanup first, so the session you left is detached before the next
  //    one is joined — the controller count stays true on both.
  useEffect(() => {
    if (selectedSessionId === null) return;
    const screen = terminal.current;
    if (!screen) return;
    let alive = true;
    // Nothing of the previous session survives the switch on screen. Replay
    // then writes what this session actually has.
    screen.reset();
    setWatchingOnly(false);
    setSettled(false);

    void (async () => {
      const joined = await services.attach(selectedSessionId, screen.cols, screen.rows);
      if (!alive) return;
      if (!joined.succeeded) {
        screen.write(`\r\n[${joined.code}] ${joined.message}\r\n`);
        return;
      }
      attachment.current = joined.value;
      attachedTo.current = selectedSessionId;
      // This window has typed nothing; the session may have been typed into for
      // an hour. The Runtime's position is adopted, never assumed to be 1 —
      // assuming it is what made a reopened window read-only (NVK-KIMI-025).
      inputSequence.current = joined.value.nextInputSequence;
      if (joined.value.leaseId === '') setWatchingOnly(true);

      // Whatever happened while nobody was watching is shown before live output.
      await writeReplay(services, selectedSessionId, screen);
      await refresh();
    })();

    return () => {
      alive = false;
      // Going away IS detaching (§13.4). Without this, leaving the tab leaves a
      // window the Runtime still counts — the terminal keeps running either way.
      const held = attachment.current;
      const sessionId = attachedTo.current;
      if (held && sessionId !== null) {
        attachment.current = null;
        attachedTo.current = null;
        void services.detach(sessionId, held.attachmentId);
      }
    };
  }, [services, selectedSessionId, refresh]);

  // The viewport follows the window, and the Runtime is told whose it is. Read at
  // event time, never captured: a resize arriving between attachments must use
  // the one that exists NOW, or it reshapes a session this window has left.
  useEffect(() => {
    const onResize = (): void => {
      fitter.current?.fit();
      const holding = attachment.current;
      const screen = terminal.current;
      const sessionId = attachedTo.current;
      if (!holding || !screen || sessionId === null) return;
      void services.resize(sessionId, holding.attachmentId, screen.cols, screen.rows);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [services]);

  const openAnother = useTabOpen({
    tabs,
    openTerminal: services.openTerminal,
    workingDirectory,
    viewport: () => ({ columns: terminal.current?.cols ?? 80, rows: terminal.current?.rows ?? 24 }),
    onOpened: (record) => {
      setOpenTabs((current) => [...current, record]);
      setSelectedTabId(record.id);
      // A new window ends the last close's sentence, and its settled tone with
      // it: leaving either up would attach the previous tab's truth to this one.
      closing.forgetNote();
      setSettled(false);
      void refresh();
    },
    onProblem: setProblem,
  });

  /** Mode + Calm's numbers, one flow (useTabPacing.ts): the record is where
      both LIVE (FZ-VIEW-017), so neither can quietly revert on reload. */
  const pacing = useTabPacing({
    tabs,
    selectedTabId,
    calm,
    pace: paceRef,
    write: (text) => terminal.current?.write(text),
    onSaved: (record) => setOpenTabs((current) => current.map((held) =>
      (held.id === record.id ? record : held))),
    onProblem: setProblem,
    clock: () => Date.now(),
  });

  /** What the Runtime actually said about the selected tab's session — the same
      discriminated truth the strip joins on, so the close decision and the strip
      can never disagree about whether a session is accounted for. A failed
      `listTerminals` leaves this `known: false`, and the close path then claims
      nothing rather than promising a process it cannot see. */
  const sessionTruth: TabSessionTruth = view === null ? { known: false } : { known: true, view };

  /** Closing is its own flow (useTabClose.ts). `held` is read at PRESS time
      rather than passed as a value: a window may have failed to attach (an
      exited session does), which is exactly when the record must still close. */
  const closing = useTabClose({
    tabs,
    agentRuns: props.agentRuns,
    held: () => (attachment.current && attachedTo.current !== null
      ? { terminalSessionId: attachedTo.current, attachment: attachment.current }
      : null),
    detach: (sessionId, attachmentId) => {
      attachment.current = null;
      attachedTo.current = null;
      return services.detach(sessionId, attachmentId);
    },
    onClosed: (tabId) => {
      setOpenTabs((current) => {
        const remaining = current.filter((record) => record.id !== tabId);
        setSelectedTabId((chosen) => (chosen === tabId ? remaining[0]?.id ?? null : chosen));
        return remaining;
      });
      // The signature moment: the line goes calm and states exactly what the
      // decision licensed — never more than that.
      setSettled(true);
      void refresh();
    },
    onProblem: setProblem,
  });

  /** Looking at another tab ends the last close's sentence. */
  const selectTab = useCallback((tabId: string) => {
    closing.forgetNote();
    setSettled(false);
    setSelectedTabId(tabId);
  }, [closing]);

  return (
    <TerminalChrome
      truth={view
        ? describeTerminal(view)
        : (closing.closedNote ?? 'Reaching the background Runtime…')}
      tone={toneFor(view, settled)}
      screenContext={props.screenContext}
      tabOpen={selectedTab !== null}
      mode={selectedTab?.mode ?? 'raw'}
      onModeChange={(next) => { void pacing.changeMode(next); }}
      pacing={selectedTab && (
        <TerminalPacing
          pacing={selectedTab.calmPacing}
          onChange={(next) => { void pacing.changePacing(next); }}
        />)}
      watchingOnly={watchingOnly}
      problem={problem}
      surfaceRef={surface}
      onClose={() => closing.requestClose(selectedTabId, sessionTruth)}
      ask={closing.asking && (
        <TerminalCloseAsk
          tabTitle={openTabs.find((record) => record.id === closing.asking?.tabId)?.title.trim()
            || 'this terminal'}
          decision={closing.asking.decision}
          onChoose={closing.answer}
        />
      )}
      strip={(
        <TerminalTabStrip
          entries={entries}
          selectedTabId={selectedTabId}
          onSelect={selectTab}
          onNewTab={() => { void openAnother(); }}
        />
      )}
    />
  );
}
