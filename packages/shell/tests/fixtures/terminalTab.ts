// One builder for terminal-tab fixtures, shared by the deterministic suite and
// by tools/tabstrip-preview.tsx.
//
// Shared on purpose: the strip a human looks at in a browser and the strip the
// tests assert on must be built from the same thing, or the screenshots stop
// being evidence about the code the tests are guarding.
import type { TerminalTabRecord } from '../../contract/terminalTab.js';
import type { TerminalTabView } from '../../contract/terminalServices.js';

export const SESSION_A = 'terminal_00000000-0000-7000-8000-00000000000a';
export const SESSION_B = 'terminal_00000000-0000-7000-8000-00000000000b';
export const SESSION_C = 'terminal_00000000-0000-7000-8000-00000000000c';

export const tabRecord = (overrides: Partial<TerminalTabRecord> = {}): TerminalTabRecord => ({
  kind: 'terminalTab',
  id: 'tab-a',
  schemaVersion: 1,
  createdAt: '2026-08-06T00:00:00.000Z',
  permissionLevel: 'private',
  createdBy: 'shell',
  terminalSessionId: SESSION_A,
  mode: 'raw',
  title: '',
  zoom: 1,
  calmPacing: { maxBufferedLines: 2_000, revealLinesPerSecond: 24 },
  state: 'open',
  ...overrides,
});

export const sessionView = (overrides: Partial<TerminalTabView> = {}): TerminalTabView => ({
  terminalSessionId: SESSION_A,
  status: 'live',
  owner: { kind: 'plain-shell', label: 'novakai-shell' },
  workingDirectory: '/tmp',
  attachedControllerCount: 1,
  holdsInputLease: true,
  replay: { earliestSequence: 0, latestSequence: 12 },
  nextInputSequence: 1,
  ...overrides,
});
