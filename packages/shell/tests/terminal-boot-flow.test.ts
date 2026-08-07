// B1.5: the flow that opens the first window, pinned where it can be driven —
// the defect was never in a decision, it was in the ORDER (a session opened
// before the surface had been measured), and an order is only testable if it is
// not spread across a mount effect. Same reason tabCloseFlow.ts exists.
import { describe, it, expect } from 'vitest';
import { bootTerminalTabs, type TabBootWiring } from '../ui/screens/terminal/bootFlow.js';
import { SESSION_A, sessionView, tabRecord } from './fixtures/terminalTab.js';

const HOME = '/tmp';

/** The strip's own builder — one shape of a tab record in this package. */
const view = sessionView;
const record = (id: string): ReturnType<typeof tabRecord> => tabRecord({ id });

/** Records every call, so the assertions are about what the flow DID. */
function wiring(overrides: Partial<TabBootWiring> = {}): {
  readonly wiring: TabBootWiring;
  readonly opened: { columns: number; rows: number }[];
  readonly saved: string[];
} {
  const opened: { columns: number; rows: number }[] = [];
  const saved: string[] = [];
  const base: TabBootWiring = {
    tabs: {
      list: async () => [],
      save: async (id: string) => {
        saved.push(id);
        return { ok: true, value: { record: record(id) } };
      },
      close: async () => ({ ok: true, value: null }),
    } as unknown as TabBootWiring['tabs'],
    services: {
      listTerminals: async () => ({ succeeded: true, value: [] }),
      openTerminal: async (_cwd: string, columns: number, rows: number) => {
        opened.push({ columns, rows });
        return { succeeded: true, value: view({ workingDirectory: HOME }) };
      },
    } as unknown as TabBootWiring['services'],
    workingDirectory: HOME,
    viewport: { columns: 178, rows: 46 },
    newTabId: () => 'terminalTab_00000000-0000-7000-8000-0000000000aa',
    opId: () => 'shellop_00000000-0000-7000-8000-0000000000bb',
    ...overrides,
  };
  return { wiring: base, opened, saved };
}

describe('opening the first window', () => {
  it('opens NOTHING until the surface has been measured', async () => {
    // The defect, exactly: the effect ran on mount, read a terminal the browser
    // had not laid out yet, and opened a real process at the addon's floor.
    const { wiring: unmeasured, opened, saved } = wiring({ viewport: null });
    const outcome = await bootTerminalTabs(unmeasured);
    expect(outcome.kind).toBe('not-measured');
    expect(opened).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('opens the session at the size that is actually on screen', async () => {
    const { wiring: measured, opened } = wiring();
    const outcome = await bootTerminalTabs(measured);
    expect(outcome.kind).toBe('opened');
    expect(opened).toEqual([{ columns: 178, rows: 46 }]);
  });

  it('never falls back to a default size', async () => {
    const { wiring: measured, opened } = wiring({ viewport: { columns: 100, rows: 30 } });
    await bootTerminalTabs(measured);
    expect(opened).toEqual([{ columns: 100, rows: 30 }]);
    expect(opened[0]).not.toEqual({ columns: 80, rows: 24 });
  });

  it('writes the durable record only after a session actually came up', async () => {
    const { wiring: measured, saved } = wiring({
      services: {
        listTerminals: async () => ({ succeeded: true, value: [] }),
        openTerminal: async () => ({
          succeeded: false, code: 'RuntimeUnavailable', message: 'no runtime',
        }),
      } as unknown as TabBootWiring['services'],
    });
    const outcome = await bootTerminalTabs(measured);
    expect(outcome.kind).toBe('problem');
    expect(saved).toEqual([]);
  });

  it('restores the windows Chris had, and opens nothing', async () => {
    const restored = record('terminalTab_00000000-0000-7000-8000-0000000000cc');
    const { wiring: measured, opened } = wiring({
      tabs: {
        list: async () => [restored],
        save: async () => ({ ok: true, value: { record: restored } }),
        close: async () => ({ ok: true, value: null }),
      } as unknown as TabBootWiring['tabs'],
    });
    const outcome = await bootTerminalTabs(measured);
    expect(outcome.kind).toBe('restored');
    expect(opened).toEqual([]);
  });

  /**
   * A restore does not open a process, so it does not need a measurement — and
   * refusing to restore until one exists would leave a reloaded page blank for
   * a frame on the one path that must always come back to what Chris had.
   */
  it('restores even before the surface has been measured', async () => {
    const restored = record('terminalTab_00000000-0000-7000-8000-0000000000dd');
    const { wiring: unmeasured } = wiring({
      viewport: null,
      tabs: {
        list: async () => [restored],
        save: async () => ({ ok: true, value: { record: restored } }),
        close: async () => ({ ok: true, value: null }),
      } as unknown as TabBootWiring['tabs'],
    });
    expect((await bootTerminalTabs(unmeasured)).kind).toBe('restored');
  });
});
