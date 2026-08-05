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
import { composeTabStrip } from '../../../contract/terminalTabStrip.js';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { ScreenContextSupport } from '../../../contract/screenContext.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';
import { adoptOrOpen, writeReplay, xtermTheme } from './session.js';

export interface TerminalScreenProps {
  readonly services: TerminalConnection;
  /** The Shell's own tab store (FZ-VIEW-017) — never the Runtime's. */
  readonly tabs: ShellTerminalTabServices;
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

    screen.onData((data) => {
      const held = attachment.current;
      const sessionId = attachedTo.current;
      if (!held || sessionId === null || held.leaseId === '') return;
      const sequence = inputSequence.current;
      inputSequence.current += 1;
      void services.write(sessionId, held, data, sequence).then(async (written) => {
        if (written.succeeded) return;
        setProblem(`${written.code}: ${written.message}`);
        // A refused write leaves this window's idea of the stream wrong, and
        // repeating the same wrong number refuses forever. Ask again.
        const truth = await refresh();
        inputSequence.current = truth.find((item) => item.terminalSessionId === sessionId)
          ?.nextInputSequence ?? sequence;
      });
    });

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

  // The viewport follows the window, and the Runtime is told whose it is.
  useEffect(() => {
    const onResize = (): void => {
      fitter.current?.fit();
      const held = attachment.current;
      const screen = terminal.current;
      const sessionId = attachedTo.current;
      if (!held || !screen || sessionId === null) return;
      void services.resize(sessionId, held.attachmentId, screen.cols, screen.rows);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [services]);

  const openAnother = useCallback(async () => {
    const screen = terminal.current;
    const session = await services.openTerminal(
      workingDirectory, screen?.cols ?? 80, screen?.rows ?? 24,
    );
    if (!session.succeeded) {
      setProblem(`${session.code}: ${session.message}`);
      return;
    }
    const created = await tabs.save(
      `terminalTab_${crypto.randomUUID()}`,
      { terminalSessionId: session.value.terminalSessionId },
      mintShellOpId(),
    );
    if (!created.ok) {
      setProblem(`${created.error.code}: ${created.error.message}`);
      return;
    }
    setOpenTabs((current) => [...current, created.value.record]);
    setSelectedTabId(created.value.record.id);
    await refresh();
  }, [services, tabs, workingDirectory, refresh]);

  /**
   * Switch this tab's mode, and persist it — the record is where the mode
   * LIVES (FZ-VIEW-017), so a mode that only existed in component state would
   * be a mode that quietly reverted on reload.
   *
   * Going to Raw flushes everything Calm was holding, immediately: asking for
   * the truth is asking for it now, and output stranded in a buffer nobody will
   * ever read again is output the process printed and Chris never saw.
   */
  const changeMode = useCallback(async (next: 'raw' | 'calm') => {
    if (selectedTabId === null) return;
    if (next === 'raw') {
      const { state, text } = flushCalm(calm.current);
      calm.current = state;
      if (text !== '') terminal.current?.write(text);
    } else {
      calm.current = emptyCalmState(Date.now());
    }
    // Applied to the ref first so a frame arriving between here and the awaited
    // write is already paced by the mode Chris just chose.
    paceRef.current = { ...paceRef.current, mode: next };
    const saved = await tabs.save(selectedTabId, { mode: next }, mintShellOpId());
    if (!saved.ok) {
      setProblem(`${saved.error.code}: ${saved.error.message}`);
      return;
    }
    setOpenTabs((current) => current.map((record) =>
      (record.id === selectedTabId ? saved.value.record : record)));
  }, [selectedTabId, tabs]);

  const closeTab = useCallback(async () => {
    const held = attachment.current;
    const sessionId = attachedTo.current;
    if (!held || sessionId === null || selectedTabId === null) return;
    const detached = await services.detach(sessionId, held.attachmentId);
    attachment.current = null;
    attachedTo.current = null;
    if (!detached.succeeded) {
      setProblem(`${detached.code}: ${detached.message}`);
      return;
    }
    // The Shell forgets the WINDOW. It keeps the session id on the closed
    // record, and it does not ask the Runtime to stop anything (FZ-VIEW-033).
    const closed = await tabs.close(selectedTabId, mintShellOpId());
    if (!closed.ok) setProblem(`${closed.error.code}: ${closed.error.message}`);
    const remaining = openTabs.filter((record) => record.id !== selectedTabId);
    setOpenTabs(remaining);
    setSelectedTabId(remaining[0]?.id ?? null);
    // The signature moment. No sentence announces it: the line itself goes
    // calm and says "0 windows attached · running in the background Runtime".
    setSettled(true);
    await refresh();
  }, [services, tabs, selectedTabId, openTabs, refresh]);

  return (
    <TerminalChrome
      truth={view ? describeTerminal(view) : 'Reaching the background Runtime…'}
      tone={toneFor(view, settled)}
      screenContext={props.screenContext}
      mode={selectedTab?.mode ?? 'raw'}
      onModeChange={(next) => { void changeMode(next); }}
      watchingOnly={watchingOnly}
      problem={problem}
      surfaceRef={surface}
      onClose={() => { void closeTab(); }}
      strip={(
        <TerminalTabStrip
          entries={entries}
          selectedTabId={selectedTabId}
          onSelect={setSelectedTabId}
          onNewTab={() => { void openAnother(); }}
        />
      )}
    />
  );
}
