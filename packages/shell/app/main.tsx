// shell/app/main.tsx — the app entry. Mounts the shell against the Novakai
// server that served this page (nvk-ws v1, same origin). If the socket never
// opens the in-memory services keep the app alive — never blank (red gate 5) —
// and the badge says which backend you are clicking.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App.js';
import type { ShellServices } from '../contract/index.js';
import { createMockServices } from './mockServices.js';
import { createServerServices, fetchBootstrap } from './serverClient.js';

function Boot() {
  const [services, setServices] = useState<ShellServices | null>(null);
  const [backend, setBackend] = useState<'server' | 'offline' | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchBootstrap()
      .then((bootstrap) => createServerServices(bootstrap, () => {}))
      .then((s) => { if (alive) { setServices(s); setBackend('server'); } })
      .catch(() => { if (alive) { setServices(createMockServices()); setBackend('offline'); } });
    return () => { alive = false; };
  }, []);

  if (!services) return null;
  return (
    <>
      {backend === 'offline' && (
        <div style={{
          position: 'fixed', bottom: 10, right: 12, zIndex: 50,
          fontSize: 11, color: 'var(--ink-3)', background: 'var(--workspace)',
          border: '1px solid var(--hairline)', borderRadius: 5, padding: '3px 9px',
        }}>
          offline: in-memory services (start nvk-server for real messaging)
        </div>
      )}
      <App services={services} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Boot />);
