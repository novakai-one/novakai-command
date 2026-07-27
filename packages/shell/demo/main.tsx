// shell/demo/main.tsx — demo entry. Mounts the shell against the REAL
// packages/messaging backend via the WS bridge; if the bridge is unreachable
// the mock keeps the app alive (never blank — red gate 5), and the banner
// says which backend you're clicking.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App.js';
import type { ShellServices } from '../contract/index.js';
import { createMockServices } from './mockServices.js';
import { createBridgeServices } from './bridgeClient.js';

function Boot() {
  const [services, setServices] = useState<ShellServices | null>(null);
  const [backend, setBackend] = useState<'bridge' | 'mock' | null>(null);

  useEffect(() => {
    let alive = true;
    createBridgeServices('ws://127.0.0.1:4173', () => {})
      .then((s) => { if (alive) { setServices(s); setBackend('bridge'); } })
      .catch(() => { if (alive) { setServices(createMockServices()); setBackend('mock'); } });
    return () => { alive = false; };
  }, []);

  if (!services) return null;
  return (
    <>
      {backend === 'mock' && (
        <div style={{
          position: 'fixed', bottom: 10, right: 12, zIndex: 50,
          fontSize: 11, color: 'var(--ink-3)', background: 'var(--workspace)',
          border: '1px solid var(--hairline)', borderRadius: 5, padding: '3px 9px',
        }}>
          demo backend: in-memory mock (start the bridge for real messaging)
        </div>
      )}
      <App services={services} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Boot />);
