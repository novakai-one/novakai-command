// The B3a terminal tab, mounted on its own so it can be driven and verified
// before B3e folds it into the full shell frame.
//
// It needs TWO connections, and they are not interchangeable:
//   - the Runtime's terminal facade — sessions, output, leases;
//   - the Shell's own services — the durable `terminalTab` records (FZ-VIEW-017).
//
// If the second one cannot be reached the page still runs, on in-memory tabs.
// That is stated on screen rather than left to be discovered: with the mock,
// tabs do NOT survive a reload, and a demo that silently loses them would look
// exactly like persistence being broken.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalScreen } from '../../ui/screens/terminal/TerminalScreen.js';
import { connectTerminalServices, type TerminalConnection } from '../terminalClient.js';
import { describeBootFailure } from '../../contract/terminalServices.js';
import { createServerServices, fetchBootstrap } from '../serverClient.js';
import { createMockServices } from '../mockServices.js';
import { readCaptureCapabilities } from '../captureCapabilities.js';
import { detectShellCaptureSupport } from '../../contract/screenContext.js';
import type { ShellTerminalTabServices } from '../../contract/index.js';
import type { ShellAgentServices } from '../../contract/agentRuns.js';

/**
 * FZ-VIEW-016, resolved once, here — the composition root is the one place that
 * touches a browser global. The Shell is the capture authority for its OWN
 * support (orchestrator ACK, 2026-08-06); it is NOT recomputing Messaging's
 * echo, which stays Messaging's alone (FZ-VIEW-014).
 */
const SCREEN_CONTEXT = detectShellCaptureSupport(
  readCaptureCapabilities(typeof navigator === 'undefined' ? undefined : navigator),
);

function Boot(): React.JSX.Element | null {
  const [services, setServices] = useState<TerminalConnection | null>(null);
  const [tabs, setTabs] = useState<ShellTerminalTabServices | null>(null);
  const [agentRuns, setAgentRuns] = useState<ShellAgentServices | null>(null);
  const [tabsBackend, setTabsBackend] = useState<'server' | 'offline' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void connectTerminalServices()
      .then((connected) => { if (alive) setServices(connected); })
      .catch((cause: unknown) => { if (alive) setFailure(describeBootFailure(cause)); });
    void fetchBootstrap()
      .then((bootstrap) => createServerServices(bootstrap, () => {}))
      .then((shell) => {
        if (!alive) return;
        setTabs(shell.terminalTabs);
        // The SAME connection the tab records come over, so a page that reached
        // the Shell server can also reach FZ-VIEW-001 — no second socket, and
        // no case where the stop door is present but pointing somewhere else.
        setAgentRuns(shell.agentRuns);
        setTabsBackend('server');
      })
      .catch(() => {
        if (!alive) return;
        const offline = createMockServices();
        setTabs(offline.terminalTabs);
        // The offline door refuses every lifecycle command as a VALUE, so the
        // dialog can say a stop did not happen instead of the page throwing.
        setAgentRuns(offline.agentRuns);
        setTabsBackend('offline');
      });
    return () => { alive = false; };
  }, []);

  if (failure) {
    return <p className="nvkBootError" data-testid="terminal-boot-error">{failure}</p>;
  }
  if (!services || !tabs || !agentRuns) return null;
  return (
    <>
      {tabsBackend === 'offline' && (
        <p className="nvkBootError" data-testid="terminal-tabs-offline">
          Tabs are in memory only — they will not survive a reload.
        </p>
      )}
      <TerminalScreen
        services={services}
        tabs={tabs}
        agentRuns={agentRuns}
        workingDirectory="/tmp"
        screenContext={SCREEN_CONTEXT}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Boot />);
