// One real terminal tab (B3a slice obligation).
//
// The point it has to make, visibly: closing this window detaches it. There is
// no control here that can stop the session, because a window closing is not a
// kill signal (red gate 1).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalChrome, toneFor } from './TerminalChrome.js';
import {
  chooseAdoptable, describeTerminal, SHELL_INSTANCE_ID,
  type TerminalOutcome, type TerminalTabView,
} from '../../../contract/terminalServices.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';

export interface TerminalScreenProps {
  readonly services: TerminalConnection;
  readonly workingDirectory: string;
}

interface Attached {
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
}

/**
 * Reuse the session this tab left running, or start one. Reuse is the normal
 * case — but only of a session this shell owns, in this directory. Anything
 * else on the machine belongs to someone else (see `chooseAdoptable`).
 */
async function adoptOrOpen(
  services: TerminalConnection, workingDirectory: string, columns: number, rows: number,
): Promise<TerminalOutcome<TerminalTabView>> {
  const existing = await services.listTerminals();
  const reuse = existing.succeeded
    ? chooseAdoptable(existing.value, workingDirectory, SHELL_INSTANCE_ID)
    : null;
  if (reuse) return { succeeded: true, value: reuse };
  return services.openTerminal(workingDirectory, columns, rows);
}

/**
 * xterm paints its own pixels, so it is handed the kit's tokens rather than a
 * second palette (§16: one token source). No gold: the composed viewport's one
 * attention signal belongs to the rail, and a cursor is not an exception.
 */
function xtermTheme(): { background: string; foreground: string; cursor: string } {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string =>
    tokens.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--workspace', '#1b1b1e'),
    foreground: token('--ink', '#ececee'),
    cursor: token('--ink-2', '#b4b4bb'),
  };
}

async function writeReplay(
  services: TerminalConnection, sessionId: string, screen: Terminal,
): Promise<void> {
  const replay = await services.readReplay(sessionId, 0);
  if (!replay.succeeded) return;
  for (const frame of replay.value) {
    // A gap is stated, never papered over with whatever bytes remain.
    screen.write(frame.kind === 'gap' ? '\r\n[earlier output is no longer buffered]\r\n' : frame.text);
  }
}

export function TerminalScreen(props: TerminalScreenProps): React.JSX.Element {
  const { services, workingDirectory } = props;
  const surface = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const attachment = useRef<Attached | null>(null);
  /** Also a ref: unmount cleanup must know it without waiting for a render. */
  const attachedTo = useRef<string | null>(null);
  const inputSequence = useRef(1);
  const [view, setView] = useState<TerminalTabView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [watchingOnly, setWatchingOnly] = useState(false);

  const refresh = useCallback(async (sessionId: string) => {
    const listed = await services.listTerminals();
    if (!listed.succeeded) return;
    const found = listed.value.find((item) => item.terminalSessionId === sessionId);
    if (found) setView(found);
  }, [services]);

  // Open (or adopt) a session, attach, replay what was missed, then follow live.
  useEffect(() => {
    let disposed = false;
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

    void (async () => {
      const session = await adoptOrOpen(services, workingDirectory, screen.cols, screen.rows);
      if (!session.succeeded) {
        screen.write(`\r\n[${session.code}] ${session.message}\r\n`);
        return;
      }
      if (disposed) return;
      setView(session.value);
      const sessionId = session.value.terminalSessionId;

      const joined = await services.attach(sessionId, screen.cols, screen.rows);
      if (!joined.succeeded) {
        screen.write(`\r\n[${joined.code}] ${joined.message}\r\n`);
        return;
      }
      attachment.current = joined.value;
      attachedTo.current = sessionId;
      if (joined.value.leaseId === '') setWatchingOnly(true);

      // Whatever happened while nobody was watching is shown before live output.
      await writeReplay(services, sessionId, screen);

      services.onOutput((emittedFor, frame) => {
        if (emittedFor !== sessionId) return;
        if (frame.kind === 'exit') {
          screen.write('\r\n[the terminal exited]\r\n');
          void refresh(sessionId);
          return;
        }
        screen.write(frame.text);
      });

      screen.onData((data) => {
        const held = attachment.current;
        if (!held || held.leaseId === '') return;
        const sequence = inputSequence.current;
        inputSequence.current += 1;
        void services.write(sessionId, held, data, sequence).then((written) => {
          if (written.succeeded) return;
          inputSequence.current = sequence;
          setProblem(`${written.code}: ${written.message}`);
        });
      });

      void refresh(sessionId);
    })();

    return () => {
      disposed = true;
      // Going away IS detaching (§13.4). Without this, leaving the tab leaves a
      // window the Runtime still counts — the terminal keeps running either way.
      const held = attachment.current;
      const sessionId = attachedTo.current;
      if (held && sessionId !== null) {
        attachment.current = null;
        attachedTo.current = null;
        void services.detach(sessionId, held.attachmentId);
      }
      screen.dispose();
    };
  }, [services, workingDirectory, refresh]);

  // The viewport follows the window, and the Runtime is told whose it is.
  useEffect(() => {
    const onResize = (): void => {
      fitter.current?.fit();
      const held = attachment.current;
      const screen = terminal.current;
      if (!held || !screen || !view) return;
      void services.resize(view.terminalSessionId, held.attachmentId, screen.cols, screen.rows);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [services, view]);

  const closeTab = useCallback(async () => {
    const held = attachment.current;
    if (!held || !view) return;
    const detached = await services.detach(view.terminalSessionId, held.attachmentId);
    attachment.current = null;
    attachedTo.current = null;
    if (!detached.succeeded) {
      setProblem(`${detached.code}: ${detached.message}`);
      return;
    }
    // The signature moment. No sentence announces it: the line itself goes
    // calm and says "0 windows attached · running in the background Runtime".
    setSettled(true);
    await refresh(view.terminalSessionId);
  }, [services, view, refresh]);

  return (
    <TerminalChrome
      truth={view ? describeTerminal(view) : 'Reaching the background Runtime…'}
      tone={toneFor(view, settled)}
      watchingOnly={watchingOnly}
      problem={problem}
      surfaceRef={surface}
      onClose={() => { void closeTab(); }}
    />
  );
}
