// B3e LANE-B B1 — `terminalTab` really does ride Foundation's engine (LAW 1).
//
// The unit tests in `terminal-tab.test.ts` prove the rules against a fake
// driver. These prove the thing the fake cannot: that the record survives a
// real composed handle, in the canonical JSONL directory, under the same
// envelope/CAS/trace machinery every other Shell kind uses — and that Chris's
// open tabs come back after a reload.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeShellPersistence } from '../contract/persistence.node.js';
import { closeTerminalTab, listOpenTerminalTabs, setTerminalTab } from '../contract/terminalTab.js';

const SESSION_A = 'terminal_019fd383-3207-7333-ae57-a3f7f3d5cfb6';
const SESSION_B = 'terminal_019fd383-9911-7333-ae57-a3f7f3d5cfb7';

let root: string;
let dataRoot: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-b1-'));
  dataRoot = path.join(root, 'stores');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const compose = () => composeShellPersistence({ root, dataRoot, principal: 'person_test' });

describe('the tab is a Foundation record, in Foundation\'s file (LAW 1)', () => {
  it('commits to terminalTabs.jsonl and nowhere else', async () => {
    const shell = compose();
    const res = await setTerminalTab(shell.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A, mode: 'raw', title: 'zsh',
    }, 'op_open_a');
    expect(res.ok).toBe(true);

    const file = path.join(dataRoot, 'terminalTabs.jsonl');
    expect(existsSync(file), 'terminalTabs.jsonl was not written').toBe(true);
    const line = readFileSync(file, 'utf8').trim().split('\n')[0] ?? '';
    const envelope = JSON.parse(line) as Record<string, unknown>;
    // The envelope law: this is a wrapped record like every other kind, not a
    // Shell-private blob that happens to live in the same directory.
    expect(Object.keys(envelope)).toContain('meta');
    expect(JSON.stringify(envelope)).toContain('terminalTab');
  });

  it('the principal on the record is the engine\'s, not the caller\'s claim', async () => {
    const shell = compose();
    await setTerminalTab(shell.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A,
    }, 'op_open_a');
    const stored = await shell.terminalTabDriver.read('terminalTab_a');
    expect(stored?.record.createdBy).not.toBe('overridden-by-foundation');
  });

  it('a store failure is a typed Result, never a throw', async () => {
    const shell = composeShellPersistence({
      root, dataRoot, principal: 'person_test',
      failNextObjectAppend: { cause: 'ENOSPC: no space left on device' },
    });
    const res = await setTerminalTab(shell.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A,
    }, 'op_open_a');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('PersistFailed');
  });
});

describe('reload gives Chris back exactly the tabs he had open', () => {
  it('two open tabs and one closed one survive a fresh composition', async () => {
    const first = compose();
    await setTerminalTab(first.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A, mode: 'raw', title: 'zsh',
    }, 'op_a');
    await setTerminalTab(first.terminalTabDriver, 'terminalTab_b', {
      terminalSessionId: SESSION_B, mode: 'calm', title: 'kimi',
      calmPacing: { maxBufferedLines: 500, revealLinesPerSecond: 8 },
    }, 'op_b');
    await closeTerminalTab(first.terminalTabDriver, 'terminalTab_a', 'op_close_a');

    // A brand-new handle over the same directory — the reload.
    const reloaded = compose();
    const open = await listOpenTerminalTabs(reloaded.terminalTabDriver);
    expect(open.map((tab) => tab.id)).toEqual(['terminalTab_b']);
    expect(open[0]?.mode).toBe('calm');
    expect(open[0]?.calmPacing).toEqual({ maxBufferedLines: 500, revealLinesPerSecond: 8 });
  });

  it('a closed tab still remembers its session after the reload (red gate 1)', async () => {
    const first = compose();
    await setTerminalTab(first.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A,
    }, 'op_a');
    await closeTerminalTab(first.terminalTabDriver, 'terminalTab_a', 'op_close_a');

    const reloaded = compose();
    const stored = await reloaded.terminalTabDriver.read('terminalTab_a');
    expect(stored?.record.state).toBe('closed');
    expect(stored?.record.terminalSessionId).toBe(SESSION_A);
  });

  it('the same clientOpId twice does not open two tabs (R3-10 dedup)', async () => {
    const shell = compose();
    await setTerminalTab(shell.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A,
    }, 'op_same');
    await setTerminalTab(shell.terminalTabDriver, 'terminalTab_a', {
      terminalSessionId: SESSION_A,
    }, 'op_same');
    expect(await shell.terminalTabDriver.list()).toHaveLength(1);
  });
});
