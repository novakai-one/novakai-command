// B3e LANE-B B1 — the `terminalTab` durable record (FZ-VIEW-017, P2 §10:1714).
//
// Shell's scoped Foundation handle gains its fourth and final allowed kind.
// FZ-VIEW-018 makes that set closed: `layout`, `settings`, `conversationView`,
// `terminalTab` — no `terminalPreference`, no Shell-specific store engine.
// LAW 1 (all durable records through Foundation's engine) is what these tests
// are really protecting.
import { describe, it, expect } from 'vitest';
import { fail, ok, persistFailed } from '../contract/errors.js';
import {
  CALM_PACING_LIMITS, TerminalTabRecord, closeTerminalTab, listOpenTerminalTabs,
  setTerminalTab, type TerminalTabDriver,
} from '../contract/terminalTab.js';

function driverOf(seed: TerminalTabRecord[] = []): TerminalTabDriver & {
  readonly opIds: string[];
} {
  const rows = new Map(seed.map((tab) => [tab.id, { record: tab, version: 1 }]));
  const opIds: string[] = [];
  return {
    opIds,
    list: async () => [...rows.values()].map((held) => held.record),
    read: async (id: string) => rows.get(id) ?? null,
    create: async (record: TerminalTabRecord, clientOpId: string) => {
      opIds.push(clientOpId);
      rows.set(record.id, { record, version: 1 });
      return ok({ record, version: 1 });
    },
    update: async (
      id: string, record: TerminalTabRecord, expectedVersion: number, clientOpId: string,
    ) => {
      opIds.push(clientOpId);
      const current = rows.get(id);
      if (!current) return fail(persistFailed('terminalTab', 'NotFound', 'gone'));
      if (current.version !== expectedVersion) {
        return fail(persistFailed('terminalTab', 'VersionConflict', 'stale'));
      }
      const next = { record, version: current.version + 1 };
      rows.set(id, next);
      return ok(next);
    },
  };
}

const openTab = (over: Partial<TerminalTabRecord> = {}): TerminalTabRecord =>
  TerminalTabRecord.parse({
    kind: 'terminalTab', id: 'terminalTab_1', schemaVersion: 1,
    createdAt: '2026-08-06T01:00:00.000Z', permissionLevel: 'private',
    createdBy: 'person_chris',
    terminalSessionId: 'terminal_019fd383-3207-7333-ae57-a3f7f3d5cfb6',
    mode: 'raw', title: 'zsh', zoom: 1,
    calmPacing: { maxBufferedLines: 2000, revealLinesPerSecond: 24 },
    state: 'open',
    ...over,
  });

describe('the record is the frozen shape, and nothing else (FZ-VIEW-017)', () => {
  it('accepts exactly the frozen members', () => {
    const tab = openTab();
    expect(Object.keys(tab).sort()).toEqual([
      'calmPacing', 'createdAt', 'createdBy', 'id', 'kind', 'mode',
      'permissionLevel', 'schemaVersion', 'state', 'terminalSessionId', 'title', 'zoom',
    ]);
  });

  it('refuses a mode the contract does not publish', () => {
    expect(() => openTab({ mode: 'message' as 'raw' })).toThrow();
  });

  it('refuses a state the contract does not publish', () => {
    expect(() => openTab({ state: 'detached' as 'open' })).toThrow();
  });

  it('refuses a terminalSessionId with the wrong prefix (FZ-CLI-SCHEMA-009)', () => {
    // "validators MUST reject a wrong prefix even when the remainder is valid"
    expect(() => openTab({ terminalSessionId: 'agentRun_019fd383-3207-7333-ae57-a3f7f3d5cfb6' }))
      .toThrow();
  });
});

describe('calm pacing inputs are bounded, because a UI that stalls is a UI that lies', () => {
  it('refuses a reveal rate of zero — a tab that never reveals looks hung', () => {
    expect(() => openTab({ calmPacing: { maxBufferedLines: 2000, revealLinesPerSecond: 0 } }))
      .toThrow();
  });

  it('refuses a buffer of zero — Calm would silently drop every line', () => {
    expect(() => openTab({ calmPacing: { maxBufferedLines: 0, revealLinesPerSecond: 24 } }))
      .toThrow();
  });

  it('refuses fractional pacing — lines are whole things', () => {
    expect(() => openTab({ calmPacing: { maxBufferedLines: 2000, revealLinesPerSecond: 1.5 } }))
      .toThrow();
  });

  it('publishes its own bounds so a picker cannot disagree with the validator', () => {
    expect(CALM_PACING_LIMITS.revealLinesPerSecond.floor).toBe(1);
    expect(() => openTab({
      calmPacing: {
        maxBufferedLines: CALM_PACING_LIMITS.maxBufferedLines.ceiling + 1,
        revealLinesPerSecond: 24,
      },
    })).toThrow();
  });

  it('accepts the two ends of every published range', () => {
    expect(() => openTab({
      calmPacing: {
        maxBufferedLines: CALM_PACING_LIMITS.maxBufferedLines.floor,
        revealLinesPerSecond: CALM_PACING_LIMITS.revealLinesPerSecond.floor,
      },
    })).not.toThrow();
    expect(() => openTab({
      calmPacing: {
        maxBufferedLines: CALM_PACING_LIMITS.maxBufferedLines.ceiling,
        revealLinesPerSecond: CALM_PACING_LIMITS.revealLinesPerSecond.ceiling,
      },
    })).not.toThrow();
  });
});

