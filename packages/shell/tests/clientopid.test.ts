// S2a M5 closure (DEC-S2-12, R3-10): clientOpId is REQUIRED on the shell
// setLayout/setSetting paths and threads through to the foundation record
// meta — a retry with the same clientOpId dedups instead of double-applying.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeShellPersistence } from '../contract/persistence.node.js';
import { setLayout } from '../contract/layout.js';
import { setSetting } from '../contract/settings.js';
import {
  queryTraceBound, mintClientOpId,
} from '../../foundation/dist/contract/index.js';
// M11: composeEngine is foundation-internal (the public surface exports composeHandle only).
import { composeEngine } from '../../foundation/dist/contract/compose.js';

const compose = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-opid-'));
  return { root, p: composeShellPersistence({ root, principal: 'person_chris' }) };
};

const traceCount = async (root: string, clientOpId: string) => {
  const engine = composeEngine({ root, capability: 'shell', allowedKinds: ['layout', 'settings'], principal: 'person_chris' });
  const page = await queryTraceBound(engine, { clientOpId: clientOpId as never });
  return page.items.length;
};

describe('M5: clientOpId required + threaded to foundation meta', () => {
  it('setSetting threads the caller clientOpId into the trace (not a freshly minted one)', async () => {
    const { root, p } = compose();
    const op = mintClientOpId();
    const res = await setSetting(p.settingsDriver, 'theme', 'light', { clientOpId: op as string });
    expect(res.ok).toBe(true);
    expect(await traceCount(root, op)).toBe(1);
  });

  it('setSetting retry with the SAME clientOpId dedups: one record, one trace, no error (R3-10)', async () => {
    const { root, p } = compose();
    const op = mintClientOpId();
    const first = await setSetting(p.settingsDriver, 'accent', '#d0a14b', { clientOpId: op as string });
    const retry = await setSetting(p.settingsDriver, 'accent', '#d0a14b', { clientOpId: op as string });
    expect(first.ok && retry.ok).toBe(true);
    const all = await p.settingsDriver.readAll();
    expect(all.filter((r) => r.key === 'accent').length).toBe(1);
    expect(await traceCount(root, op)).toBe(1); // no double-apply, no new line
  });

  it('setLayout threads the caller clientOpId into the trace', async () => {
    const { root, p } = compose();
    const op = mintClientOpId();
    const res = await setLayout(p.layoutDriver, { composer: { height: 220 } }, op as string);
    expect(res.ok).toBe(true);
    expect(await traceCount(root, op)).toBeGreaterThan(0);
  });
});
