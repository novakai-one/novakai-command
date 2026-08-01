// The B3a terminal tab, mounted on its own so it can be driven and verified
// before B3e folds it into the full shell frame.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalScreen } from '../../ui/screens/terminal/TerminalScreen.js';
import { connectTerminalServices, type TerminalConnection } from '../terminalClient.js';

function Boot(): React.JSX.Element | null {
  const [services, setServices] = useState<TerminalConnection | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void connectTerminalServices()
      .then((connected) => { if (alive) setServices(connected); })
      .catch((cause: unknown) => {
        if (alive) setFailure(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { alive = false; };
  }, []);

  if (failure) {
    return <p className="nvkBootError" data-testid="terminal-boot-error">{failure}</p>;
  }
  if (!services) return null;
  return <TerminalScreen services={services} workingDirectory="/tmp" />;
}

createRoot(document.getElementById('root')!).render(<Boot />);