describe('writes go through Foundation, carry a clientOpId, and CAS (LAW 1)', () => {
  it('creates on absent and never persists a record the schema rejects', async () => {
    const driver = driverOf();
    const res = await setTerminalTab(driver, 'terminalTab_new', {
      terminalSessionId: 'terminal_019fd383-3207-7333-ae57-a3f7f3d5cfb6',
      mode: 'calm', title: 'kimi',
    }, 'op_1');
    expect(res.ok).toBe(true);
    expect(driver.opIds).toEqual(['op_1']);
    expect((await driver.list())[0]?.mode).toBe('calm');
  });

  it('updates against the version it read, so a stale writer loses', async () => {
    const driver = driverOf([openTab()]);
    const first = await setTerminalTab(driver, 'terminalTab_1', { mode: 'calm' }, 'op_a');
    expect(first.ok).toBe(true);
    // A second writer holding the OLD version is refused rather than clobbering.
    const stale = await driver.update('terminalTab_1', openTab({ zoom: 3 }), 1, 'op_b');
    expect(stale.ok).toBe(false);
  });

  it('a mode switch changes the mode and leaves the session alone', async () => {
    const driver = driverOf([openTab()]);
    await setTerminalTab(driver, 'terminalTab_1', { mode: 'calm' }, 'op_a');
    const after = (await driver.list())[0];
    expect(after?.mode).toBe('calm');
    expect(after?.terminalSessionId).toBe('terminal_019fd383-3207-7333-ae57-a3f7f3d5cfb6');
  });
});

describe('closing a tab is a Shell fact, never a Runtime one (FZ-VIEW-033)', () => {
  it('marks the tab closed and keeps the record', async () => {
    const driver = driverOf([openTab()]);
    const res = await closeTerminalTab(driver, 'terminalTab_1', 'op_close');
    expect(res.ok).toBe(true);
    const rows = await driver.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('closed');
  });

  it('keeps the terminalSessionId on a closed tab — the session outlives the tab', async () => {
    // Red gate 1: a window closing is a DETACH. The Shell forgetting which
    // session it was attached to is how "close the tab" becomes "lose the
    // agent" in the user's head, even when the process is fine.
    const driver = driverOf([openTab()]);
    await closeTerminalTab(driver, 'terminalTab_1', 'op_close');
    expect((await driver.list())[0]?.terminalSessionId)
      .toBe('terminal_019fd383-3207-7333-ae57-a3f7f3d5cfb6');
  });

  it('closing an unknown tab is a refusal, not a silent success', async () => {
    const driver = driverOf();
    const res = await closeTerminalTab(driver, 'terminalTab_missing', 'op_close');
    expect(res.ok).toBe(false);
  });
});

describe('reload restores exactly the tabs that were open', () => {
  it('lists open tabs and omits closed ones', async () => {
    const driver = driverOf([
      openTab({ id: 'terminalTab_1' }),
      openTab({ id: 'terminalTab_2', state: 'closed' }),
      openTab({ id: 'terminalTab_3', mode: 'calm' }),
    ]);
    expect((await listOpenTerminalTabs(driver)).map((t) => t.id))
      .toEqual(['terminalTab_1', 'terminalTab_3']);
  });

  it('a record the schema cannot parse is DROPPED from the restore, not thrown', async () => {
    // Deferred-structure law: one bad row must not cost Chris every tab he had
    // open. It is skipped and the rest come back.
    const driver = driverOf([openTab()]);
    const rows = await driver.list();
    (rows as TerminalTabRecord[]).push({ kind: 'terminalTab', id: 'bad' } as TerminalTabRecord);
    const bad: TerminalTabDriver = { ...driver, list: async () => rows };
    expect((await listOpenTerminalTabs(bad)).map((t) => t.id)).toEqual(['terminalTab_1']);
  });
});
